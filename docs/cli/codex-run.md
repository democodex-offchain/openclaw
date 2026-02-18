---
summary: "Run Codex CLI as an interactive coding agent in a local repository"
read_when:
  - You want OpenClaw to launch Codex CLI in a target repo with PTY interaction
  - You need prompt bridging and a deterministic end-of-session summary
title: "codex-run"
---

# codex-run

Use `openclaw codex-run` to run Codex CLI as an interactive coding agent inside a local repository.

The runner:

- requires a clean repository before execution (or initializes git if missing)
- syncs latest changes with `git fetch` + `git pull --ff-only` where upstream exists
- confirms/chooses a working branch (or creates a runner branch)
- starts Codex in a real PTY with the repo as working directory
- streams output while writing a session log file
- detects common interactive prompts and bridges responses
- supports multiple auto-answer policies (`safe`, `balanced`, `yolo`)
- enforces a deterministic final `SESSION SUMMARY` format
- runs verification commands, then commits and pushes on success

## Usage

```bash
openclaw codex-run --repo /path/to/repo --task "Implement feature X" --verify-cmd "pnpm test"
```

## Options

- `--repo <path>`: target repository directory (absolute or relative path; required)
- `--task <text>`: Codex task prompt (required)
- `--branch <name>`: use existing branch or create it before run
- `--verify-cmd <command>`: verification command to run after Codex completes (repeatable)
- `--auto-answer <mode>`:
  - `off`: no auto answers
  - `safe`: auto-answer only `Press Enter` prompts
  - `balanced`: auto-answer enter + low-risk confirmations, hand risky confirmations back to user
  - `yolo`: auto-answer confirm prompts with `y` (and selects option `1` for choice prompts)
- `--timeout <seconds>`: overall session timeout (default `1800`)
- `--codex-args <arg>`: pass-through arg token for `codex` (repeat per token)

## Examples

```bash
openclaw codex-run \
  --repo /Users/you/code/my-repo \
  --task "Refactor the build pipeline and update tests" \
  --verify-cmd "pnpm test"
```

```bash
openclaw codex-run \
  --repo . \
  --branch feature/fix-flaky-tests \
  --task "Fix flaky integration tests" \
  --verify-cmd "pnpm test" \
  --auto-answer balanced
```

```bash
openclaw codex-run \
  --repo . \
  --task "Fast batch update" \
  --verify-cmd "pnpm test" \
  --auto-answer yolo
```

## Security Notes

- `balanced` mode does not auto-approve high-risk confirmations (delete/reset/force/etc.).
- `yolo` mode auto-approves confirmation prompts and is unsafe for destructive operations.
- In `off`/`safe`/`balanced`, prompts that are not auto-answered are handed back to the user, and your response is forwarded to the live Codex PTY session.
- If command execution is blocked by approval policy, add explicit command allowlist entries with:
  - `openclaw approvals allowlist add "codex"`
  - `openclaw approvals allowlist add "git"`
  - plus your verification command binaries as needed

## Output Contract

`codex-run` always emits a final `SESSION SUMMARY` block with:

- goal and repo
- changed files summary
- commands run
- key decisions
- verification status
- risks/notes
- raw `git status --porcelain` and `git diff --stat`

## Smoke Tests

Run the PTY smoke tests locally:

```bash
pnpm vitest src/commands/codex-run.pty.test.ts
```
