# Context-Pager Plugin: Local Testing Plan

**Last updated:** November 3, 2026  
**Plugin location:** `/Users/seppa/workspace/ctx-lifecycle`  
**Status:** Local development plugin only (not published to npm)

---

## Overview

This document describes how to test the context-pager OpenCode V2 plugin locally before publishing. The plugin is loaded from a local path, not from npm.

---

## 1. Local Setup

### 1.1 Build the Plugin

Before testing, build the plugin:

```bash
cd /Users/seppa/workspace/ctx-lifecycle
bun run build
```

**What this does:**
- Bundles the plugin with Bun's bundler into `dist/index.js` (~650KB)
- Includes `@opencode/plugin` as an inline dependency (no external imports needed)
- The output is a self-contained ESM module that OpenCode can load

**Verify the build succeeded:**

```bash
ls -la dist/index.js
# Should show the compiled bundle
```

### 1.2 Enable the Plugin in OpenCode

Add the plugin to your **global** OpenCode config at `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/Users/seppa/workspace/ctx-lifecycle"
  ]
}
```

**How OpenCode loads local plugins:**
1. OpenCode checks for a `package.json` in the directory
2. If `exports` field exists, it uses that to find the entry point
3. Otherwise, it falls back to `index.ts`/`index.js`/`server.ts` at the root
4. The `package.json` must have `"type": "module"` for ESM

**Required package.json structure:**

The plugin's `package.json` already includes the required fields:

```jsonc
{
  "name": "ctx-lifecycle",
  "exports": {
    ".": "./dist/index.js"
  },
  "type": "module"
}
```

**Important notes:**
- The path must be a **directory**, not a file (OpenCode skips file paths)
- Use the **absolute path** to avoid resolution issues
- Relative paths resolve from the config file location

**Alternative: Project-local config**

