import type { Command } from "commander";
import type { CodexRunAutoAnswerMode } from "../../commands/codex-run.pty.js";
import { codexRunCommand } from "../../commands/codex-run.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";
import { collectOption, parsePositiveIntOrUndefined } from "./helpers.js";

function parseAutoAnswerMode(value: unknown): CodexRunAutoAnswerMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "safe" ||
    normalized === "balanced" ||
    normalized === "yolo"
  ) {
    return normalized;
  }
  return null;
}

export function registerCodexRunCommand(program: Command) {
  program
    .command("codex-run")
    .description("Run Codex CLI as an interactive coding agent inside a local git repo")
    .requiredOption("--repo <path>", "Target local repository path")
    .requiredOption("--task <text>", "Task prompt for Codex")
    .option("--branch <name>", "Use (or create) a specific branch before running Codex")
    .option(
      "--verify-cmd <command>",
      "Verification command to run after Codex completes (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--auto-answer <mode>",
      "Prompt auto-answer mode: off|safe|balanced|yolo",
      "off",
    )
    .option("--timeout <seconds>", "Session timeout in seconds", "1800")
    .option(
      "--codex-args <arg>",
      "Extra arg to pass through to codex (repeat --codex-args for each token)",
      collectOption,
      [],
    )
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw codex-run --repo /path/to/repo --task "Implement feature X"', "Run Codex in PTY mode."],
  [
    'openclaw codex-run --repo . --task "Fix failing tests" --verify-cmd "pnpm test"',
    "Run post-session verification command.",
  ],
  [
    'openclaw codex-run --repo . --task "Refactor Y" --branch feature/refactor-y --auto-answer balanced',
    "Use explicit branch and risk-aware auto-answering.",
  ],
  [
    'openclaw codex-run --repo . --task "High-speed run" --auto-answer yolo',
    "YOLO mode auto-answers confirm prompts.",
  ],
  [
    'openclaw codex-run --repo . --task "Refactor Y" --codex-args --sandbox --codex-args workspace-write',
    "Pass through extra codex args.",
  ],
])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/codex-run", "docs.openclaw.ai/cli/codex-run")}`,
    )
    .action(async (opts) => {
      const autoAnswer = parseAutoAnswerMode(opts.autoAnswer);
      if (!autoAnswer) {
        defaultRuntime.error(
          '--auto-answer must be one of: "off", "safe", "balanced", "yolo"',
        );
        defaultRuntime.exit(1);
        return;
      }
      const timeoutSec = parsePositiveIntOrUndefined(opts.timeout);
      if (!timeoutSec) {
        defaultRuntime.error("--timeout must be a positive integer (seconds)");
        defaultRuntime.exit(1);
        return;
      }

      const verifyCmds = Array.isArray(opts.verifyCmd) ? (opts.verifyCmd as string[]) : [];
      const codexArgs = Array.isArray(opts.codexArgs) ? (opts.codexArgs as string[]) : [];

      const result = await codexRunCommand(
        {
          repo: String(opts.repo ?? ""),
          task: String(opts.task ?? ""),
          branch: opts.branch ? String(opts.branch) : undefined,
          verifyCmds,
          autoAnswer,
          timeoutSec,
          codexArgs,
        },
        defaultRuntime,
      );
      if (!result.ok) {
        defaultRuntime.exit(1);
      }
    });
}
