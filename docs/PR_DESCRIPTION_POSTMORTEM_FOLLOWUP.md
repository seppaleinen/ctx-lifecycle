# PR Description: Post-Mortem Follow-up for Workstream 1

**Title:** `fix(context-pager): post-mortem follow-up for Workstream 1 (lint, types, integration tests)`
**Date:** 2026-10-30
**Workstream:** Phase 1, Workstream 1 (Foundation) — post-mortem follow-up
**Reference:** [ADR-006](./ADR-006.md) — YAGNI Simplicity Rework

---

## Summary

Addresses the 8 findings from the Phase 1 Workstream 1 post-mortem: adds lint enforcement, a single `verify` script, tighter types, transition logging, and real integration tests. Removes dead configuration and legacy lint config. No runtime behavior change beyond logging.

## Changes

### 1. Orphan `vitest.config.ts` removed

**Finding:** `vitest.config.ts` existed with no vitest dependency and no imports referencing it — pure configuration drift.

**Fix:** Deleted. The project runs tests with `bun test`; no vitest dependency is present. (ADR-006, item 1)

### 2. No lint enforcement

**Finding:** No linter was configured or installed, so `no-explicit-any` and unused-variable drift went undetected.

**Fix:** Added ESLint 10 as a devDependency with a flat config (`eslint.config.js`): `@eslint/js` recommended + `typescript-eslint` recommended, with `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-unused-vars` set to errors. The legacy `.eslintrc.json` (untracked) was removed since ESLint 10 only supports flat config. The `lint` script now runs `bunx eslint src/ tests/`. (ADR-006, item 4 enforcement)

### 3. No single verification command

**Finding:** Type-check, test, and build had to be run separately; nothing guaranteed all three together.

**Fix:** Added `"verify": "tsc --noEmit && bun test tests/unit/ && bun build src/index.ts --outdir=dist --target=bun"` to `package.json`.

### 4. Loose `string` typing in `SummaryGenerator`

**Finding:** `generateSummary(targetState: string, ...)` and `addSummaryToPool(state: string, ...)` accepted `string` and internally cast `as StateMachineState`, defeating type safety.

**Fix:** Both signatures now take `StateMachineState` directly; the internal casts are gone. (ADR-006, item 4)

### 5. `as any` casts in tests

**Finding:** 7 `as any` casts in `tests/unit/summary.test.ts` and `tests/manual-verification.ts` papered over the loose signatures above.

**Fix:** All 7 casts removed; tests pass `StateMachineState` enum values directly. The new `no-explicit-any` lint rule prevents recurrence. (ADR-006, item 5)

### 6. No integration tests for the real plugin entry point

**Finding:** Workstream 1 had 26 unit tests but zero coverage of `src/index.ts` — the actual hook registrations and hook handlers were untested.

**Fix:** New `tests/integration/hooks.test.ts` (9 tests) runs the **real** `plugin.setup(ctx)` against an instrumented context object (plain object literals capturing registered hooks and commands) — no module mocks, real `StateMachine`, real `ContextRouter`, real `@opencode/ai/effect` `Message` factories. Covers:

- `ctx.session.hook('context')`: `ContextMessage[]` → `Message[]` conversion
- `ctx.tool.hook('execute.before')`: bash detection + automatic `CODING → DEBUGGING` transition
- `/transition` command: real `execute()` driving the module-level state machine through transitions

### 7. No transition observability

**Finding:** State transitions were silent — impossible to tell from logs whether a transition fired and from which state.

**Fix:** `console.debug` transition logging (`fromState → toState`) added to both handlers in `src/index.ts` (explicit `/transition` command and auto-transition on test detection). The `sessionID` parameter in the `/transition` handler destructuring was also removed as unused.

### 8. ADR-006 existed only inline

**Finding:** The YAGNI Simplicity Rework decision (ADR-006) was recorded only in the ADRs section of `PHASE1_IMPLEMENTATION_PLAN.md`, breaking the ADR file series.

**Fix:** ADR-006 promoted to a standalone `docs/ADR-006.md` mirroring the plan's inline content, keeping the series complete.

## Verification Evidence

| Check | Result |
|-------|--------|
| `bun run verify` | ✅ green (`tsc --noEmit` → `bun test tests/unit/` → `bun build`) |
| Unit tests | ✅ 26/26 passing |
| Integration tests | ✅ 9/9 passing (`tests/integration/hooks.test.ts`) |
| Total | ✅ 35/35 |
| `bunx eslint src/ tests/` | ✅ clean |
| Build | ✅ `dist/index.js` (294 modules) |
| Code review | ✅ SUCCESS |
| Security audit | ✅ SUCCESS — 1 LOW advisory, accepted as risk (below) |

## Security Note

**LOW advisory (accepted risk, not fixed):** a bash command string is interpolated into a context-pool system message (`"Test command detected: ${command}"`) without sanitization. Recorded in the audit and accepted: the plugin is a single-user, local deployment, and the command string originates from the user's own shell input in the same session. No external or untrusted input path exists.

## ADRs

- **ADR-006: YAGNI Simplicity Rework** — documents the decisions in findings 1, 4, and 5 (remove orphan config, keep single `STATE_TO_POOL` source of truth, tighten `SummaryGenerator` signatures, drop `as any` casts). Full text in [ADR-006.md](./ADR-006.md).
