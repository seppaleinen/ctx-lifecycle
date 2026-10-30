# Context-Pager Changelog

## [Workstream 1: Foundation] — 2026-10-30

### Added

- **Plugin entry point** (`src/index.ts`): OpenCode V2 plugin with `ctx.session.hook("context", ...)`, `ctx.tool.hook("execute.before", ...)`, and `/transition` command handler
- **Type definitions** (`src/types.ts`): `PoolID` enum, `StateMachineState` enum, `ContextMessage`, `ContextPool`, `TransitionEvent`, `PersistedPools`, `ContextPagerConfig`, `STATE_TO_POOL` mapping, `SCHEMA_VERSION`, `DEFAULT_CONFIG`
- **Context Router** (`src/router.ts`): `ContextRouter` class with four isolated pools, `getActivePools(state)`, `addMessage(poolId, message)`
- **State Machine** (`src/state-machine.ts`): `StateMachine` class with 4-state transition matrix (6 valid transitions), `transition()`, `canTransition()`, `parseTransitionCommand()`
- **Summary Generator** (`src/summary-generator.ts`): `SummaryGenerator` class with `generateSummary()`, `validateSummary()`, `addSummaryToPool()`. Enforces 1-sentence limit, template format, and prohibited content (evicted details, token counts)
- **Unit tests** (26 tests, all passing): `tests/unit/router.test.ts`, `tests/unit/state-machine.test.ts`, `tests/unit/summary.test.ts`

### Key Design Decisions

- Four isolated context pools (Global, Planning, Execution, Testing) managed by a state machine
- Explicit `/transition` commands with 6 valid transitions per matrix
- Hand-off summaries per ADR-004: 1 sentence max, template `"Swapped to {POOL_NAME} Pool. {trigger}"`, no evicted content, no token counts
- `STATE_TO_POOL` maps COMPLETE → PLANNING (Testing pool is emptied when leaving COMPLETE, not the pool COMPLETE maps to)
- `ContextMessage` has optional `id` (OpenCode assigns IDs at SDK boundary)
- `ContextPool` simplified to `{ id: PoolID; messages: ContextMessage[] }` for Workstream 1
- `swapPool` removed from `ContextRouter` (YAGNI)
- `Message.system/user/assistant` factories from `@opencode/ai/effect` used to convert `ContextMessage` → OpenCode `Message`
- Bash tool input properly guarded with `typeof` check before regex matching

### Build Status

- `tsc --noEmit`: passes
- `bun test tests/unit/`: 26/26 passing
- `bun build src/index.ts --outdir=dist --target=bun`: succeeds

## [Post-Mortem Follow-up] — 2026-10-30

### Changed

- **Summary generator types** (`src/summary-generator.ts`): `generateSummary` and `addSummaryToPool` accept `StateMachineState` enum instead of loose `string`
- **Plugin entry logging** (`src/index.ts`): Added `console.debug` transition logging (`fromState → toState`) in both `/transition` handler and auto-transition path
- **Test casts removed** (`tests/unit/summary.test.ts`, `tests/manual-verification.ts`): 7 `as any` casts eliminated; tests now use enum values directly

### Added

- **ESLint configuration** (`eslint.config.js`): ESLint 10 flat config with `no-explicit-any` and `no-unused-vars` as errors
- **Integration tests** (`tests/integration/hooks.test.ts`): 9 tests exercising the real `plugin.setup(ctx)` with an instrumented context — covers `ctx.session.hook('context')` ContextMessage[]→Message[] conversion and `ctx.tool.hook('execute.before')` bash detection + auto-transition
- **Verify script** (`package.json`): `"verify": "tsc --noEmit && bun test tests/unit/ && bun build src/index.ts --outdir=dist --target=bun"`

### Removed

- **Vitest config** (`vitest.config.ts`): Deleted; no vitest dependency exists, project uses `bun test`
- **Legacy ESLint config** (`.eslintrc.json`): Deleted; superseded by flat config

### Security

- **LOW advisory** (accepted risk): Bash command string interpolated into context-pool system message without sanitization. Accepted for single-user local deployment; not fixed.

### Build Status

- `tsc --noEmit`: passes
- `bun test tests/unit/`: 26/26 passing
- `bun test tests/integration/`: 9/9 passing
- `bun run verify`: green
- `eslint src/`: clean
- `bun build src/index.ts --outdir=dist --target=bun`: succeeds (294 modules → dist/index.js)