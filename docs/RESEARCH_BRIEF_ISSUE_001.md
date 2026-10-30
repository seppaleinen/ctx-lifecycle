# Research Brief: context-pager Architectural Implementation

**Task:** Implement context-pager middleware for OpenCode agent harness  
**Domain:** devops (OpenCode plugin development)  
**Issue:** [seppaleinen/ctx-lifecycle#1](https://github.com/seppaleinen/ctx-lifecycle/issues/1)  
**Date:** Friday, October 30, 2026  
**Author:** Researcher (subagent)

---

## 1. EXECUTIVE SUMMARY

The `context-pager` is an **event-driven context lifecycle middleware** for OpenCode designed to solve the "Lost in the Middle" problem. Current agent harnesses treat conversation context as a monotonically growing, append-only log, leading to:
- Severe context degradation over multi-hour sessions
- Context poisoning from stale information
- Unnecessary token expense

The solution replaces monolithic context with **issue-scoped eviction** and **phase-driven context pool paging** to maintain a flat token ceiling (15k-25k tokens) without losing critical system invariants.

---

## 2. REFINED REQUIREMENTS

### 2.1 Objective
Build a TypeScript OpenCode V2 plugin that intercepts model requests and manages four distinct context pools through a state machine, triggered by tool calls and harness state transitions.

### 2.2 Scope
- **In Scope:**
  - Plugin infrastructure using OpenCode V2 API (`@opencode/plugin`)
  - Context router with four pools (Global, Planning, Execution, Testing)
  - Event-driven pool swapping on tool execution
  - State machine for context lifecycle management
  - Token tracking and ceiling enforcement
  - Hand-off summaries for narrative continuity

- **Out of Scope:**
  - Phase 3 features (async background summarization, vector DB offloading)
  - MCP server integration (future phase)
  - Cross-harness compatibility (OpenCode-only for now)

### 2.3 Definition of Done
- [ ] Plugin loads successfully in OpenCode V2
- [ ] Intercepts `session.request` hook to modify messages before model dispatch
- [ ] Maintains four isolated context pools with proper eviction rules
- [ ] Automatically swaps pools on test execution (`execute_bash` with test commands)
- [ ] Preserves system invariants in Global Pool (never evicted)
- [ ] Generates hand-off summaries on pool transitions
- [ ] Token ceiling remains flat at 15k-25k over long sessions
- [ ] Zero stale-symbol hallucinations in validation
- [ ] Pass@1 success rate improvement demonstrated

---

## 3. WEB FINDINGS

### 3.1 OpenCode Plugin System

**Official Documentation:**
- [OpenCode V2 Plugins Documentation](https://opencode.ai/v2/docs/build/plugins)
- [Server Plugin API](https://opencode.ai/v2/docs/build/plugins/server)
- [Runtime Hooks Reference](https://opencode.ai/v2/docs/build/plugins#runtime-hooks)

**Key Capabilities:**
1. **Plugin Structure:** TypeScript/ESM modules with `Plugin.define({ id, setup })`
2. **Runtime Hooks:** Can intercept live operations via domain-specific hooks
3. **Session Hooks:** `ctx.session.hook("request", callback)` - modifies `system`, `messages`, `tools` before model dispatch
4. **Tool Hooks:** `ctx.tool.hook("execute.before", callback)` - intercepts tool input
5. **Message Events:** `message.updated`, `message.removed`, `message.part.updated`

**Critical Hook for context-pager:**
```typescript
ctx.session.hook("request", (event) => {
  // Modify event.messages, event.system, event.tools
  // This is where context-pager will swap pools
})
```

### 3.2 Existing Middleware Patterns

**opencode-middleware (s-ajensen):**
- [GitHub Repository](https://github.com/s-ajensen/opencode-middleware)
- [npm Package](https://www.npmjs.com/package/opencode-middleware)
- **Pattern:** Wraps subagent task execution with before/after hooks
- **Relevance:** Demonstrates middleware registration and agent-scoped middleware
- **Limitation:** Focuses on subagent tasks, not context message management

**opencode-interceptor (cortexkit):**
- [GitHub Repository](https://github.com/cortexkit/opencode-interceptor)
- **Pattern:** HTTP interception for LLM provider traffic
- **Relevance:** Shows request/response capture patterns
- **Limitation:** Works at HTTP level, not message context level

### 3.3 Context Management Approaches

**Rulvar Workflows:**
- Uses `ctx.brief()` for journaled summarization
- Compact artifacts between phases
- Replanning as plain code (auditable TypeScript)
- **Relevance:** Inspiration for hand-off summaries and phase transitions

**CTX (Context as Code):**
- Structured context documents from various sources
- Modifiers for optimization (extract signatures, filter content)
- **Relevance:** Context generation and transformation patterns

### 3.4 State Machine Implementation Options

**Recommended:** Custom state machine using TypeScript enums and transition matrix
- Simple, deterministic, no external dependencies
- Matches the specification's state diagram exactly

**Alternative:** XState library
- More features (guards, actions, delayed transitions)
- Adds ~20KB dependency
- **Decision:** Not needed for Phase 1-2 complexity

---

## 4. APP SOURCE FINDINGS

### 4.1 Repository Structure
```
ctx-lifecycle/
├── LICENSE          # MIT License, Copyright 2026 David Eriksson
├── README.md        # Brief description of middleware extension
└── .git/
```

**Current State:** Empty repository with only LICENSE and README. This is a greenfield implementation.

### 4.2 Conventions to Establish

Based on OpenCode plugin best practices:

```
ctx-lifecycle/
├── src/
│   ├── index.ts              # Plugin entry point
│   ├── router.ts             # Context router with state machine
│   ├── pools/
│   │   ├── global.ts         # Global pool management
│   │   ├── planning.ts        # Planning pool management
│   │   ├── execution.ts       # Execution pool management
│   │   └── testing.ts         # Testing pool management
│   ├── types.ts              # TypeScript interfaces
│   └── constants.ts          # Configuration constants
├── tests/
│   ├── unit/
│   └── integration/
├── .opencode/
│   └── opencode.jsonc        # Plugin configuration
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. INFRA FINDINGS

### 5.1 OpenCode V2 Plugin Requirements

**Dependencies:**
- `@opencode/plugin`: ^2.1.1 (V2 API)
- Runtime: Bun (OpenCode's runtime)
- TypeScript: Supported natively (Bun compiles at runtime)

**Configuration:**
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./src/index.ts"  // or compiled path
  ]
}
```

**Loading:**
- Local plugins: `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global)
- Plugin must export `Plugin.define({ id, setup })`

### 5.2 Development Environment

**Recommended Setup:**
```bash
# Install dependencies
bun install

# Development
bun run dev  # Watch mode

# Build
bun run build  # Compile to dist/

# Test in OpenCode
opencode --config .opencode/opencode.jsonc
```

### 5.3 Deployment

**Options:**
1. **Local Development:** Symlink or direct file reference
2. **npm Package:** Publish to npm for distribution
3. **Git Reference:** Load directly from GitHub

**Recommended for Phase 1:** Local development with file reference

---

## 6. ARCHITECTURAL DESIGN

### 6.1 Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Server                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │   User Session  │───▶│  context-pager  │                │
│  │   (Messages)    │    │   Plugin        │                │
│  └─────────────────┘    └────────┬────────┘                │
│                                       │                        │
│                  ┌────────────────────┼─────────────────┐   │
│                  │                    │                 │   │
│                  ▼                    ▼                 ▼   │
│         ┌─────────────┐    ┌─────────────┐   ┌───────────┐ │
│         │ Global Pool  │    │Planning Pool│   │Execution  │ │
│         │ (Pinned)     │    │             │   │Pool       │ │
│         └─────────────┘    └─────────────┘   └───────────┘ │
│                                                      │         │
│                                              ┌───────┴───────┐ │
│                                              │ Testing Pool │ │
│                                              └─────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    State Machine                       ││
│  │  [PLANNING] ──(File Read)──► [CODING] ──(Run Tests)──►  ││
│  │       ▲                    │                    │        ││
│  │       │                    │                    ▼        ││
│  │  (Task Switch)       (Task Switch)           [DEBUGGING]││
│  │       │                    │                    │        ││
│  │       └────────────────────┴────────────────────┘        ││
│  │                              │                         ││
│  │                         [COMPLETE] ◄─────────────────────┘│
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 6.2 State Machine Rules

| Current State | Trigger | Next State | Pool Action |
|---------------|---------|------------|-------------|
| PLANNING | File Read / Diff Edit | CODING | Load Execution Pool |
| CODING | Run Tests (execute_bash) | DEBUGGING | Load Testing Pool |
| DEBUGGING | Tests Pass / Commit | COMPLETE | Unload Testing Pool |
| DEBUGGING | Task Switch | PLANNING | Unload Testing + Execution |
| CODING | Task Switch | PLANNING | Unload Execution |
| COMPLETE | New Task | PLANNING | Reset all pools |

### 6.3 Context Pool Definitions

```typescript
interface ContextPool {
  id: PoolID
  messages: Message[]
  maxTokens: number
  evictionPolicy: EvictionPolicy
  immutable: boolean  // Global pool: true, others: false
}

enum PoolID {
  GLOBAL = 'global',
  PLANNING = 'planning',
  EXECUTION = 'execution',
  TESTING = 'testing'
}

// Eviction Rules
const EVICITION_MATRIX = {
  [PoolID.GLOBAL]: { evictable: false, onEvict: 'error' },
  [PoolID.PLANNING]: { evictable: true, onEvict: 'summarize' },
  [PoolID.EXECUTION]: { evictable: true, onEvict: 'discard' },
  [PoolID.TESTING]: { evictable: true, onEvict: 'discard' }
}
```

### 6.4 Token Tracking

```typescript
interface TokenTracker {
  currentTokens: number
  ceiling: number  // 15000-25000
  poolTokenCounts: Record<PoolID, number>
  
  addMessage(pool: PoolID, message: Message): void
  removeMessage(pool: PoolID, messageID: string): void
  getPoolTokens(pool: PoolID): number
  enforceCeiling(): boolean
}
```

---

## 7. IMPLEMENTATION PLAN

### 7.1 Phase 1: Foundation (MVP)

**Goal:** Basic context pool management with manual switching

**Tasks:**
1. [ ] Set up TypeScript project structure
2. [ ] Create plugin entry point with `Plugin.define`
3. [ ] Implement `ContextRouter` class with four pools
4. [ ] Implement basic state machine (PLANNING ↔ CODING)
5. [ ] Register `session.request` hook for message interception
6. [ ] Add token counting utility
7. [ ] Create hand-off summary generator
8. [ ] Write unit tests for pool management

**Deliverables:**
- Working plugin that loads in OpenCode
- Manual pool switching via commands
- Token tracking dashboard

### 7.2 Phase 2: Event-Driven Automation

**Goal:** Automatic pool swapping based on tool execution

**Tasks:**
1. [ ] Implement tool execution detector (identify test commands)
2. [ ] Register `tool.execute.before` hook for trigger detection
3. [ ] Implement automatic state transitions
4. [ ] Add pool eviction logic per EVICITION_MATRIX
5. [ ] Implement hand-off summary generation on transitions
6. [ ] Add configuration for test command patterns
7. [ ] Write integration tests

**Deliverables:**
- Automatic pool swapping on test execution
- Proper eviction with summaries
- Configurable test patterns

### 7.3 Phase 3: Advanced Features (Future)

**Goal:** Async background summarization and vector DB offloading

**Tasks:**
1. [ ] Implement background summarization worker
2. [ ] Add vector DB integration (optional, local-only)
3. [ ] Implement episodic memory for long-term context
4. [ ] Add compaction strategies for old pools
5. [ ] Performance optimization

---

## 8. OPEN QUESTIONS ANSWERED

### 8.1 Q: How does OpenCode's plugin system allow message interception?
**A:** Via `ctx.session.hook("request", callback)` which provides mutable access to `event.messages`, `event.system`, and `event.tools` immediately before model dispatch. This is the primary hook for context-pager.

### 8.2 Q: Can we detect when tests are being run?
**A:** Yes, via `ctx.tool.hook("execute.before", callback)`. We can inspect `event.tool` and `event.input` to detect test commands (pytest, go test, npm test, etc.).

### 8.3 Q: How do we prevent eviction of critical system invariants?
**A:** The Global Pool is marked as `immutable: true` and will never be evicted. System instructions, global types, and schema contracts are stored here.

### 8.4 Q: How do we maintain narrative continuity during pool switches?
**A:** Hand-off summaries are generated as 1-sentence messages appended to the active pool: "Swapped to Testing Pool. Modified auth.ts and db.ts"

### 8.5 Q: What's the difference between V1 and V2 plugin APIs?
**A:** V1 uses string-keyed hook returns. V2 uses domain-specific hook registration (`ctx.session.hook`, `ctx.tool.hook`). We must use V2 API for runtime hooks.

---

## 9. REMAINING RISKS & UNKNOWN

### 9.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OpenCode V2 API changes | Medium | High | Pin to specific version, monitor releases |
| Performance overhead from message interception | Low | Medium | Optimize token counting, use efficient data structures |
| State machine race conditions | Medium | High | Use atomic state transitions, proper locking |
| Memory leaks from pool retention | Medium | Medium | Implement proper cleanup, garbage collection |
| Plugin conflicts with other plugins | Low | Medium | Use unique plugin ID, test with common plugins |

### 9.2 Unknowns

1. **Token Counting Accuracy:** Need to verify if OpenCode provides token counting utilities or if we need to implement our own (using tiktoken or similar).

2. **Message Serialization:** Need to confirm the exact structure of `event.messages` in the `session.request` hook to properly manipulate them.

3. **Pool Persistence:** Need to determine if pools should persist across session restarts or be session-scoped only.

4. **Conflict Resolution:** Need to define behavior when multiple plugins try to modify messages simultaneously.

5. **Error Handling:** Need to define recovery strategy if pool swapping fails mid-transition.

### 9.3 Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| `@opencode/plugin` | V2 Plugin API | Required |
| `tiktoken` | Token counting | Optional (can use OpenCode's utilities) |
| `zod` | Schema validation | Optional (built into OpenCode) |

---

## 10. RECOMMENDED NEXT STEPS

### 10.1 Immediate Actions

1. **Set up development environment**
   ```bash
   mkdir -p src pools tests
   bun init -y
   bun add @opencode/plugin
   ```

2. **Create plugin skeleton**
   - Implement `src/index.ts` with `Plugin.define`
   - Set up TypeScript configuration
   - Create basic build script

3. **Implement ContextRouter**
   - Define pool interfaces
   - Create state machine
   - Implement basic pool operations

### 10.2 Validation Plan

**Test Strategy:**
1. Unit tests for pool management and state transitions
2. Integration tests with mock OpenCode context
3. Manual testing in real OpenCode sessions
4. Token ceiling validation over long sessions

**Success Metrics:**
- Token ceiling remains flat (15k-25k) over 2-hour sessions
- Zero stale-symbol hallucinations in test scenarios
- Pass@1 success rate improvement of at least 15%

### 10.3 Documentation Needs

1. **Architecture Decision Records (ADRs)**
   - ADR-001: Domain-Isolated Context Pools
   - ADR-002: Event-Driven Paging
   - ADR-003: State Machine Design

2. **User Documentation**
   - Installation guide
   - Configuration reference
   - Usage examples

3. **Developer Documentation**
   - API reference
   - Contribution guide
   - Testing strategy

---

## 11. REFERENCES

### 11.1 Official Documentation
- [OpenCode V2 Plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 Server API](https://opencode.ai/v2/docs/build/plugins/server)
- [OpenCode Plugin Package](https://www.npmjs.com/package/@opencode/plugin)

### 11.2 Related Projects
- [opencode-middleware](https://github.com/s-ajensen/opencode-middleware) - Middleware pattern reference
- [opencode-interceptor](https://github.com/cortexkit/opencode-interceptor) - HTTP interception reference
- [Rulvar Workflows](https://docs.rulvar.com/guide/workflows) - Context management inspiration
- [CTX Technical Architecture](https://github.com/diegoxtr/ctx-open/blob/main/docs/TECHNICAL_ARCHITECTURE.md) - Context as Code patterns

### 11.3 Source Material
- [GitHub Issue #1: ARCHITECTURAL BRIEF & SPECIFICATION: context-pager](https://github.com/seppaleinen/ctx-lifecycle/issues/1)

---

**File Path:** `/docs/RESEARCH_BRIEF_ISSUE_001.md`  
**Status:** Ready for pipeline lead handoff  
**Next Owner:** devops-team-lead (for plugin infrastructure) → dev-team-lead (for context management logic)
