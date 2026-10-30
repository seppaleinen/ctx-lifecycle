# Phase 1 Implementation Plan: context-pager

**Issue:** [#1](https://github.com/seppaleinen/ctx-lifecycle/issues/1)  
**Wayfinder Map:** [#2](https://github.com/seppaleinen/ctx-lifecycle/issues/2)  
**Date:** October 30, 2026  
**Status:** Ready for Implementation  

---

## 1. EXECUTIVE SUMMARY

Phase 1 delivers an **event-driven context lifecycle middleware** for OpenCode V2 that replaces monolithic, append-only context with **issue-scoped eviction** and **phase-driven context pool paging**. The expanded scope (per Wayfinder decision #4) merges original Phase 1 + Phase 2 features into a single delivery:

- ✅ Automatic pool swapping on test detection
- ✅ Pool persistence to disk (JSON via `ctx.storage`)
- ✅ Full state machine with PLANNING, CODING, DEBUGGING, COMPLETE states
- ✅ Configuration system for pool rules
- ✅ Basic validation harness

**Success Metrics (Wayfinder #8):**
- Token ceiling: 15k-25k tokens flat over 2-hour sessions
- Pass@1 improvement: ≥15% over baseline
- Zero stale-symbol hallucinations

---

## 2. ARCHITECTURE OVERVIEW

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenCode V2 Server                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐      ┌──────────────────────────────────┐ │
│  │   User Session  │─────▶│     context-pager Plugin         │ │
│  │   (Messages)    │      │  (src/index.ts)                  │ │
│  └─────────────────┘      └─────────────┬────────────────────┘ │
│                                          │                        │
│         ┌────────────────────────────────┼────────────────────┐ │
│         │                                │                    │ │
│         ▼                                ▼                    ▼ │
│  ┌─────────────┐              ┌─────────────┐       ┌───────────┐│
│  │ Global Pool  │              │Planning Pool│       │Execution  ││
│  │ (Immutable)  │              │             │       │Pool       ││
│  │ - System     │              │ - Research  │       │           ││
│  │ - Types      │              │ - Design    │       │ - Code    ││
│  │ - Invariants │              │ - Contracts │       │ - Diffs   ││
│  └─────────────┘              └─────────────┘       └───────────┘│
│                                                             │    │
│                                                     ┌───────┴────┐│
│                                                     │Testing Pool││
│                                                     │            ││
│                                                     │ - Test out ││
│                                                     │ - Failures ││
│                                                     └────────────┘│
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    State Machine                            ││
│  │                                                             ││
│  │    [PLANNING] ──(/transition coding)──► [CODING]           ││
│  │         ▲                             │   │                 ││
│  │         │         (/transition        │   │ (/transition    ││
│  │         │          planning)          │   │  debugging)     ││
│  │         │                             ▼   ▼                 ││
│  │         │                      [COMPLETE] ◄─────────────────┤│
│  │         │                             ▲   │                 ││
│  │         │         (/transition        │   │ (/transition    ││
│  │         └───────── planning) ─────────┴───┴── complete)     ││
│  │                                    [DEBUGGING]              ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Persistence Layer (ctx.storage)                ││
│  │  Key: pools/<project-id> → JSON serialized pools            ││
│  │  Location: ~/.local/share/opencode/storage/plugin/          ││
│  │                      context-pager/                         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility | Files |
|-----------|---------------|-------|
| **Plugin Entry** | V2 plugin definition, hook registration, command handlers | `src/index.ts` |
| **Context Router** | Pool management, state machine, transitions | `src/router.ts` |
| **State Machine** | Explicit `/transition` command handling, state validation | `src/state-machine.ts` |
| **Pool Manager** | Pool CRUD operations, eviction logic, hand-off summaries | `src/pools/manager.ts` |
| **Persistence Layer** | JSON serialization, `ctx.storage` I/O, redaction | `src/persistence.ts` |
| **Token Tracker** | Token counting, ceiling enforcement, pool budgets | `src/token-tracker.ts` |
| **Test Detector** | Bash tool pattern matching for test commands | `src/test-detector.ts` |
| **Config System** | Plugin configuration schema, defaults, validation | `src/config.ts` |
| **Validation Harness** | Metrics collection, Pass@1 tracking, hallucination detection | `src/validation.ts` |

### 2.3 Data Flow

1. **Request Interception:** `session.request` hook fires → Context Router swaps active pools → Modified messages sent to model
2. **Tool Execution:** `tool.execute.before` hook fires → Test Detector checks bash command → If test detected, trigger `/transition debugging`
3. **State Transition:** User issues `/transition <state>` → State Machine validates → Pool Manager swaps pools → Hand-off summary generated
4. **Persistence:** On pool changes → Persistence Layer serializes to JSON → Redacts secrets → Saves via `ctx.storage.set()`
5. **Session Restore:** Plugin loads → `ctx.storage.get()` → Deserializes pools → Restores state

---

## 3. TASK BREAKDOWN WITH ACCEPTANCE CRITERIA

### 3.1 Foundation (Week 1)

#### Task 1.1: Project Setup
**Deliverable:** TypeScript project structure with OpenCode V2 dependencies

**Acceptance Criteria:**
- [ ] `package.json` with `@opencode/plugin@^2.1.1`, `typescript`, `bun-types`
- [ ] `tsconfig.json` with ES2022 target, ESM modules, strict mode
- [ ] Directory structure: `src/`, `src/pools/`, `tests/`, `.opencode/`
- [ ] Build script: `bun run build` compiles to `dist/`
- [ ] Plugin loads in OpenCode without errors

**Files:** `package.json`, `tsconfig.json`, `src/index.ts` (skeleton)

---

#### Task 1.2: Plugin Entry Point
**Deliverable:** V2 plugin definition with hook registration

**Acceptance Criteria:**
- [ ] Exports `Plugin.define({ id: "context-pager", setup })`
- [ ] Registers `session.request` hook for message interception
- [ ] Registers `tool.execute.before` hook for test detection
- [ ] Registers `/transition` command handler
- [ ] Plugin ID is unique and stable

**Files:** `src/index.ts`

---

#### Task 1.3: Type Definitions
**Deliverable:** TypeScript interfaces for all domain entities

**Acceptance Criteria:**
- [ ] `PoolID` enum: GLOBAL, PLANNING, EXECUTION, TESTING
- [ ] `ContextPool` interface with `id`, `messages`, `maxTokens`, `evictionPolicy`
- [ ] `StateMachineState` enum: PLANNING, CODING, DEBUGGING, COMPLETE
- [ ] `TransitionEvent` interface for state changes
- [ ] `PersistedPools` schema for serialization

**Files:** `src/types.ts`

---

#### Task 1.4: Context Router
**Deliverable:** Core routing logic with pool isolation

**Acceptance Criteria:**
- [ ] Maintains four isolated pools in memory
- [ ] `getActivePools(state): Message[]` returns combined messages for current state
- [ ] `swapPool(from, to): void` exchanges active pools
- [ ] Global pool is always included (immutable)
- [ ] Unit tests for pool operations

**Files:** `src/router.ts`, `tests/unit/router.test.ts`

---

### 3.2 State Machine (Week 1-2)

#### Task 2.1: State Machine Implementation
**Deliverable:** Explicit `/transition` command handling

**Acceptance Criteria:**
- [ ] State enum: PLANNING, CODING, DEBUGGING, COMPLETE
- [ ] Transition matrix validates allowed transitions
- [ ] `/transition <state>` command parser
- [ ] Invalid transitions throw error with message
- [ ] State changes trigger pool swap + hand-off summary

**Transition Matrix:**
| From | To | Trigger |
|------|-----|---------|
| PLANNING | CODING | `/transition coding` |
| CODING | PLANNING | `/transition planning` |
| CODING | DEBUGGING | `/transition debugging` OR test detection |
| DEBUGGING | COMPLETE | `/transition complete` OR tests pass |
| DEBUGGING | PLANNING | `/transition planning` |
| COMPLETE | PLANNING | `/transition planning` (new task) |

**Files:** `src/state-machine.ts`, `tests/unit/state-machine.test.ts`

---

#### Task 2.2: Hand-off Summary Generator
**Deliverable:** Minimal 1-sentence summaries on transitions

**Acceptance Criteria:**
- [ ] Template: `"Swapped to {POOL_NAME} Pool. {trigger reason / files touched}"`
- [ ] Maximum 1 sentence
- [ ] Does NOT include evicted content details
- [ ] Does NOT include token counts
- [ ] Appended to active pool on transition

**Examples:**
- `"Swapped to Testing Pool. Modified auth.ts and db.ts"`
- `"Swapped to Execution Pool. File read: user-service.ts"`
- `"Swapped to Planning Pool. Task switch"`

**Files:** `src/summary-generator.ts`, `tests/unit/summary.test.ts`

---

### 3.3 Pool Persistence (Week 2)

#### Task 3.1: Persistence Layer
**Deliverable:** JSON serialization via `ctx.storage` API

**Acceptance Criteria:**
- [ ] Uses `ctx.storage.set("pools/<project-id>", data)`
- [ ] Uses `ctx.storage.get("pools/<project-id>")`
- [ ] Project ID from `ctx.location.project.id`
- [ ] JSON schema matches `PersistedPools` interface
- [ ] Handles missing/empty storage gracefully

**Schema:**
```typescript
interface PersistedPools {
  version: number;           // Schema version for migrations
  projectId: string;         // Git repo hash
  updatedAt: number;         // Unix timestamp
  pools: {
    global: ContextPool;
    planning: ContextPool;
    execution: ContextPool;
    testing: ContextPool;
  };
}
```

**Files:** `src/persistence.ts`, `tests/unit/persistence.test.ts`

---

#### Task 3.2: Security Redaction
**Deliverable:** Pre-storage PII/secret redaction

**Acceptance Criteria:**
- [ ] Scans messages for API keys, tokens, passwords
- [ ] Replaces matches with `[REDACTED]`
- [ ] Uses regex patterns from LangChain preset or similar
- [ ] Redaction happens before `ctx.storage.set()`
- [ ] Unit tests with sample secrets

**Patterns to Redact:**
- API keys: `sk-[a-zA-Z0-9]{32,}`
- GitHub tokens: `ghp_[a-zA-Z0-9]{36}`
- Generic secrets: `(password|secret|token)["']?\s*[:=]\s*["']?[^\s"']{8,}`

**Files:** `src/redaction.ts`, `tests/unit/redaction.test.ts`

---

#### Task 3.3: Pool Restoration
**Deliverable:** Session restart pool recovery

**Acceptance Criteria:**
- [ ] Loads pools on plugin initialization
- [ ] Validates project ID matches before restore
- [ ] Handles corrupted/invalid JSON gracefully (logs error, starts fresh)
- [ ] Restores state machine state from last session
- [ ] Integration test with mock `ctx.storage`

**Files:** `src/persistence.ts` (restore logic), `tests/integration/restore.test.ts`

---

### 3.4 Test Detection (Week 2-3)

#### Task 4.1: Test Command Detector
**Deliverable:** Bash tool pattern matching

**Acceptance Criteria:**
- [ ] Intercepts `tool.execute.before` with `input.tool === "bash"`
- [ ] Extracts command from `output.args.command`
- [ ] Matches against language-specific TEST_CMD patterns
- [ ] Triggers automatic `/transition debugging` on match

**Patterns (from Research Brief #3):**
```typescript
const TEST_COMMAND_PATTERNS = [
  // Python
  /(?<![^\s])pytest(?![^\s])/,
  /uv\s+run\s+pytest/,
  /python\s+-(m|\s)pytest/,
  
  // TypeScript
  /\bvitest\b/,
  /\bjest\b/,
  /pnpm\s+test\b/,
  /npm\s+(run\s+)?test\b/,
  
  // Go
  /go\s+test\b/,
  
  // Rust
  /cargo\s+test\b/,
  
  // Generic
  /make\s+test\b/,
  /dotnet\s+test\b/,
];
```

**Files:** `src/test-detector.ts`, `tests/unit/detector.test.ts`

---

#### Task 4.2: Auto-Transition on Test Detection
**Deliverable:** Automatic state transition without explicit command

**Acceptance Criteria:**
- [ ] Test detection triggers state machine transition
- [ ] Only fires when in CODING state (prevents redundant transitions)
- [ ] Generates hand-off summary automatically
- [ ] Can be disabled via config (`autoTransition: false`)

**Files:** `src/index.ts` (hook handler), `src/state-machine.ts`

---

### 3.5 Configuration System (Week 3)

#### Task 5.1: Plugin Configuration Schema
**Deliverable:** Configurable pool rules and behavior

**Acceptance Criteria:**
- [ ] Config file: `.opencode/context-pager.jsonc` or `opencode.json` section
- [ ] Zod schema for validation
- [ ] Defaults for all options
- [ ] Config loaded on plugin init

**Config Schema:**
```typescript
interface ContextPagerConfig {
  enabled: boolean;                    // Default: true
  tokenCeiling: number;                // Default: 25000
  persistence: {
    enabled: boolean;                  // Default: true
    redactSecrets: boolean;            // Default: true
  };
  autoTransition: {
    enabled: boolean;                  // Default: true
    onTestDetection: boolean;          // Default: true
  };
  pools: {
    global: { maxTokens: number };     // Default: 5000
    planning: { maxTokens: number };   // Default: 8000
    execution: { maxTokens: number };  // Default: 10000
    testing: { maxTokens: number };    // Default: 5000
  };
}
```

**Files:** `src/config.ts`, `.opencode/context-pager.example.jsonc`

---

### 3.6 Token Tracking (Week 3)

#### Task 6.1: Token Counter
**Deliverable:** Token counting and ceiling enforcement

**Acceptance Criteria:**
- [ ] Uses OpenCode's token utilities if available
- [ ] Falls back to `tiktoken` or similar if needed
- [ ] Tracks tokens per pool
- [ ] Enforces ceiling on `session.request` hook
- [ ] Evicts oldest messages when ceiling exceeded

**Files:** `src/token-tracker.ts`, `tests/unit/token-tracker.test.ts`

---

#### Task 6.2: Eviction Logic
**Deliverable:** Pool-specific eviction policies

**Acceptance Criteria:**
- [ ] Global pool: never evicted (`immutable: true`)
- [ ] Planning pool: summarize before eviction
- [ ] Execution pool: discard oldest on overflow
- [ ] Testing pool: discard all on transition to COMPLETE
- [ ] Eviction triggers hand-off summary

**Files:** `src/pools/manager.ts`, `tests/unit/eviction.test.ts`

---

### 3.7 Validation Harness (Week 3-4)

#### Task 7.1: Metrics Collection
**Deliverable:** Token ceiling tracking over sessions

**Acceptance Criteria:**
- [ ] Logs token counts per request
- [ ] Tracks session duration
- [ ] Exports metrics to JSON for analysis
- [ ] Dashboard or CLI tool to view metrics

**Files:** `src/validation.ts`, `tools/validate-session.ts`

---

#### Task 7.2: Pass@1 Tracking
**Deliverable:** Success rate measurement

**Acceptance Criteria:**
- [ ] Baseline measurement (no context-pager)
- [ ] With context-pager enabled
- [ ] Compares task completion rates
- [ ] Statistical significance check

**Files:** `tests/validation/pass1-benchmark.ts`

---

#### Task 7.3: Hallucination Detection
**Deliverable:** Stale-symbol detection

**Acceptance Criteria:**
- [ ] Tracks refactored/deleted symbols
- [ ] Flags agent invocations of old signatures
- [ ] Zero tolerance policy
- [ ] Logs false positives for analysis

**Files:** `tests/validation/hallucination-detector.ts`

---

## 4. ARCHITECTURE DECISION RECORDS (ADRs)

### ADR-001: Domain-Isolated Context Pools

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** Wayfinder Map #2  

**Context:**
Current agent harnesses treat conversation context as a monotonically growing, append-only log. This leads to context degradation, poisoning from stale information, and unnecessary token expense over multi-hour sessions.

**Decision:**
Implement four isolated context pools with distinct eviction policies:
1. **Global Pool** (immutable, never evicted) - System invariants, types, schemas
2. **Planning Pool** (summarize before eviction) - Research, design, contracts
3. **Execution Pool** (discard oldest) - Active code changes, diffs
4. **Testing Pool** (discard on complete) - Test output, failures

**Consequences:**
- ✅ Maintains flat token ceiling (15k-25k) over long sessions
- ✅ Prevents stale-symbol hallucinations
- ✅ Improves Pass@1 success rate
- ⚠️ Adds complexity to message routing
- ⚠️ Requires careful pool swap timing to avoid context loss

---

### ADR-002: Event-Driven Pool Swapping via Explicit Commands

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** Wayfinder Map #7  

**Context:**
Initial design proposed implicit tool-based detection (file reads, edits, test runs) for state transitions. Concerns raised about false positives from incidental file operations.

**Decision:**
Use explicit `/transition <state>` commands for state machine transitions. Test detection remains automatic (triggers `/transition debugging`), but all other transitions require explicit user/agent instruction.

**Command Format:**
```
/transition planning
/transition coding
/transition debugging
/transition complete
```

**Consequences:**
- ✅ Eliminates false positives from incidental file reads
- ✅ Gives agent instructions full control over handoff timing
- ⚠️ Requires agent to be trained on `/transition` commands
- ⚠️ Slightly more verbose workflow

---

### ADR-003: JSON Serialization via ctx.storage API

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** Wayfinder Map #5  

**Context:**
Pools need to persist to disk to survive session restarts. Decision needed on serialization format (JSON vs binary) and storage location (project-local vs user-scoped).

**Decision:**
1. **Format:** JSON (not MessagePack/Protobuf) - human-readable, OpenCode native, negligible performance difference for <1MB pools
2. **Storage:** `ctx.storage` V2 API - plugin-scoped, XDG-compliant, survives plugin updates
3. **Location:** `~/.local/share/opencode/storage/plugin/context-pager/`
4. **Key:** `pools/<project-id>` - project-scoped to prevent cross-project leakage

**Consequences:**
- ✅ Aligns with OpenCode V2 best practices
- ✅ Human-readable for debugging context issues
- ✅ Automatic XDG path handling
- ⚠️ Less control over exact file paths
- ⚠️ Requires pre-storage redaction for secrets

---

### ADR-004: Minimal Hand-off Summaries

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** Wayfinder Map #6  

**Context:**
Pool swaps must generate summaries for narrative continuity, but summaries themselves consume tokens and risk leaking evicted content.

**Decision:**
Hand-off summaries are minimal:
- **Format:** 1 sentence maximum
- **Template:** `"Swapped to {POOL_NAME} Pool. {trigger reason / files touched}"`
- **Exclusions:** No evicted content details, no token counts, no file lists beyond trigger

**Examples:**
- ✅ `"Swapped to Testing Pool. Modified auth.ts and db.ts"`
- ❌ `"Swapped to Testing Pool. Evicted 15 messages from Execution Pool containing discussion about user authentication flow..."`

**Consequences:**
- ✅ Maintains narrative continuity with minimal token cost
- ✅ Prevents accidental leakage of evicted context
- ⚠️ Less detailed history for debugging

---

### ADR-005: Expanded Phase 1 Scope

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** Wayfinder Map #4  

**Context:**
Original research brief defined Phase 1 as MVP (manual switching + basic state machine + hooks + token counting + hand-off summaries). User requested expansion beyond MVP.

**Decision:**
Phase 1 includes all originally-planned Phase 1 + Phase 2 features:
- A) Automatic pool swapping on test detection
- B) Pool persistence to disk implementation
- C) Full state machine with DEBUGGING and COMPLETE states
- D) Configuration system for pool rules
- E) Basic validation harness

