import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { getShellConfig } from "../agents/shell-utils.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type CodexRunAutoAnswerMode,
  type PromptMatch,
  runPtyCodexSession,
} from "./codex-run.pty.js";

export type CodexRunCommandInput = {
  repo: string;
  task: string;
  verifyCmds: string[];
  autoAnswer: CodexRunAutoAnswerMode;
  timeoutSec: number;
  codexArgs: string[];
  branch?: string;
};

type VerifyResult = {
  command: string;
  code: number | null;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  ok: boolean;
  stdoutTail: string;
  stderrTail: string;
};

type KeyDecision = {
  decision: string;
  rationale: string;
  alternatives: string;
};

type BranchSelection = {
  branch: string;
  created: boolean;
  initialBranch: string | null;
};

const BASE_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop", "dev"]);

const REQUIRED_SUMMARY_TEMPLATE = `SESSION SUMMARY
- Goal:
- Repo:
- What changed:
  - <file>: <one-line>
  - ...
- Commands run:
  - ...
- Key decisions:
  - Decision: ...
    Rationale: ...
    Alternatives cdered: ...
- Verification:
  - ...
- Risks / notes:
  - ...
- Git status:
  - (paste \`git status --porcelain\` output)
- Git diff stat:
  - (paste \`git diff --stat\` output)`;

const SUMMARY_ENFORCEMENT_APPENDIX = [
  "IMPORTANT:",
  "You MUST end your final response by printing exactly this structure and labels:",
  REQUIRED_SUMMARY_TEMPLATE,
  "Do not rename headers or bullets.",
].join("\n");

function shellQuoteSingleArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(argv: string[]): string {
  return argv.map((arg) => shellQuoteSingleArg(arg)).join(" ");
}

function appendSummaryInstruction(task: string): string {
  const trimmed = task.trim();
  return `${trimmed}\n\n${SUMMARY_ENFORCEMENT_APPENDIX}`;
}

function extractPrimaryBin(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const token = trimmed.split(/\s+/)[0]?.trim();
  return token && token.length > 0 ? token : null;
}

function trimOutputTail(value: string, maxChars = 2_000): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(-maxChars);
}

function parseGitPorcelain(statusOutput: string): Array<{ file: string; summary: string }> {
  const lines = statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const parsed: Array<{ file: string; summary: string }> = [];

  for (const line of lines) {
    if (line.startsWith("?? ")) {
      parsed.push({
        file: line.slice(3).trim(),
        summary: "untracked file added",
      });
      continue;
    }
    if (line.length < 4) {
      continue;
    }
    const rawStatus = line.slice(0, 2);
    const payload = line.slice(3).trim();
    const file = payload.includes(" -> ") ? payload.split(" -> ").at(-1)?.trim() ?? payload : payload;
    const code = rawStatus.replace(/\s+/g, "")[0] ?? rawStatus[1] ?? "";
    const summary =
      code === "M"
        ? "modified"
        : code === "A"
          ? "added"
          : code === "D"
            ? "deleted"
            : code === "R"
              ? "renamed"
              : code === "C"
                ? "copied"
                : code === "U"
                  ? "merge conflict"
                  : "updated";
    parsed.push({ file, summary });
  }
  return parsed;
}

function autoAnswerDecisionRationale(mode: CodexRunAutoAnswerMode): string {
  if (mode === "safe") {
    return "Only trivial prompts (Press Enter) are auto-resolved; confirmations still require explicit input.";
  }
  if (mode === "balanced") {
    return "Auto-resolves Enter prompts and low-risk confirmations; high-risk confirmations still require explicit input.";
  }
  if (mode === "yolo") {
    return "Auto-approves confirm prompts (`y`) and picks default choice `1`; this can approve destructive actions.";
  }
  return "No implicit approvals; every detected prompt requires explicit input.";
}

function toSlug(input: string, max = 28): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "task";
}

