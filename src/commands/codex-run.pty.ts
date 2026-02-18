import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ProcessSupervisor, RunExit } from "../process/supervisor/types.js";
import { sanitizeBinaryOutput } from "../agents/shell-utils.js";
import { stripAnsi } from "../terminal/ansi.js";

export type CodexRunAutoAnswerMode = "off" | "safe" | "balanced" | "yolo";

export type PromptMatch = {
  kind: "press-enter" | "confirm" | "choice";
  text: string;
  safeAutoResponse?: string;
};

export type PromptEvent = {
  kind: PromptMatch["kind"];
  text: string;
  source: "auto" | "manual";
  response: string;
  atMs: number;
};

export type PromptResponder = (prompt: PromptMatch) => Promise<string>;

export type PtyCodexRunInput = {
  command: string;
  cwd: string;
  timeoutMs: number;
  autoAnswer: CodexRunAutoAnswerMode;
  logFilePath: string;
  onOutput?: (chunk: string) => void;
  promptResponder?: PromptResponder;
  supervisor?: ProcessSupervisor;
};

export type PtyCodexRunResult = {
  runId: string;
  pid?: number;
  exit: RunExit;
  promptEvents: PromptEvent[];
  transcript: string;
  pollSamples: number;
  logFilePath: string;
};

const MAX_TRANSCRIPT_CHARS = 600_000;
const MAX_DETECTION_TAIL = 5_000;
const HIGH_RISK_CONFIRM_PATTERN =
  /\b(rm\b|rm -rf|delete|drop\b|destroy|erase|wipe|truncate|reset\b|revert\b|force\b|overwrite|production|prod\b|database|db\b|schema|migration|credential|secret|token|key|sudo|root|git reset --hard|git push --force)\b/i;

function normalizeForPromptDetection(input: string): string {
  return stripAnsi(input).replace(/\r/g, "\n");
}