If you want to test only in a specific project, create `.opencode/opencode.jsonc` in that project's root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/Users/seppa/workspace/ctx-lifecycle"
  ]
}
```

**Alternative: Discovery via `.opencode/plugins/`**

OpenCode also auto-discovers plugins from `.opencode/plugins/` directories:

```bash
mkdir -p .opencode/plugins/context-pager
ln -s /Users/seppa/workspace/ctx-lifecycle .opencode/plugins/context-pager
```

No config entry needed — it loads automatically.

### 1.3 Plugin Configuration (Optional)

The plugin accepts optional configuration via the object form:

```jsonc
{
  "plugins": [
    {
      "package": "/Users/seppa/workspace/ctx-lifecycle",
      "options": {
        "enabled": true,
        "tokenCeiling": 25000,
        "pools": {
          "global": { "maxTokens": 5000, "compactAt": 3750 },
          "project": { "maxTokens": 3000, "compactAt": 2250 }
        },
        "retention": {
          "enabled": true,
          "maxItems": 10,
          "confidenceFloor": 0.4,
          "evictSourcePool": true
        }
      }
    }
  ]
}
```

If no options are provided, the plugin uses `DEFAULT_CONFIG` from `src/types.ts`.

---

## 2. Development Loop

### 2.1 Edit → Rebuild → Test Workflow

1. **Make changes** to source files in `src/`

2. **Rebuild the plugin:**
   ```bash
   cd /Users/seppa/workspace/ctx-lifecycle
   bun run build
   ```

3. **Reload OpenCode:**
   - **TUI:** Press `Ctrl+C` to exit, then restart with `opencode`
   - **Desktop:** Use the **Reload** button in **Settings > Extensions > Plugins**
   - **CLI:** Run `opencode service restart` (if using `opencode serve`)

   **Note:** Changes to watched config directories (like `~/.config/opencode/plugins/`) reload automatically. Since the plugin is loaded from an external path, a manual restart is required.

4. **Test the changes** by starting a new session or using the plugin's commands

### 2.2 Quick Verification After Rebuild

After rebuilding, verify the plugin is loaded:

```bash
opencode plugin list
# Should show context-pager in the list
```

Or check the OpenCode logs (see §4.1).

---

## 3. Verification: Confirming the Plugin Works

### 3.1 Check Commands Appear

The plugin registers two slash commands:

- `/transition` — Transition the state machine
- `/new-issue` — Clear project-scoped context

**Test:**

```
/transition
```

You should see autocomplete suggestions for:
- `/transition planning`
- `/transition coding`
- `/transition debugging`
- `/transition complete`

If the commands don't appear:
1. Check that the build succeeded (`dist/index.js` exists)
2. Verify the plugin path in `opencode.json` is correct
3. Restart OpenCode completely

### 3.2 Verify the Context Hook Fires

The plugin's `ctx.session.hook('context', ...)` fires on every model request. To verify it's working:

1. **Enable debug logging** (see §4.1)
2. **Start a conversation** and watch for log lines like:
   ```
   [context-pager] Transition: PLANNING -> CODING (/transition coding)
   ```
3. **Check pool sizes** by observing the context length (should stay within configured ceilings)

### 3.3 Test State Transitions

**Manual transition test:**

```
/transition coding
```

Expected behavior:
- Console log: `[context-pager] Transition: PLANNING -> CODING (/transition coding)`
- The active pool changes from Planning to Execution
- Retained context (if enabled) is carried over

**Auto-transition test:**

While in the `CODING` state, run a test command:

```bash
bun test
# or
pytest tests/
# or
npm test
```

Expected behavior:
- The plugin detects the test command via the `tool.execute.before` hook
- Auto-transitions to `DEBUGGING` state
- Console log: `[context-pager] Transition: CODING -> DEBUGGING (Test command detected: bun test)`

### 3.4 Verify Auto-Compact Triggers

The plugin auto-compacts the Global and Project pools when they exceed the `compactAt` threshold (default: 75% of `maxTokens`).

**Test:**

1. Have a long conversation that accumulates context
2. Watch for log lines:
   ```
   [context-pager] Auto-compacted global Pool: 15 messages removed
   ```
3. Verify the pool size stays under the ceiling

**Note:** Compaction runs asynchronously via `setImmediate()` to keep the context hook synchronous.

---

## 4. Debugging

### 4.1 Log Locations

**Primary log file:**
```
~/.local/share/opencode/log/opencode.log
```

**Enable debug logging:**

Set the environment variable before starting OpenCode:

```bash
OPENCODE_LOG_LEVEL=debug opencode
```

Or add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export OPENCODE_LOG_LEVEL=debug
```

**What to look for:**

```
[context-pager] Plugin loaded
[context-pager] Transition: PLANNING -> CODING (/transition coding)
[context-pager] Auto-compacted global Pool: 15 messages removed
[context-pager] Cleared Project pool (new issue)
```

### 4.2 Common Issues

#### Issue: Plugin not loading

**Symptoms:**
- Commands don't appear in autocomplete
- No log lines from context-pager

**Troubleshooting:**
1. Verify the path in `opencode.json` is correct and absolute
2. Ensure `dist/index.js` exists (run `bun run build`)
3. Verify `package.json` has the required exports:
   ```json
   {
     "name": "ctx-lifecycle",
     "type": "module",
     "exports": {
       ".": "./dist/index.js"
     }
   }
   ```
4. Check the OpenCode log for plugin load messages
5. Restart OpenCode completely

#### Issue: Auto-transition not firing

**Symptoms:**
- Test commands run but state doesn't change
- No transition log lines

**Troubleshooting:**
1. Verify you're in the `CODING` state (auto-transition only fires from CODING)
2. Check the regex in `src/index.ts` matches your test command:
   ```ts
   /(pytest|vitest|jest|pnpm\s+test|npm\s+test|go\s+test|cargo\s+test)/
   ```
3. Add your test command pattern if needed

#### Issue: Pool sizes growing unbounded

**Symptoms:**
- Context length keeps increasing
- No compaction log lines

**Troubleshooting:**
1. Verify `pools.global.maxTokens` and `pools.project.maxTokens` are set
2. Check that `enforceCeiling()` is being called in the context hook
3. Ensure messages are not flagged `critical: true` (critical messages are never evicted)

### 4.3 Plugin Lifecycle Events

The plugin logs events at key lifecycle points:

| Event | Log Line |
|-------|----------|
| Plugin loaded | `[context-pager] Plugin loaded` (if added) |
| State transition | `[context-pager] Transition: <from> -> <to> (<trigger>)` |
| Auto-compact | `[context-pager] Auto-compacted <pool> Pool: <n> messages removed` |
| Project pool cleared | `[context-pager] Cleared Project pool (new issue)` |
| Hook fired | (no log, but context messages are modified) |

---

## 5. Disabling the Plugin

### 5.1 Temporary Disable (Config)

Prefix the plugin ID with `-` in `opencode.json`:

```jsonc
{
  "plugins": [
    "-/Users/seppa/workspace/ctx-lifecycle"
  ]
}
```

Or use a wildcard to disable all plugins:

```jsonc
{
  "plugins": ["*"]
}
```

### 5.2 Remove from Config

Delete the plugin entry from `opencode.json`:

```jsonc
{
  "plugins": [
    // Remove the ctx-lifecycle line
  ]
}
```

### 5.2 Disable via Options Object

OpenCode requires a plugin **name** (not a path) for the `-` prefix to work. Use the object form to disable:

```jsonc
{
  "plugins": [
    {
      "package": "/Users/seppa/workspace/ctx-lifecycle",
      "options": { "enabled": false }
    }
  ]
}
```

### 5.3 Remove from Config

Delete the plugin entry from your config:

```jsonc
{
  "plugins": [
    // Remove the ctx-lifecycle entry
  ]
}
```

Or simply restart OpenCode after removing the config file.

### 5.4 Verify Disabled

After disabling:
- Commands (`/transition`, `/new-issue`) should not appear
- No `[context-pager]` log lines
- Context length is managed by OpenCode's built-in compaction only

---

## 6. Effectiveness Testing

### 6.1 Verify Pool Management

**Test pool isolation:**

1. Start in `PLANNING` state
2. Add context (have a conversation about planning)
3. Transition to `CODING`:
   ```
   /transition coding
   ```
4. Verify Planning pool messages are evicted (if `retention.evictSourcePool: true`)
5. Verify Global pool messages persist

**Expected pool behavior:**

| State | Active Pools |
|-------|--------------|
| PLANNING | Global + Project + Planning |
| CODING | Global + Project + Execution |
| DEBUGGING | Global + Project + Testing |
| COMPLETE | Global + Project + Planning |

### 6.2 Verify Compaction Triggers

**Manual test:**

1. Set a low `compactAt` threshold in config:
   ```jsonc
   {
     "plugins": [{
       "package": "/Users/seppa/workspace/ctx-lifecycle",
       "options": {
         "pools": {
           "global": { "maxTokens": 1000, "compactAt": 500 }
         }
       }
     }]
   }
   ```

2. Have a conversation that accumulates >500 tokens in the Global pool
3. Watch for auto-compact log lines
4. Verify the pool size drops after compaction

### 6.3 Verify Retention (Context Carry-Over)

**Test:**

1. In `PLANNING` state, establish key requirements:
   ```
   The system must handle 10k requests/second.
   Use SQLite for storage, not Postgres.
   ```

2. Transition to `CODING`:
   ```
   /transition coding
   ```

3. Check that a "Context retained from Planning Pool:" message appears with:
   ```
   [REQUIREMENT] The system must handle 10k requests/second.
   [ARCHITECTURE] Decision: SQLite for storage, not Postgres.
   ```

**Configuration:**

Retention is controlled by `retention.enabled` (default: `true`). To disable:

```jsonc
{
  "plugins": [{
    "package": "/Users/seppa/workspace/ctx-lifecycle",
    "options": {
      "retention": { "enabled": false }
    }
  }]
}
```

### 6.4 Verify SQLite Episodes (Phase 3 Memory)

If Phase 3 memory is enabled (`memory.enabled: true`):

1. Enable memory in config:
   ```jsonc
   {
     "plugins": [{
       "package": "/Users/seppa/workspace/ctx-lifecycle",
       "options": {
         "memory": { "enabled": true }
       }
     }]
   }
   ```