function timestampForBranch(now = new Date()): string {
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function buildSuggestedBranchName(task: string): string {
  return `codex/${timestampForBranch()}-${toSlug(task)}`;
}

function buildCommitMessage(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  const base = compact.length > 0 ? compact : "codex-run update";
  const clipped = base.length > 56 ? `${base.slice(0, 56).trimEnd()}...` : base;
  return `chore(codex-run): ${clipped}`;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function askUserInput(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function askYesNo(message: string, defaultYes: boolean): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    return defaultYes;
  }
  const answer = (await askUserInput(`${message} ${defaultYes ? "[Y/n]" : "[y/N]"}: `))
    .trim()
    .toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  return answer === "y" || answer === "yes";
}

async function askUserForPromptResponse(prompt: PromptMatch): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error(
      `Codex requested input (${prompt.text}) but this terminal is non-interactive. Re-run in a TTY or use --auto-answer safe|balanced|yolo.`,
    );
  }
  return await askUserInput(`\n[openclaw codex-run] Prompt detected: ${prompt.text}\nResponse: `);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGitCommand(repoPath: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await runExec("git", ["-C", repoPath, ...args], {
    timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function runGitNoOutput(repoPath: string, args: string[], timeoutMs: number): Promise<void> {
  await runExec("git", ["-C", repoPath, ...args], {
    timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function ensureGitRepo(repoPath: string, timeoutMs: number): Promise<{ initialized: boolean }> {
  try {
    await runExec("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
      timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { initialized: false };
  } catch {
    await runExec("git", ["-C", repoPath, "init"], { timeoutMs, maxBuffer: 1024 * 1024 });
    return { initialized: true };
  }
}

async function getCurrentBranch(repoPath: string, timeoutMs: number): Promise<string | null> {
  try {
    const branch = (await runGitCommand(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs)).trim();
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

async function listGitRemotes(repoPath: string, timeoutMs: number): Promise<string[]> {
  const output = await runGitCommand(repoPath, ["remote"], timeoutMs).catch(() => "");
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function hasUpstreamBranch(repoPath: string, timeoutMs: number): Promise<boolean> {
  try {
    await runGitNoOutput(
      repoPath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureCleanWorkingTree(repoPath: string, timeoutMs: number): Promise<void> {
  const status = await runGitCommand(repoPath, ["status", "--porcelain"], timeoutMs);
  if (!status.trim()) {
    return;
  }
  throw new Error(
    `Repository must be clean before codex-run. Commit/stash changes first.\nCurrent status:\n${status}`,
  );
}

async function pullLatestIfPossible(params: {
  repoPath: string;
  timeoutMs: number;
  commandsRun: string[];
  verificationLines: string[];
  risks: string[];
}): Promise<boolean> {
  const remotes = await listGitRemotes(params.repoPath, params.timeoutMs);
  if (remotes.length === 0) {
    params.verificationLines.push("Git pull skipped: no remotes configured.");
    return false;
  }

  await runGitNoOutput(params.repoPath, ["fetch", "--all", "--prune"], params.timeoutMs);
  params.commandsRun.push(`git -C ${params.repoPath} fetch --all --prune`);

  const upstream = await hasUpstreamBranch(params.repoPath, params.timeoutMs);
  if (!upstream) {
    params.risks.push("Git pull skipped: current branch has no upstream tracking branch.");
    return false;
  }

  await runGitNoOutput(params.repoPath, ["pull", "--ff-only"], params.timeoutMs);
  params.commandsRun.push(`git -C ${params.repoPath} pull --ff-only`);
  params.verificationLines.push("Repository synchronized via git pull --ff-only.");
  return true;
}

async function validateBranchName(branch: string, timeoutMs: number): Promise<void> {
  await runExec("git", ["check-ref-format", "--branch", branch], {
    timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

async function localBranchExists(repoPath: string, branch: string, timeoutMs: number): Promise<boolean> {
  try {
    await runGitNoOutput(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniqueBranchName(
  repoPath: string,
  baseName: string,
  timeoutMs: number,
): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? baseName : `${baseName}-${i + 1}`;
    if (!(await localBranchExists(repoPath, candidate, timeoutMs))) {
      return candidate;
    }
  }
  throw new Error(`Unable to allocate unique branch name from base: ${baseName}`);
}

function isLikelyWorkingBranch(branch: string): boolean {
  return !BASE_BRANCH_NAMES.has(branch.toLowerCase());
}

async function resolveWorkingBranch(params: {
  repoPath: string;
  requestedBranch?: string;
  task: string;
  timeoutMs: number;
  commandsRun: string[];
  runtime: Pick<RuntimeEnv, "log">;
}): Promise<BranchSelection> {
  const initialBranch = await getCurrentBranch(params.repoPath, params.timeoutMs);
  const requested = params.requestedBranch?.trim() ?? "";

  if (requested) {
    await validateBranchName(requested, params.timeoutMs);
    if (await localBranchExists(params.repoPath, requested, params.timeoutMs)) {
      if (requested !== initialBranch) {
        await runGitNoOutput(params.repoPath, ["checkout", requested], params.timeoutMs);
        params.commandsRun.push(`git -C ${params.repoPath} checkout ${requested}`);
      }
      return {
        branch: requested,
        created: false,
        initialBranch,
      };
    }

    await runGitNoOutput(params.repoPath, ["checkout", "-b", requested], params.timeoutMs);
    params.commandsRun.push(`git -C ${params.repoPath} checkout -b ${requested}`);
    return {
      branch: requested,
      created: true,
      initialBranch,
    };
  }

  if (initialBranch && isLikelyWorkingBranch(initialBranch)) {
    const useCurrent = await askYesNo(
      `[openclaw codex-run] Use existing branch \"${initialBranch}\" for this run?`,
      true,
    );
    if (useCurrent) {
      return {
        branch: initialBranch,
        created: false,
        initialBranch,
      };
    }
  }

  const baseName = buildSuggestedBranchName(params.task);
  const branchName = await ensureUniqueBranchName(params.repoPath, baseName, params.timeoutMs);
  params.runtime.log(
    `[codex-run] creating branch \"${branchName}\"${initialBranch ? ` from \"${initialBranch}\"` : ""}...`,
  );
  await runGitNoOutput(params.repoPath, ["checkout", "-b", branchName], params.timeoutMs);
  params.commandsRun.push(`git -C ${params.repoPath} checkout -b ${branchName}`);
  return {
    branch: branchName,
    created: true,
    initialBranch,
  };
}

async function inferVerificationCommands(repoPath: string): Promise<string[]> {
  const packageJsonPath = path.join(repoPath, "package.json");
  if (await pathExists(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const rawTest = typeof parsed.scripts?.test === "string" ? parsed.scripts.test.trim() : "";
      const hasMeaningfulTestScript =
        rawTest.length > 0 && !/^echo\s+['\"]?error:\s*no test specified/i.test(rawTest);
      if (hasMeaningfulTestScript) {
        if (await pathExists(path.join(repoPath, "pnpm-lock.yaml"))) {
          return ["pnpm test"];
        }
        if (await pathExists(path.join(repoPath, "yarn.lock"))) {
          return ["yarn test"];
        }
        if ((await pathExists(path.join(repoPath, "bun.lock"))) || (await pathExists(path.join(repoPath, "bun.lockb")))) {
          return ["bun test"];
        }
        return ["npm test"];
      }
    } catch {
      // Ignore malformed package.json and fall through to other language heuristics.
    }
  }

  if ((await pathExists(path.join(repoPath, "pyproject.toml"))) || (await pathExists(path.join(repoPath, "pytest.ini")))) {
    return ["pytest"];
  }

  if (await pathExists(path.join(repoPath, "go.mod"))) {
    return ["go test ./..."];
  }

  if (await pathExists(path.join(repoPath, "Cargo.toml"))) {
    return ["cargo test"];
  }

  if (await pathExists(path.join(repoPath, "Makefile"))) {
    return ["make test"];
  }

  return [];
}

async function resolveVerificationCommands(params: {
  repoPath: string;
  verifyCmds: string[];
  runtime: Pick<RuntimeEnv, "log">;
}): Promise<string[]> {
  const explicit = params.verifyCmds.map((value) => value.trim()).filter((value) => value.length > 0);
  if (explicit.length > 0) {
    return explicit;
  }

  const inferred = await inferVerificationCommands(params.repoPath);
  if (inferred.length > 0) {
    params.runtime.log(`[codex-run] inferred verification command(s): ${inferred.join(", ")}`);
    return inferred;
  }

  if (!isInteractiveTerminal()) {
    throw new Error("No --verify-cmd provided and no verification command could be inferred.");
  }

  const entered = (await askUserInput(
    "[openclaw codex-run] No verification command inferred. Enter one command to run before commit/push: ",
  )).trim();

  if (!entered) {
    throw new Error("Verification command is required. Pass --verify-cmd <command>.");
  }

  return [entered];
}

async function runVerifyCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<VerifyResult> {
  const { shell, args } = getShellConfig();
  const result = await runCommandWithTimeout([shell, ...args, params.command], {
    timeoutMs: params.timeoutMs,
    cwd: params.cwd,
    noOutputTimeoutMs: params.timeoutMs,
  });
  const stdoutTail = trimOutputTail(result.stdout);
  const stderrTail = trimOutputTail(result.stderr);
  const ok = result.code === 0 && result.termination === "exit";
  return {
    command: params.command,
    code: result.code,
    termination: result.termination,
    ok,
    stdoutTail,
    stderrTail,
  };
}

function buildExecutionHint(params: {
  verifyCmds: string[];
  includeCodex: boolean;
  includeGit: boolean;
}): string {
  const bins = new Set<string>();
  if (params.includeCodex) {
    bins.add("codex");
  }
  if (params.includeGit) {
    bins.add("git");
  }
  for (const verify of params.verifyCmds) {
    const token = extractPrimaryBin(verify);
    if (token) {
      bins.add(token);
    }
  }
  if (bins.size === 0) {
    return "";
  }
  const allowlistLines = Array.from(bins).map(
    (bin) => `openclaw approvals allowlist add \"${bin}\"`,
  );
  return [
    "If command execution is blocked by approvals/allowlist policy, add explicit allowlist entries:",
    ...allowlistLines.map((line) => `  - ${line}`),
  ].join("\n");
}

function formatSessionSummary(params: {
  goal: string;
  repoPath: string;
  changed: Array<{ file: string; summary: string }>;
  commandsRun: string[];
  decisions: KeyDecision[];
  verification: string[];
  risks: string[];
  gitStatusPorcelain: string;
  gitDiffStat: string;
}): string {
  const lines: string[] = [];
  lines.push("SESSION SUMMARY");
  lines.push(`- Goal: ${params.goal}`);
  lines.push(`- Repo: ${params.repoPath}`);
  lines.push("- What changed:");
  if (params.changed.length === 0) {
    lines.push("  - (none): no tracked or untracked changes detected");
  } else {
    for (const item of params.changed) {
      lines.push(`  - ${item.file}: ${item.summary}`);
    }
  }
  lines.push("- Commands run:");
  for (const command of params.commandsRun) {
    lines.push(`  - ${command}`);
  }
  lines.push("- Key decisions:");
  for (const decision of params.decisions) {
    lines.push(`  - Decision: ${decision.decision}`);
    lines.push(`    Rationale: ${decision.rationale}`);
    lines.push(`    Alternatives cdered: ${decision.alternatives}`);
  }
  lines.push("- Verification:");
  for (const item of params.verification) {
    lines.push(`  - ${item}`);
  }
  lines.push("- Risks / notes:");
  for (const risk of params.risks) {
    lines.push(`  - ${risk}`);
  }
  lines.push("- Git status:");
  lines.push("  - (paste `git status --porcelain` output)");
  if (params.gitStatusPorcelain.trim()) {
    for (const line of params.gitStatusPorcelain.split("\n")) {
      lines.push(`  - ${line}`);
    }
  } else {
    lines.push("  - (clean)");
  }
  lines.push("- Git diff stat:");
  lines.push("  - (paste `git diff --stat` output)");
  if (params.gitDiffStat.trim()) {
    for (const line of params.gitDiffStat.split("\n")) {
      lines.push(`  - ${line}`);
    }
  } else {
    lines.push("  - (no diff)");
  }
  return lines.join("\n");
}

function withDefaultCodexArgs(codexArgs: string[]): string[] {
  const next = [...codexArgs];
  if (!next.includes("--no-alt-screen")) {
    next.unshift("--no-alt-screen");
  }
  return next;
}

export async function codexRunCommand(
  input: CodexRunCommandInput,
  runtime: Pick<RuntimeEnv, "log" | "error">,
): Promise<{ ok: boolean }> {
  const repoPath = path.resolve(input.repo);
  const repoStats = await stat(repoPath).catch(() => null);
  if (!repoStats || !repoStats.isDirectory()) {
    throw new Error(`--repo must point to an existing directory: ${repoPath}`);
  }

  const timeoutMs = Math.max(1, Math.floor(input.timeoutSec * 1000));
  const commandsRun: string[] = [];
  const decisions: KeyDecision[] = [];
  const verificationLines: string[] = [];
  const risks: string[] = [];
  const logDir = path.join(os.tmpdir(), "openclaw-codex-run");
  const logFilePath = path.join(logDir, `codex-run-${Date.now()}.log`);
  let gitInitialized = false;
  let codexSucceeded = false;
  let codexFailureReason: string | null = null;
  let verifySucceeded = true;
  let finalizeSucceeded = true;
  let selectedBranch = "";
  let branchCreated = false;
  let preFinalizeStatus = "";

  const verifyCmds = await resolveVerificationCommands({
    repoPath,
    verifyCmds: input.verifyCmds,
    runtime,
  });

  const gitState = await ensureGitRepo(repoPath, timeoutMs);
  if (gitState.initialized) {
    gitInitialized = true;
    commandsRun.push(`git -C ${repoPath} init`);
    verificationLines.push("Initialized git repository because target path was not already a git repo.");
  } else {
    await ensureCleanWorkingTree(repoPath, timeoutMs);
    commandsRun.push(`git -C ${repoPath} status --porcelain`);
  }

  const initialBranch = await getCurrentBranch(repoPath, timeoutMs);
  if (!gitInitialized) {
    await pullLatestIfPossible({
      repoPath,
      timeoutMs,
      commandsRun,
      verificationLines,
      risks,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to pull latest changes before codex-run: ${message}`);
    });
  }

  const branchSelection = await resolveWorkingBranch({
    repoPath,
    requestedBranch: input.branch,
    task: input.task,
    timeoutMs,
    commandsRun,
    runtime,
  });
  selectedBranch = branchSelection.branch;
  branchCreated = branchSelection.created;

  if (!gitInitialized && !branchCreated && selectedBranch !== initialBranch) {
    await pullLatestIfPossible({
      repoPath,
      timeoutMs,
      commandsRun,
      verificationLines,
      risks,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to pull latest changes on branch ${selectedBranch}: ${message}`);
    });
  }

  const codexTask = appendSummaryInstruction(input.task);
  const codexArgs = withDefaultCodexArgs(input.codexArgs);
  const codexArgv = ["codex", ...codexArgs, codexTask];
  const codexCommand = buildShellCommand(codexArgv);
  commandsRun.push(`codex ${codexArgs.join(" ")} \"<task + required summary instruction>\"`);

  runtime.log(`[codex-run] repo: ${repoPath}`);
  runtime.log(`[codex-run] branch: ${selectedBranch || "(detached)"}`);
  runtime.log(`[codex-run] log file: ${logFilePath}`);
  runtime.log("[codex-run] starting Codex session...");

  try {
    const result = await runPtyCodexSession({
      command: codexCommand,
      cwd: repoPath,
      timeoutMs,
      autoAnswer: input.autoAnswer,
      logFilePath,
      onOutput: (chunk) => {
        process.stdout.write(chunk);
      },
      promptResponder: (prompt) => askUserForPromptResponse(prompt),
    });
    codexSucceeded = result.exit.reason === "exit" && result.exit.exitCode === 0;
    if (result.promptEvents.length > 0) {
      verificationLines.push(`Prompt bridge handled ${result.promptEvents.length} interactive prompt(s).`);
    }
    if (result.pollSamples > 0) {
      verificationLines.push(`Process monitor polled run state ${result.pollSamples} times.`);
    }
    if (!codexSucceeded) {
      codexFailureReason = `Codex exited with code ${String(result.exit.exitCode)} (${result.exit.reason}).`;
    }
  } catch (err) {
    codexFailureReason = err instanceof Error ? err.message : String(err);
    const hint = buildExecutionHint({
      verifyCmds,
      includeCodex: true,
      includeGit: true,
    });
    if (hint) {
      risks.push(hint);
    }
  }

  for (const verifyCommand of verifyCmds) {
    commandsRun.push(verifyCommand);
    const verify = await runVerifyCommand({
      command: verifyCommand,
      cwd: repoPath,
      timeoutMs,
    }).catch((err): VerifyResult => {
      const message = err instanceof Error ? err.message : String(err);
      return {
        command: verifyCommand,
        code: null,
        termination: "signal",
        ok: false,
        stdoutTail: "",
        stderrTail: message,
      };
    });
    verifySucceeded = verifySucceeded && verify.ok;
    verificationLines.push(
      `${verify.command}: ${verify.ok ? "pass" : "fail"} (code=${String(verify.code)}, termination=${verify.termination})`,
    );
    if (verify.stdoutTail) {
      verificationLines.push(`stdout tail (${verify.command}): ${verify.stdoutTail}`);
    }
    if (verify.stderrTail) {
      verificationLines.push(`stderr tail (${verify.command}): ${verify.stderrTail}`);
    }
  }

  preFinalizeStatus = await runGitCommand(repoPath, ["status", "--porcelain"], timeoutMs).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    risks.push(`Failed to collect pre-finalize git status: ${message}`);
    return "";
  });
  commandsRun.push(`git -C ${repoPath} status --porcelain`);

  if (codexSucceeded && verifySucceeded) {
    if (preFinalizeStatus.trim()) {
      try {
        await runGitNoOutput(repoPath, ["add", "-A"], timeoutMs);
        commandsRun.push(`git -C ${repoPath} add -A`);

        const commitMessage = buildCommitMessage(input.task);
        await runGitNoOutput(repoPath, ["commit", "-m", commitMessage], timeoutMs);
        commandsRun.push(`git -C ${repoPath} commit -m ${shellQuoteSingleArg(commitMessage)}`);
        verificationLines.push(`Created commit with message: ${commitMessage}`);

        const remotes = await listGitRemotes(repoPath, timeoutMs);
        const pushRemote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;

        if (!pushRemote) {
          finalizeSucceeded = false;
          risks.push("Cannot push: repository has no remotes configured.");
        } else if (await hasUpstreamBranch(repoPath, timeoutMs)) {
          await runGitNoOutput(repoPath, ["push"], timeoutMs);
          commandsRun.push(`git -C ${repoPath} push`);
          verificationLines.push(`Pushed latest commit to existing upstream on branch \"${selectedBranch}\".`);
        } else {
          await runGitNoOutput(repoPath, ["push", "--set-upstream", pushRemote, selectedBranch], timeoutMs);
          commandsRun.push(`git -C ${repoPath} push --set-upstream ${pushRemote} ${selectedBranch}`);
          verificationLines.push(
            `Pushed branch \"${selectedBranch}\" and configured upstream (${pushRemote}/${selectedBranch}).`,
          );
        }
      } catch (err) {
        finalizeSucceeded = false;
        const message = err instanceof Error ? err.message : String(err);
        risks.push(`Commit/push failed: ${message}`);
      }
    } else {
      verificationLines.push("No file changes detected after Codex run; commit/push skipped.");
    }
  } else {
    finalizeSucceeded = false;
    verificationLines.push("Commit/push skipped because Codex execution or verification failed.");
  }

  const gitStatusPorcelain = await runGitCommand(repoPath, ["status", "--porcelain"], timeoutMs).catch(
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      risks.push(`Failed to collect git status: ${message}`);
      return "";
    },
  );
  commandsRun.push(`git -C ${repoPath} status --porcelain`);

  const gitDiffStat = await runGitCommand(repoPath, ["diff", "--stat"], timeoutMs).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    risks.push(`Failed to collect git diff stat: ${message}`);
    return "";
  });
  commandsRun.push(`git -C ${repoPath} diff --stat`);

  const changed = parseGitPorcelain(preFinalizeStatus || gitStatusPorcelain);
  decisions.push({
    decision: `Runner executed Codex in PTY mode inside repo workdir (${repoPath}).`,
    rationale: "Interactive coding sessions and repo-local command context require a real TTY and explicit cwd.",
    alternatives: "Use existing codex-cli fallback backend (non-interactive, text-only).",
  });
  decisions.push({
    decision: `Repo preflight requires a clean working tree and runs git pull --ff-only when upstream is configured.`,
    rationale: "Avoids mixing pre-existing changes and keeps Codex work based on latest remote state.",
    alternatives: "Run without pull/clean checks (higher merge/regression risk).",
  });
  decisions.push({
    decision: `Working branch selected: ${selectedBranch}${branchCreated ? " (created by runner)" : ""}.`,
    rationale: "Confirms target branch before edits; if no suitable branch is confirmed, runner creates its own branch.",
    alternatives: "Always edit current branch without explicit confirmation.",
  });
  decisions.push({
    decision: `Auto-answer mode set to \"${input.autoAnswer}\".`,
    rationale: autoAnswerDecisionRationale(input.autoAnswer),
    alternatives: "Always keep prompts manual (slower) or always auto-approve (higher risk).",
  });
  decisions.push({
    decision: `Verification command(s): ${verifyCmds.join(", ")}.`,
    rationale: "Runs end-to-end checks before commit/push so changes are validated.",
    alternatives: "Skip verification or rely on manual testing only.",
  });
  if (gitInitialized) {
    decisions.push({
      decision: "Initialized git repository before running Codex.",
      rationale: "Target directory was not a git repo and downstream status/diff reporting requires git.",
      alternatives: "Abort when --repo is not already a git repository.",
    });
  }

  if (codexFailureReason) {
    risks.push(codexFailureReason);
  }
  if (!verifySucceeded) {
    risks.push("One or more verification commands failed.");
  }
  if (!finalizeSucceeded) {
    risks.push("Finalize stage did not complete fully (commit/push skipped or failed).");
  }
  risks.push(`Full diff not inlined. Inspect with: git -C ${repoPath} diff`);
  risks.push(`Session log file: ${logFilePath}`);

  const summary = formatSessionSummary({
    goal: input.task.trim(),
    repoPath,
    changed,
    commandsRun,
    decisions,
    verification: verificationLines,
    risks,
    gitStatusPorcelain,
    gitDiffStat,
  });

  runtime.log("\n" + summary);

  return { ok: codexSucceeded && verifySucceeded && finalizeSucceeded };
}
