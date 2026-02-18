import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPtyCodexSession } from "./codex-run.pty.js";

function shellQuoteSingleArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildNodeCommand(scriptPath: string): string {
  return [process.execPath, scriptPath].map((arg) => shellQuoteSingleArg(arg)).join(" ");
}

async function writeExecutableScript(dir: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, body, { encoding: "utf8", mode: 0o755 });
  return scriptPath;
}

describe("codex-run PTY smoke", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("completes happy path without prompts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-happy-"));
    tempDirs.push(tempDir);
    const scriptPath = await writeExecutableScript(
      tempDir,
      "happy.js",
      [
        `process.stdout.write("booting\\n");`,
        `setTimeout(() => {`,
        `  process.stdout.write("all done\\n");`,
        `  process.exit(0);`,
        `}, 25);`,
      ].join("\n"),
    );

    const out: string[] = [];
    const logPath = path.join(tempDir, "run.log");
    const result = await runPtyCodexSession({
      command: buildNodeCommand(scriptPath),
      cwd: tempDir,
      timeoutMs: 10_000,
      autoAnswer: "off",
      logFilePath: logPath,
      onOutput: (chunk) => out.push(chunk),
    });

    const logText = await readFile(logPath, "utf8");
    expect(result.exit.reason).toBe("exit");
    expect(result.exit.exitCode).toBe(0);
    expect(result.promptEvents).toHaveLength(0);
    expect(result.transcript).toContain("all done");
    expect(out.join("")).toContain("booting");
    expect(logText).toContain("all done");
  });

  it("bridges an interactive prompt via manual responder", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-prompt-"));
    tempDirs.push(tempDir);
    const scriptPath = await writeExecutableScript(
      tempDir,
      "prompt.js",
      [
        `process.stdout.write("Proceed? (y/N) ");`,
        `process.stdin.setEncoding("utf8");`,
        `let seen = "";`,
        `process.stdin.on("data", (chunk) => {`,
        `  seen += chunk;`,
        `  if (!seen.includes("\\n")) return;`,
        `  const answer = seen.trim().toLowerCase();`,
        `  if (answer === "y") {`,
        `    process.stdout.write("approved\\n");`,
        `    process.exit(0);`,
        `    return;`,
        `  }`,
        `  process.stderr.write("declined\\n");`,
        `  process.exit(2);`,
        `});`,
      ].join("\n"),
    );

    const logPath = path.join(tempDir, "run.log");
    const result = await runPtyCodexSession({
      command: buildNodeCommand(scriptPath),
      cwd: tempDir,
      timeoutMs: 10_000,
      autoAnswer: "off",
      logFilePath: logPath,
      promptResponder: async () => "y",
    });

    const logText = await readFile(logPath, "utf8");
    expect(result.exit.reason).toBe("exit");
    expect(result.exit.exitCode).toBe(0);
    expect(result.promptEvents).toHaveLength(1);
    expect(result.promptEvents[0]?.source).toBe("manual");
    expect(result.promptEvents[0]?.response).toBe("y");
    expect(result.transcript).toContain("approved");
    expect(logText).toContain("Proceed? (y/N)");
  });

  it("auto-answers confirmation prompts in yolo mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-yolo-"));
    tempDirs.push(tempDir);
    const scriptPath = await writeExecutableScript(
      tempDir,
      "yolo.js",
      [
        `process.stdout.write("Continue? (y/N) ");`,
        `process.stdin.setEncoding("utf8");`,
        `let seen = "";`,
        `process.stdin.on("data", (chunk) => {`,
        `  seen += chunk;`,
        `  if (!seen.includes("\\n")) return;`,
        `  const answer = seen.trim().toLowerCase();`,
        `  if (answer === "y") {`,
        `    process.stdout.write("yolo-approved\\n");`,
        `    process.exit(0);`,
        `    return;`,
        `  }`,
        `  process.stderr.write("expected-y\\n");`,
        `  process.exit(2);`,
        `});`,
      ].join("\n"),
    );

    const result = await runPtyCodexSession({
      command: buildNodeCommand(scriptPath),
      cwd: tempDir,
      timeoutMs: 10_000,
      autoAnswer: "yolo",
      logFilePath: path.join(tempDir, "run.log"),
    });

    expect(result.exit.reason).toBe("exit");
    expect(result.exit.exitCode).toBe(0);
    expect(result.promptEvents).toHaveLength(1);
    expect(result.promptEvents[0]?.source).toBe("auto");
    expect(result.promptEvents[0]?.response).toBe("y");
    expect(result.transcript).toContain("yolo-approved");
  });

  it("keeps risky confirmations manual in balanced mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-balanced-"));
    tempDirs.push(tempDir);
    const scriptPath = await writeExecutableScript(
      tempDir,
      "balanced.js",
      [
        `process.stdout.write("Are you sure you want to delete production DB? (y/N) ");`,
        `process.stdin.setEncoding("utf8");`,
        `let seen = "";`,
        `process.stdin.on("data", (chunk) => {`,
        `  seen += chunk;`,
        `  if (!seen.includes("\\n")) return;`,
        `  const answer = seen.trim().toLowerCase();`,
        `  if (answer === "y") {`,
        `    process.stdout.write("unexpected-auto-yes\\n");`,
        `    process.exit(0);`,
        `    return;`,
        `  }`,
        `  process.stdout.write("manual-block\\n");`,
        `  process.exit(2);`,
        `});`,
      ].join("\n"),
    );

    const result = await runPtyCodexSession({
      command: buildNodeCommand(scriptPath),
      cwd: tempDir,
      timeoutMs: 10_000,
      autoAnswer: "balanced",
      logFilePath: path.join(tempDir, "run.log"),
      promptResponder: async () => "n",
    });

    expect(result.exit.reason).toBe("exit");
    expect(result.exit.exitCode).toBe(2);
    expect(result.promptEvents).toHaveLength(1);
    expect(result.promptEvents[0]?.source).toBe("manual");
    expect(result.promptEvents[0]?.response).toBe("n");
    expect(result.transcript).toContain("manual-block");
  });
});
