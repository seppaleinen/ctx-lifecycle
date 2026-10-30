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