**Consequences:**
- ✅ Delivers production-ready feature set in single phase
- ✅ Validates full architecture end-to-end
- ⚠️ Longer Phase 1 timeline (4 weeks vs 2 weeks)
- ⚠️ Higher initial complexity

---

### ADR-006: YAGNI Simplicity Rework

**Date:** 2026-10-30
**Status:** Accepted
**Deciders:** Post-Mortem Workstream 1

**Context:**
During the Phase 1 post-mortem audit, several over-engineered components were identified that violated YAGNI (You Aren't Gonna Need It) principles:
1. `vitest.config.ts` - Orphaned test config with no vitest dependency or imports
2. Duplicate `STATE_TO_POOL` mapping in `router.ts` and `summary-generator.ts` (resolved in ADR-004 but re-introduced)
3. `swapPool` method in `ContextRouter` - Never used in Workstream 1, added speculatively
4. Loose `string` typing in `SummaryGenerator` methods requiring `as any` casts in tests

**Decision:**
Apply YAGNI-driven simplification:
1. Remove `vitest.config.ts` (no vitest dependency, project uses `bun test`)
2. Keep single source of truth for `STATE_TO_POOL` in `src/types.ts` (already done)
3. Remove unused `swapPool` method from `ContextRouter`
4. Tighten `SummaryGenerator` method signatures to use `StateMachineState` enum instead of `string`
5. Update tests to remove `as any` casts now that types align

**Consequences:**
- ✅ Eliminates dead code and configuration drift
- ✅ Stronger type safety without casts
- ✅ Simpler maintenance surface
- ⚠️ Requires updating any external consumers of removed APIs (none in Phase 1)

---

## 5. IMPLEMENTATION ORDER AND DEPENDENCIES

### Dependency Graph

```
Week 1: Foundation
├─ 1.1 Project Setup ──────────────────────────────┐
│                                                  ▼
├─ 1.2 Plugin Entry ───────────────────────► 1.3 Type Definitions
│                                                  │
│                                                  ▼
│                                         1.4 Context Router
│                                                  │
│                                                  ▼
└──────────────────────────────────────────► 2.1 State Machine
                                                   │
Week 2: Persistence + Detection                     ▼
├─ 3.1 Persistence Layer ◄────────────────── 2.2 Summary Generator
│                                                  │
│                                                  ▼
├─ 3.2 Security Redaction ─────────────────► 3.3 Pool Restoration
│
├─ 4.1 Test Detector ──────────────────────► 4.2 Auto-Transition
│
Week 3: Configuration + Tokens
├─ 5.1 Config System
│
├─ 6.1 Token Counter ──────────────────────► 6.2 Eviction Logic
│
Week 4: Validation
└─ 7.1 Metrics + 7.2 Pass@1 + 7.3 Hallucination Detection
```

### Critical Path

1. **Project Setup** → **Type Definitions** → **Context Router** → **State Machine**
2. **State Machine** → **Summary Generator** → **Persistence Layer** → **Pool Restoration**
3. **Test Detector** → **Auto-Transition**
4. **Token Counter** → **Eviction Logic**
5. **Validation Harness** (parallel, depends on all above)

### Milestone Dates

| Milestone | Target Date | Deliverables |
|-----------|-------------|--------------|
| M1: Foundation Complete | Week 1 End | Tasks 1.1-1.4, 2.1-2.2 |
| M2: Persistence Complete | Week 2 End | Tasks 3.1-3.3, 4.1-4.2 |
| M3: Configuration Complete | Week 3 End | Tasks 5.1, 6.1-6.2 |
| M4: Validation Complete | Week 4 End | Tasks 7.1-7.3, Full Integration Test |

---

## 6. VALIDATION STRATEGY

### 6.1 Unit Testing

**Coverage Target:** 80%+ line coverage

**Test Files:**
- `tests/unit/router.test.ts` - Pool operations, isolation
- `tests/unit/state-machine.test.ts` - Transition matrix, validation
- `tests/unit/summary.test.ts` - Summary generation, constraints
- `tests/unit/persistence.test.ts` - Serialization, deserialization
- `tests/unit/redaction.test.ts` - Secret pattern matching
- `tests/unit/detector.test.ts` - Test command pattern matching
- `tests/unit/token-tracker.test.ts` - Token counting, ceiling enforcement
- `tests/unit/eviction.test.ts` - Pool-specific eviction policies

**Test Runner:** `bun test` or `vitest`

---

### 6.2 Integration Testing

**Mock OpenCode Context:**
- Mock `ctx.storage` API
- Mock `ctx.session.hook()` registration
- Mock `ctx.tool.hook()` registration
- Mock `ctx.location.project.id`

**Test Scenarios:**
1. **Pool Swap on Transition:** Verify messages correctly swapped on `/transition`
2. **Persistence Round-Trip:** Save pools → restart plugin → restore pools
3. **Test Detection Auto-Transition:** Run test command → verify state change
4. **Token Ceiling Enforcement:** Exceed ceiling → verify eviction
5. **Redaction Verification:** Include secrets in messages → verify redacted in storage

**Test Files:**
- `tests/integration/pool-swap.test.ts`
- `tests/integration/persistence.test.ts`
- `tests/integration/auto-transition.test.ts`

---

### 6.3 Manual Testing in Real OpenCode Sessions

**Test Protocol:**
1. Load context-pager plugin in OpenCode
2. Start new session on test project
3. Run through state transitions manually
4. Execute test commands (verify auto-transition)
5. Restart OpenCode (verify pool restoration)
6. Monitor token counts over 2-hour session

**Validation Checklist:**
- [ ] Plugin loads without errors
- [ ] `/transition` commands work
- [ ] Test detection triggers DEBUGGING state
- [ ] Hand-off summaries appear in context
- [ ] Pools persist across restarts
- [ ] Token ceiling remains flat (15k-25k)
- [ ] No stale-symbol hallucinations observed

---

### 6.4 Benchmark Testing

**Token Ceiling Flatness:**
- **Method:** Run 2-hour continuous session with context-pager enabled
- **Metric:** Log token count every 5 minutes
- **Success:** Token count plateaus at 15k-25k, does not climb linearly

**Pass@1 Improvement:**
- **Method:** A/B testing
  - Group A: No context-pager (baseline)
  - Group B: With context-pager
- **Tasks:** 50 multi-file coding tasks (same difficulty distribution)
- **Metric:** First-attempt success rate
- **Success:** ≥15% improvement in Group B

**Stale-Symbol Hallucinations:**
- **Method:** Refactor codebase (rename functions, delete modules)
- **Task:** Agent continues development post-refactor
- **Metric:** Count invocations of old/deleted symbols
- **Success:** Zero hallucinations

---

## 7. PROJECT STRUCTURE PROPOSAL

```
ctx-lifecycle/
├── .opencode/
│   └── context-pager.example.jsonc    # Example plugin config
├── docs/
│   ├── RESEARCH_BRIEF_ISSUE_001.md    # Original architecture brief
│   ├── RESEARCH_BRIEF_ISSUE_003.md    # Test command patterns
│   ├── RESEARCH_BRIEF_ISSUE_005.md    # Pool serialization
│   └── PHASE1_IMPLEMENTATION_PLAN.md  # This document
├── src/
│   ├── index.ts                       # Plugin entry point
│   ├── types.ts                       # TypeScript interfaces
│   ├── config.ts                      # Configuration schema
│   ├── router.ts                      # Context router
│   ├── state-machine.ts               # State machine + transitions
│   ├── summary-generator.ts           # Hand-off summaries
│   ├── persistence.ts                 # ctx.storage I/O
│   ├── redaction.ts                   # Secret redaction
│   ├── test-detector.ts               # Test command patterns
│   ├── token-tracker.ts               # Token counting
│   ├── validation.ts                  # Metrics collection
│   └── pools/
│       ├── manager.ts                 # Pool CRUD operations
│       ├── global.ts                  # Global pool logic
│       ├── planning.ts                # Planning pool logic
│       ├── execution.ts               # Execution pool logic
│       └── testing.ts                 # Testing pool logic
├── tests/
│   ├── unit/
│   │   ├── router.test.ts
│   │   ├── state-machine.test.ts
│   │   ├── summary.test.ts
│   │   ├── persistence.test.ts
│   │   ├── redaction.test.ts
│   │   ├── detector.test.ts
│   │   ├── token-tracker.test.ts
│   │   └── eviction.test.ts
│   ├── integration/
│   │   ├── pool-swap.test.ts
│   │   ├── persistence.test.ts
│   │   └── auto-transition.test.ts
│   └── validation/
│       ├── pass1-benchmark.ts
│       └── hallucination-detector.ts
├── tools/
│   └── validate-session.ts            # CLI validation tool
├── package.json
├── tsconfig.json
├── bunfig.toml                        # Bun configuration
└── README.md                          # Plugin documentation
```

---

## 8. RISKS AND MITIGATIONS

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OpenCode V2 API changes | Medium | High | Pin to `@opencode/plugin@^2.1.1`, monitor releases, maintain compatibility layer |
| Performance overhead from hooks | Low | Medium | Optimize token counting (cache results), use efficient data structures (Maps, Sets) |
| Race conditions in state transitions | Medium | High | Use atomic state updates, lock during transitions, queue concurrent commands |
| Memory leaks from pool retention | Medium | Medium | Implement proper cleanup on COMPLETE, garbage collect old pools, monitor heap |
| False positives in test detection | Low | Medium | Configurable patterns, opt-out per-project, manual override via `/transition` |
| Secret redaction failures | Medium | High | Defense in depth (multiple patterns), user opt-out of persistence, file permissions |
| Cross-project pool leakage | Low | High | Validate project ID on restore, use `ctx.location.project.id` consistently |

---

## 9. NEXT STEPS

1. **Create GitHub Issue:** Split this plan into individual implementation issues
2. **Set Up Project:** Initialize TypeScript project, install dependencies
3. **Begin Implementation:** Start with Task 1.1 (Project Setup)
4. **Weekly Checkpoints:** Review progress against milestones
5. **Validation:** Run benchmark tests at Week 4 end

---

## 10. REFERENCES

- [Research Brief #1](./RESEARCH_BRIEF_ISSUE_001.md) - Original architecture specification
- [Research Brief #3](./RESEARCH_BRIEF_ISSUE_003.md) - Test command patterns
- [Research Brief #5](./RESEARCH_BRIEF_ISSUE_005.md) - Pool serialization format
- [Wayfinder Map #2](https://github.com/seppaleinen/ctx-lifecycle/issues/2) - Decision tracker
- [OpenCode V2 Plugin Docs](https://opencode.ai/v2/docs/build/plugins) - Plugin API reference
- [OpenCode V2 Server API](https://opencode.ai/v2/docs/build/plugins/server) - Hook registration

---

**Status:** Ready for implementation handoff  
**Next Owner:** devops-team-lead (plugin infrastructure) → dev-team-lead (context management logic)
