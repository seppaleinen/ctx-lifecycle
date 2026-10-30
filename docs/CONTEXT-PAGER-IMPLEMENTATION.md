# Context-Pager Implementation Guide

## Overview

context-pager is an OpenCode V2 plugin that manages context lifecycles via four isolated domain pools (Global, Planning, Execution, Testing) and a state machine with explicit `/transition` commands.

---

## Architecture

### Component Map

| Component | File | Responsibility |
|-----------|------|----------------|
| Plugin Entry | `src/index.ts` | V2 plugin definition, hook registration, command handler |
| Type Definitions | `src/types.ts` | PoolID, StateMachineState, ContextMessage, ContextPool, config |
| Context Router | `src/router.ts` | Pool management, `getActivePools()`, `addMessage()` |
| State Machine | `src/state-machine.ts` | Transition matrix, `/transition` parsing, state validation |
| Summary Generator | `src/summary-generator.ts` | 1-sentence hand-off summaries, format validation |

### Pool Architecture

```
Global Pool (immutable)
├── System invariants
├── Types and schemas
└── Always included in every state

Planning Pool (STATE: PLANNING)
├── Research and design
├── Contracts and specs
└── Active when state = PLANNING

Execution Pool (STATE: CODING)
├── Active code changes
├── Diffs and edits
└── Active when state = CODING

Testing Pool (STATE: DEBUGGING)
├── Test output
├── Failures
└── Active when state = DEBUGGING
```

### State Machine

```
[PLANNING] ──(/transition coding)──► [CODING]
   ▲                              │   │
   │                              │   │ (/transition debugging)
   │                              │   ▼
   └──(/transition planning)── [DEBUGGING] ──(/transition complete)──► [COMPLETE]
                                   ▲              │
                                   │              │ (/transition planning)
                                   └──────────────┘
```

**Transition Matrix:**

| From | Allowed To |
|------|-----------|
| PLANNING | CODING |
| CODING | PLANNING, DEBUGGING |
| DEBUGGING | COMPLETE, PLANNING |
| COMPLETE | PLANNING |

---

## Data Flow

### 1. Context Interception

`ctx.session.hook("context", ...)` fires before each model request. The router returns messages from the Global pool plus the pool mapped to the current state. Messages are converted from `ContextMessage` to OpenCode `Message` instances via `Message.system()`, `Message.user()`, `Message.assistant()`.

### 2. Tool Execution

`ctx.tool.hook("execute.before", ...)` intercepts bash commands. When a test command is detected (pytest, vitest, jest, pnpm test, npm test, go test, cargo test) and the current state is CODING, the state machine auto-transitions to DEBUGGING and a summary is appended to the Testing pool.

### 3. Explicit Transition

`/transition <state>` command parsed by `StateMachine.parseTransitionCommand()`. On valid transition, the state machine updates state and the summary generator produces a hand-off summary appended to the target pool.

---

## Usage

### Commands

```bash
/transition planning    # Switch to Planning pool
/transition coding      # Switch to Execution pool
/transition debugging   # Switch to Testing pool (also auto-triggered by test commands)
/transition complete    # Mark task complete (Testing pool discarded)
```

### State-to-Pool Mapping

| State | Active Pool | Notes |
|-------|------------|-------|
| PLANNING | Planning | Research, design, contracts |
| CODING | Execution | Active code changes |
| DEBUGGING | Testing | Test output, failures |
| COMPLETE | Planning | Testing pool emptied on entry |

The Global pool is always included regardless of state.

---

## Type Definitions

```typescript
enum PoolID {
  GLOBAL = 'global',
  PLANNING = 'planning',
  EXECUTION = 'execution',
  TESTING = 'testing'
}

enum StateMachineState {
  PLANNING = 'planning',
  CODING = 'coding',
  DEBUGGING = 'debugging',
  COMPLETE = 'complete'
}

interface ContextMessage {
  id?: string;          // Optional — OpenCode assigns at SDK boundary
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt?: number;
}

interface ContextPool {
  id: PoolID;
  messages: ContextMessage[];
}

const STATE_TO_POOL: Record<string, PoolID> = {
  [PLANNING]: PoolID.PLANNING,
  [CODING]: PoolID.EXECUTION,
  [DEBUGGING]: PoolID.TESTING,
  [COMPLETE]: PoolID.PLANNING  // Testing pool discarded on COMPLETE
};
```

---

## Testing

### Unit Tests (26 tests, all passing)

| Test File | Coverage |
|-----------|----------|
| `tests/unit/router.test.ts` | Pool operations, isolation, getActivePools |
| `tests/unit/state-machine.test.ts` | Transition matrix, invalid transitions, command parsing |
| `tests/unit/summary.test.ts` | Summary generation, 1-sentence limit, prohibited content |

### Running Tests

```bash
bun test tests/unit/
```

### Type Checking

```bash
tsc --noEmit
```

---

## Configuration

Default config (`DEFAULT_CONFIG`):

```typescript
{
  enabled: true,
  tokenCeiling: 25000,
  pools: {
    global: { maxTokens: 5000 },
    planning: { maxTokens: 8000 },
    execution: { maxTokens: 10000 },
    testing: { maxTokens: 5000 }
  }
}
```

---

## Build

```bash
bun build src/index.ts --outdir=dist --target=bun
```