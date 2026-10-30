# Research Brief: Test Command Patterns for Testing Pool Trigger

**Task:** Identify exact command strings/patterns the agent uses when running tests via bash/shell, specifically in context of test-auditor. This decision blocks configuration of the tool execution detector in the context-pager plugin.

**Domain:** dev (OpenCode plugin development)

**Issue:** [seppaleinen/ctx-lifecycle#3](https://github.com/seppaleinen/ctx-lifecycle/issues/3)

**Date:** Friday, October 30, 2026

---

## 1. EXECUTIVE SUMMARY

The context-pager plugin needs to detect test execution to automatically swap to the Testing Pool. This requires identifying the exact command strings agents invoke when running tests. After exhaustive investigation of agent instructions, language skills, OpenCode configuration, and the OpenCode plugin API, here are the findings:

**Key finding 1:** The `test-auditor` agent does NOT execute tests at all — it is a read-only diagnostic agent. The agent that runs tests is `test-engineer`.

**Key finding 2:** The OpenCode tool is named `bash` (not `execute_bash` as the original research brief assumed). The hook event is `tool.execute.before`, triggered when `input.tool === "bash"`.

**Key finding 3:** Test commands are defined per-language in language skills (python-skill, typescript-skill, go-skill, rust-skill) as `TEST_CMD` variables. These are the authoritative patterns the context-pager should detect.

---

## 2. REFINED REQUIREMENTS

### 2.1 Objective
Define the exact regex/command patterns for detecting test execution via OpenCode's bash tool, so the context-pager plugin can automatically swap to the Testing Pool when a test run is detected.

### 2.2 Scope
- Identify which agents actually run test commands
- Map the `TEST_CMD` variables from each language skill
- Determine how the plugin hooks into tool execution (`bash` tool)
- Document the gap between `execute_bash` (original term) and actual OpenCode `bash` tool

### 2.3 Definition of Done
- [ ] Exact test command patterns identified per language
- [ ] OpenCode hook mechanism confirmed (bash tool, not execute_bash)
- [ ] Agent dispatch chain documented (which agent runs tests)
- [ ] Regex patterns proposed for context-pager tool execution detector

---

## 3. AGENT ANALYSIS

### 3.1 test-auditor (diagnostic only — does NOT run tests)

File: `~/.config/opencode/agents/test-auditor.md`

The `test-auditor` is a **read-only, diagnostic agent**. It:
- Parses codebases and statically analyzes existing test files
- Finds structural testing gaps, weak assertions, missing edge cases
- Outputs a structured gap matrix and TODO list
- **Explicitly instructed: "DO NOT FIX CODE. DO NOT REFACTOR. DO NOT IMPLEMENT TESTS."**
- Has no `bash` permission — it only reads files

**Conclusion:** The test-auditor never runs tests. It never invokes `bash` with test commands.

### 3.2 test-engineer (the agent that runs tests)

File: `~/.config/opencode/agents/test-engineer.md`

The `test-engineer` is dispatched by `dev-team-lead` and:
- Writes or updates unit tests
- Writes integration tests for API endpoints
- **Runs existing tests to verify no regressions**
- Has `bash` permission set to `"allow"` (all tools allowed except `task` and `todowrite`)

**Conclusion:** This is the agent that actually executes test commands via the `bash` tool.

### 3.3 How dev-team-lead determines WHICH test command to run

File: `~/.config/opencode/agents/dev-team-lead.md`

The `dev-team-lead` pipeline (Step 1.6: Stack Context):
1. Detects the project's tech stack via `detect-stack` skill
2. Loads the matching language skill (`python-skill`, `typescript-skill`, `go-skill`, `rust-skill`)
3. The loaded skill provides `TEST_CMD` (plus `LINT_CMD`, `TYPECHECK_CMD`, `FORMAT_CMD`)
4. The `test-engineer` uses `TEST_CMD` when running tests

---

## 4. AUTHORIZED TEST COMMAND PATTERNS (from Language Skills)

These are the **exact** `TEST_CMD` patterns defined in the language skills, which are the authoritative test commands the pipeline uses:

### 4.1 Python (`python-skill`)

| Variable | Command | Notes |
|----------|---------|-------|
| `TEST_CMD` | `pytest` or `uv run pytest` | May also include args like `--tb=short`, specific paths |

Variants seen in practice:
- `pytest`
- `pytest tests/`
- `pytest tests/test_*.py`
- `uv run pytest`
- `uv run pytest tests/`

### 4.2 TypeScript/JavaScript (`typescript-skill`)

| Variable | Command | Notes |
|----------|---------|-------|
| `TEST_CMD` | `pnpm test` or `vitest` | May include `--run`, `--watch=false` |

Variants seen in practice:
- `pnpm test`
- `pnpm test:unit`
- `vitest run`
- `vitest`
- `npm test`
- `bun test`

### 4.3 Go (`go-skill`)

| Variable | Command | Notes |
|----------|---------|-------|
| `TEST_CMD` | `go test ./... -race` | Race detector always included |

Variants seen in practice:
- `go test ./...`
- `go test ./... -race`
- `go test ./pkg/... -race`
- `go test ./... -v`
- `go test ./... -race -cover`

### 4.4 Rust (`rust-skill`)

| Variable | Command | Notes |
|----------|---------|-------|
| `TEST_CMD` | `cargo test --all-features` | All features always included |

Variants seen in practice:
- `cargo test`
- `cargo test --all-features`
- `cargo test --all-targets`
- `cargo test --all-features --all-targets`

---

## 5. OPencode TOOL EXECUTION MECHANISM

### 5.1 Tool Name: `bash` (NOT `execute_bash`)

OpenCode uses a `bash` tool for shell command execution. There is no `execute_bash` tool. The original research brief (Issue #1) used the term `execute_bash` which is incorrect — the actual tool name is `bash`.

### 5.2 Hook API for Detecting Test Execution

The context-pager plugin should use the `tool.execute.before` hook to intercept tool calls before execution. The hook signature (OpenCode v2 plugin API):

```javascript
export const MyPlugin = async (ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      // input.tool === "bash"
      // output.args.command contains the shell command string
      if (input.tool === "bash") {
        const command = output.args.command;
        // Check if command matches test patterns
      }
    },
  };
};
```

### 5.3 Hook Availability Confirmed

- `tool.execute.before` — fires before every tool execution
- `tool.execute.after` — fires after every tool execution
- Both hooks receive `input.tool` (tool name) and `output.args` (tool arguments)
- For bash tool: `output.args.command` is the shell command string

### 5.4 Existing Plugin Using This Hook

The `rtk.js` plugin (now disabled) used this exact pattern:
```javascript
ctx.tool.hook("execute.before", ...)
```
It intercepted bash commands and attempted to rewrite them. This confirms the hook works for command inspection.

---

## 6. PROPOSED TEST DETECTION PATTERNS

Based on the authoritative `TEST_CMD` patterns from language skills, the context-pager should detect these patterns in `bash` tool commands:

```javascript
const TEST_COMMAND_PATTERNS = [
  // Python
  /(?<![^\s])pytest(?![^\s])/,
  /uv\s+run\s+pytest/,
  /python\s+-(m|\s)pytest/,
  /python.*-m\s+unittest/,
  /nose2\b/,

  // TypeScript/JavaScript
  /\bvitest\b/,
  /\bjest\b/,
  /pnpm\s+test\b/,
  /npm\s+(run\s+)?test\b/,
  /yarn\s+(run\s+)?test\b/,
  /bun\s+test\b/,

  // Go
  /go\s+test\b/,

  // Rust
  /cargo\s+test\b/,

  // Generic / fallback
  /make\s+test\b/,
  /rake\s+test\b/,
  /bundle\s+exec\s+rake\s+test/,
  /dotnet\s+test\b/,
  /mvn\s+test\b/,
  /gradle\s+test\b/,
  /phpunit\b/,
  /cypress\s+run\b/,
  /playwright\s+test\b/,
  /cucumber\b/,
  /mocha\b/,
];
```

**Detection logic:**
```javascript
const isTestCommand = (command) =>
  TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
```

---

## 7. RESEARCH BRIEF ISSUE #1 — CORRECTION

The original research brief (Issue #1, `docs/RESEARCH_BRIEF_ISSUE_001.md`) contains an inaccuracy:

| Claim in Brief #1 | Actual Finding |
|---|---|
| `execute_bash` is the tool name | Tool name is `bash` |
| `ctx.tool.hook("execute.before", callback)` is the API | V2 API: return `"tool.execute.before"` as a hook entry from plugin function (not a method call on ctx) |
| `event.tool` and `event.input` are the parameters | Parameters are `input` (with `.tool`) and `output` (with `.args.command`) |

This correction should be propagated to the context-pager implementation.

---

## 8. PERMISSION ANALYSIS

In the global `opencode.json` (`~/.config/opencode/opencode.json`):

- `bash` permission defaults to `"ask"` (user approval required)
- Specific commands are allowed without approval: `cp`, `chmod`, `mv`, `rm`, `mkdir`, `find`, `grep`, `git`, `cat`, etc.
- **No test commands are pre-approved** — `pytest`, `pnpm test`, `go test`, `cargo test`, `vitest` would all trigger `"ask"` unless added to the allow list
- `*python*` is allowed (line 94), so `python -m pytest` might pass through
- The `test-engineer` agent overrides with `"*": "allow"` for all tools

---

## 9. AGENT DISPATCH CHAIN (when tests are run)

```
user request
    → team-lead (classification: dev)
        → dev-team-lead
            → detect-stack → load language skill (TEST_CMD known)
            → backend-engineer / frontend-engineer (implementation)
            → test-engineer (runs TEST_CMD via bash tool)
                → bash tool: "pytest" or "pnpm test" etc.
                    → context-pager plugin hook fires here
                        → detects test pattern
                        → swaps to Testing Pool
```

The context-pager plugin's `tool.execute.before` hook fires when the `test-engineer` (or any agent) calls the `bash` tool with a test command.

---

## 10. OPEN QUESTIONS

1. **Should the context-pager also detect lint commands?** The language skills define `LINT_CMD` separately. The state machine in Brief #1 has CODING → DEBUGGING on "Run Tests", but lint runs separately. Should lint trigger a Testing Pool swap or a different pool?

2. **Should build commands trigger Testing Pool?** Commands like `cargo build`, `go build`, `pnpm build` are not test commands but are often run alongside tests.

3. **Subagent isolation:** When `test-engineer` runs as a subagent (separate session), does the parent session's context-pager need to know about the child session's test execution? Or does each session have its own pool state?

---

## 11. RECOMMENDATIONS

1. **Fix the tool name:** Use `bash`, not `execute_bash`, in all context-pager documentation and code.

2. **Use language skill TEST_CMD patterns:** The authoritative test command patterns come from language skills. The context-pager should mirror these patterns rather than inventing its own.

3. **Hook into `tool.execute.before`:** Use the `tool.execute.before` hook to intercept bash tool calls and check `output.args.command` against test patterns.

4. **Make patterns configurable:** Allow the context-pager to accept additional test patterns via plugin configuration, so project-specific test commands can be added.

5. **Clarify test-auditor vs test-engineer:** The test-auditor does not run tests. The context-pager should trigger on test-engineer's bash calls, not test-auditor's (which are read-only).

---

**File Path:** `/docs/RESEARCH_BRIEF_ISSUE_003.md`

**Status:** Complete — ready for pipeline lead handoff

**Next Owner:** dev-team-lead (for context-pager plugin implementation)