function normalizePromptSignature(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function detectInteractivePrompt(rawTail: string): PromptMatch | null {
  const normalized = normalizeForPromptDetection(rawTail);
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recent = lines.slice(-4);
  if (recent.length === 0) {
    return null;
  }
  const tail = recent.join(" ");

  if (/press\s+(enter|return)\s+to\s+continue\b/i.test(tail)) {
    return {
      kind: "press-enter",
      text: recent[recent.length - 1] ?? tail,
      safeAutoResponse: "",
    };
  }

  if (
    /(proceed|continue|approve|confirm|are you sure|allow|execute)[^.\n]{0,120}(\(.*y\/n.*\)|\[.*y\/n.*\])/i.test(
      tail,
    ) ||
    /(proceed|continue|approve|confirm|are you sure|allow|execute)\s*[?:]?\s*$/i.test(tail)
  ) {
    return {
      kind: "confirm",
      text: recent[recent.length - 1] ?? tail,
    };
  }

  if (/(enter choice|select( an?)? option|choose( an?)? option|choice\s*[:>])\s*$/i.test(tail)) {
    return {
      kind: "choice",
      text: recent[recent.length - 1] ?? tail,
    };
  }

  return null;
}

function resolveAutoResponse(mode: CodexRunAutoAnswerMode, prompt: PromptMatch): string | null {
  if (mode === "off") {
    return null;
  }
  if (mode === "safe") {
    return prompt.kind === "press-enter" ? (prompt.safeAutoResponse ?? "") : null;
  }
  if (mode === "balanced") {
    if (prompt.kind === "press-enter") {
      return prompt.safeAutoResponse ?? "";
    }
    if (prompt.kind === "confirm") {
      return HIGH_RISK_CONFIRM_PATTERN.test(prompt.text) ? null : "y";
    }
    return null;
  }
  if (prompt.kind === "press-enter") {
    return prompt.safeAutoResponse ?? "";
  }
  if (prompt.kind === "confirm") {
    return "y";
  }
  if (prompt.kind === "choice") {
    return "1";
  }
  return null;
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}

export async function runPtyCodexSession(input: PtyCodexRunInput): Promise<PtyCodexRunResult> {
  const supervisor = input.supervisor ?? getProcessSupervisor();
  await mkdir(path.dirname(input.logFilePath), { recursive: true });
  const stream = createWriteStream(input.logFilePath, { flags: "a" });

  let transcript = "";
  let detectTail = "";
  let pollSamples = 0;
  let suppressedOutput = "";
  let suppressUserOutput = false;
  let promptHandling: Promise<void> | null = null;
  let promptError: Error | null = null;
  let cancelRun: (() => void) | null = null;
  let runStdin: { write: (data: string, cb?: (err?: Error | null) => void) => void } | undefined;
  let lastPromptSignature = "";
  let lastPromptAtMs = 0;
  const promptEvents: PromptEvent[] = [];

  const flushSuppressedOutput = () => {
    if (!suppressedOutput) {
      return;
    }
    input.onOutput?.(suppressedOutput);
    suppressedOutput = "";
  };

  const maybeHandlePrompt = () => {
    if (promptHandling || promptError || !runStdin) {
      return;
    }
    const prompt = detectInteractivePrompt(detectTail);
    if (!prompt) {
      return;
    }
    const signature = `${prompt.kind}:${normalizePromptSignature(prompt.text)}`;
    const now = Date.now();
    if (signature === lastPromptSignature && now - lastPromptAtMs < 2_000) {
      return;
    }
    lastPromptSignature = signature;
    lastPromptAtMs = now;

    promptHandling = (async () => {
      const autoResponse = resolveAutoResponse(input.autoAnswer, prompt);
      if (autoResponse !== null) {
        const response = autoResponse;
        runStdin?.write(ensureTrailingNewline(response));
        // Reset detection tail so the same prompt text does not trigger duplicate replies.
        detectTail = "";
        promptEvents.push({
          kind: prompt.kind,
          text: prompt.text,
          source: "auto",
          response,
          atMs: Date.now(),
        });
        return;
      }

      if (!input.promptResponder) {
        throw new Error(
          `Codex requested interactive input ("${prompt.text}") but no prompt responder is available.`,
        );
      }

      suppressUserOutput = true;
      try {
        const response = await input.promptResponder(prompt);
        runStdin?.write(ensureTrailingNewline(response));
        // Reset detection tail so echoed input does not retrigger the same prompt.
        detectTail = "";
        promptEvents.push({
          kind: prompt.kind,
          text: prompt.text,
          source: "manual",
          response,
          atMs: Date.now(),
        });
      } finally {
        suppressUserOutput = false;
        flushSuppressedOutput();
      }
    })()
      .catch((err) => {
        promptError = err instanceof Error ? err : new Error(String(err));
        cancelRun?.();
      })
      .finally(() => {
        promptHandling = null;
      });
  };

  const onChunk = (rawChunk: string) => {
    const chunk = sanitizeBinaryOutput(rawChunk);
    if (!chunk) {
      return;
    }
    stream.write(chunk);
    transcript = `${transcript}${chunk}`.slice(-MAX_TRANSCRIPT_CHARS);
    detectTail = `${detectTail}${normalizeForPromptDetection(chunk)}`.slice(-MAX_DETECTION_TAIL);
    if (suppressUserOutput) {
      suppressedOutput += chunk;
    } else {
      input.onOutput?.(chunk);
    }
    maybeHandlePrompt();
  };

  const managedRun = await supervisor.spawn({
    sessionId: `codex-run:${Date.now()}`,
    backendId: "codex-run",
    scopeKey: `codex-run:${path.resolve(input.cwd)}`,
    mode: "pty",
    ptyCommand: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    captureOutput: false,
    onStdout: onChunk,
    onStderr: onChunk,
  });
  runStdin = managedRun.stdin;
  cancelRun = () => {
    managedRun.cancel("manual-cancel");
  };

  const poll = setInterval(() => {
    void supervisor.getRecord(managedRun.runId);
    pollSamples += 1;
  }, 500);

  try {
    const exit = await managedRun.wait();
    if (promptHandling) {
      await promptHandling;
    }
    if (promptError) {
      throw promptError;
    }
    return {
      runId: managedRun.runId,
      pid: managedRun.pid,
      exit,
      promptEvents,
      transcript,
      pollSamples,
      logFilePath: input.logFilePath,
    };
  } finally {
    clearInterval(poll);
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
}