2. Have a conversation with multiple state transitions
3. Check the SQLite database:
   ```bash
   sqlite3 ~/Library/Application\ Support/opencode/storage/plugin/context-pager/memory.db
   > SELECT * FROM episodes ORDER BY ts DESC LIMIT 10;
   ```

4. Verify episodes are recorded with correct pool, state, and category

---

## 7. Testing Checklist

Before publishing, verify:

- [ ] Plugin builds without errors (`bun run build`)
- [ ] Plugin loads in OpenCode (commands appear)
- [ ] `/transition` command works for all states
- [ ] `/new-issue` command clears Project pool
- [ ] Auto-transition fires on test commands (from CODING state)
- [ ] Auto-compact triggers at threshold
- [ ] Retention carries over key context on transitions
- [ ] LRU eviction works for Global/Project pools
- [ ] Critical messages are never evicted
- [ ] Logs appear in `~/.local/share/opencode/log/opencode.log`
- [ ] Plugin can be disabled via config
- [ ] Development loop (edit → rebuild → reload) works smoothly

---

## 8. Reference

### 8.1 File Structure

```
/Users/seppa/workspace/ctx-lifecycle/
├── src/
│   ├── index.ts              # Plugin entry point, hook registration
│   ├── types.ts              # Types, DEFAULT_CONFIG, mergeConfig()
│   ├── router.ts             # ContextRouter, pool management
│   ├── state-machine.ts      # State machine, transition logic
│   ├── summary-generator.ts  # Summary generation, retention extraction
│   └── config.ts             # Token estimation, compact summary generation
├── dist/
│   └── index.js              # Built output (from bun build)
├── tests/
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   └── manual-verification.ts # Manual verification script
├── package.json              # Build scripts, dependencies
├── tsconfig.json             # TypeScript config
└── docs/
    └── TESTING-PLAN.md       # This document
```

### 8.2 Key Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build plugin to `dist/` |
| `bun test` | Run all tests |
| `bun test tests/unit/` | Run unit tests only |
| `bun test tests/integration/` | Run integration tests only |
| `bunx eslint src/ tests/` | Lint code |
| `tsc --noEmit` | Type check |
| `bun run verify` | Run lint, typecheck, tests, and build |

### 8.3 Configuration Reference

**Default config** (from `src/types.ts`):

```ts
export const DEFAULT_CONFIG: ContextPagerConfig = {
  enabled: true,
  tokenCeiling: 25000,
  pools: {
    global: { maxTokens: 5000, compactAt: 3750 },
    project: { maxTokens: 3000, compactAt: 2250 },
    planning: { maxTokens: 8000 },
    execution: { maxTokens: 10000 },
    testing: { maxTokens: 5000 }
  },
  retention: {
    enabled: true,
    categories: [
      RetainedItemCategory.REQUIREMENT,
      RetainedItemCategory.ARCHITECTURE,
      RetainedItemCategory.RESEARCH,
      RetainedItemCategory.ACCEPTANCE
    ],
    maxItems: 10,
    confidenceFloor: 0.4,
    evictSourcePool: true
  },
  memory: {
    enabled: false,
    dbPath: '~/Library/Application Support/opencode/storage/plugin/context-pager/memory.db',
    recallBudgetTokens: 1500,
    recallTopK: 8,
    journal: { archiveBeforeEvict: true },
    worker: {
      llmSummaries: true,
      consolidateEvery: 40
    },
    vector: 'off',
    archiveAfterDays: 30,
    purgeAfterDays: 90
  }
};
```

### 8.4 External Resources

- [OpenCode V2 Plugins Guide](https://opencode.ai/v2/docs/build/plugins/)
- [OpenCode Config Schema](https://opencode.ai/config.json)
- [OpenCode Plugin Development Guide](https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715)

---

## 9. Next Steps

After local testing is complete:

1. **Publish to npm** (tracked in issue #20)
2. **Update documentation** with npm installation instructions
3. **Add integration tests** for Phase 3 memory features
4. **Consider a test harness** for automated plugin testing

---

**Maintainer:** @seppa  
**Repository:** `/Users/seppa/workspace/ctx-lifecycle`