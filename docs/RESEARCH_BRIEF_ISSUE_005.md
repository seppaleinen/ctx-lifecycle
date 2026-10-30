# Research Brief: Pool Serialization Format for Disk Persistence

**Task:** Determine serialization format and storage location for context-pager pool persistence
**Domain:** devops (OpenCode plugin development)
**Issue:** [seppaleinen/ctx-lifecycle#5](https://github.com/seppaleinen/ctx-lifecycle/issues/5)
**Date:** Friday, October 30, 2026
**Author:** Researcher (subagent)

---

## 1. EXECUTIVE SUMMARY

The context-pager plugin needs to persist message pools to disk to survive session restarts. After investigating OpenCode plugin best practices, serialization formats, storage locations, and security implications, the following recommendations are made:

**Key findings:**
1. **Use JSON serialization** — not binary — for message pools. JSON is OpenCode's native format, human-readable for debugging, and aligns with how OpenCode stores sessions/messages/parts.
2. **Store in `ctx.storage` API** — OpenCode V2's plugin-scoped durable storage — which persists under `~/.local/share/opencode/storage/plugin/<plugin-id>/` on macOS/Linux.
3. **Project-scoped persistence** — pools should be scoped to project ID to avoid cross-project context leakage.
4. **Security: avoid persisting secrets** — implement pre-storage redaction for PII/secrets, and ensure file permissions are restrictive (600).

---

## 2. REFINED REQUIREMENTS

### 2.1 Objective
Define the serialization format, storage location, and security model for persisting context pools to disk in the context-pager OpenCode V2 plugin.

### 2.2 Scope
- Serialization format: JSON vs binary (MessagePack, Protocol Buffers, etc.)
- Storage location: project `.opencode/context-pager/` vs user config dir vs `ctx.storage` API
- Security: PII/secrets handling, file permissions, access controls
- Schema design for pool data structure

### 2.3 Definition of Done
- [ ] Serialization format selected with rationale
- [ ] Storage location determined with path specification
- [ ] Security model documented (redaction, permissions, access control)
- [ ] Pool schema defined for persistence
- [ ] GitHub issue #5 updated with findings

---

## 3. WEB FINDINGS

### 3.1 OpenCode Plugin Storage Best Practices

**Official Documentation:**
- [OpenCode V2 Plugin Storage API](https://dev.opencode.ai/v2/docs/build/plugins/server#storage)
- [Plugin Migration Guide V1→V2](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1)

**Key capabilities:**
1. **`ctx.storage` API** — V2 plugins get durable JSON storage scoped to plugin ID:
   ```typescript
   await ctx.storage.set("pools/project-abc", { global: [...], planning: [...] })
   const pools = await ctx.storage.get("pools/project-abc")
   await ctx.storage.remove("pools/project-abc")
   ```

2. **Storage location** — Plugin storage is stored under:
   - **macOS/Linux:** `~/.local/share/opencode/storage/plugin/<plugin-id>/`
   - **Windows:** `%LOCALAPPDATA%\opencode\storage\plugin\<plugin-id>\`
   - Uses XDG data directory convention (`$XDG_DATA_HOME` if set)

3. **Format:** JSON (human-readable, aligns with OpenCode's session/message/part storage)

**From the `opencode-models-discovery` plugin documentation:**
> "OpenCode v2 has a separate provider-scoped cache backed by the host-provided `ctx.storage` API; it does not use these disk files or the V1 cache schema."
> "The cache is plugin-owned data. It does not replace `opencode.json`, and it does not write to OpenCode or Mimocode configuration or auth stores."

**Precedent from existing plugins:**
- `opencode-dynamic-context-pruning` (DCP) stores state in `~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json`
- `opencode-memory` plugin uses plugin-owned SQLite databases under `~/.local/share/opencode/`
- `opencode-models-discovery` uses `ctx.storage` for provider-scoped caches

### 3.2 JSON vs Binary Serialization Formats

**Research findings:**

| Format | Pros | Cons | Verdict |
|--------|------|------|---------|
| **JSON** | Human-readable, OpenCode native, no dependencies, easy debugging | Larger size, slower parse | ✅ **Recommended** |
| **MessagePack** | 20-50% smaller, 2-4× faster parse | Binary (not human-readable), adds dependency | ❌ Overkill for this use case |
| **Protocol Buffers** | Smallest size, fastest, schema evolution | Requires `.proto` schema, binary, complex | ❌ Too complex |
| **Custom binary** | Maximum efficiency | Not inspectable, fragile, no tooling | ❌ Avoid |

**From "Beyond Session JSON: Durable State and Runtime Design for Long-Running AI Coding Agents" (Chaitanya Mishra, 2026):**
> "Use plain JSON as a boundary format or bounded snapshot. Use SQLite when the authoritative state is local or single-node."
> "Plain JSON remains useful for interchange, export, and bounded snapshots, but it is usually too weak to serve as the primary system of record once concurrency, crash recovery, queryable history, and audit become first-class concerns."

**For context-pager:**
- Pools are **bounded snapshots** (not full audit logs)
- Human readability is valuable for debugging context issues
- OpenCode's own session/message/part storage uses JSON
- Performance difference is negligible for pool sizes (expected <1MB per project)

**Conclusion:** JSON is the right choice. MessagePack or Protobuf would add complexity without meaningful benefit.

### 3.3 Storage Location Comparison

| Location | Pros | Cons | Verdict |
|----------|------|------|---------|
| **`ctx.storage` API** | Plugin-scoped, managed by OpenCode, XDG-compliant, survives plugin updates | Less control over exact path | ✅ **Recommended** |
| **Project `.opencode/context-pager/`** | Project-local, git-ignorable, easy to backup with project | Not user-scoped, lost if project deleted | ⚠️ Alternative for project-specific pools |
| **`~/.config/opencode/context-pager/`** | User-scoped, aligns with config | Mixes data with config, not XDG-compliant for data | ❌ Not recommended |
| **`~/.local/share/opencode/context-pager/`** | XDG-compliant for data | Conflicts with OpenCode's own storage layout | ❌ Not recommended |

**From OpenCode V2 docs:**
> "Store, read, or remove durable JSON values scoped to the plugin."
> "Plugin storage is scoped by this ID, and the ID also identifies the plugin in status and diagnostics."

**Key insight:** `ctx.storage` is the idiomatic V2 approach. It:
- Automatically handles XDG paths
- Scopes data to plugin ID (prevents conflicts)
- Survives plugin reloads and updates
- Is the pattern used by other V2 plugins (e.g., `opencode-models-discovery`)

### 3.4 Security Implications of Persisting Context

**Key risks:**
1. **PII leakage** — User prompts may contain emails, names, phone numbers
2. **Secret exposure** — API keys, passwords, tokens in tool outputs or user messages
3. **Cross-project leakage** — Pools from one project accidentally loaded in another
4. **File permission issues** — Sensitive data readable by other users

**Best practices from industry:**

**From Microsoft "Manage AI memory safety in agentic systems" (2026):**
> "Minimize sensitive memory artifacts: Wherever possible, avoid storing confidential information in persistent memory, conversation summaries, vector stores, agent scratchpads, logs, or grounding caches."
> "Isolation of memory, retrieval, and conversation contexts: Architect systems so that each user, session, task, agent has isolated context."

**From LangChain "Redact secrets from traces":**
> "The preset favors precision over exhaustive coverage... Unrecognized formats reach LangSmith: a credential that matches no rule, including a random high-entropy string with no surrounding context, is uploaded as is."
> "Redaction is not access control: a redacted trace still holds the prompts, file contents, and tool results it was built from. Restrict who can read the tracing project."

**From PrivAiTe (self-hosted PII redaction proxy):**
> "It protects the egress, not the agent. The CLI keeps the real values in its own context and local transcripts."
> "The agent's own prompt is not scanned. The `system` and `instructions` fields pass through as-is."

**From Microsoft "Sensitive Information Disclosure (Data Leak)":**
> "Apply policies before sensitive data is persisted into AI memory or surfaced from memory to users or agents."
> "Secure proxy, redaction, and tokenization layers: Where external or semi-trusted AI services are unavoidable, route prompts and outputs through a proxy that redacts, tokenizes, or encrypts."

**Recommended security model for context-pager:**

1. **Pre-storage redaction:**
   - Scan messages for common secret patterns (API keys, tokens, passwords)
   - Replace with `[REDACTED]` placeholder before persisting
   - Use regex patterns from LangChain's redaction preset or similar

2. **Project scoping:**
   - Key pools by project ID (from `ctx.location.project.id`)
   - Never load pools from unrelated projects
   - Validate project ID matches before restoring

3. **File permissions:**
   - OpenCode's storage uses `600` (owner read/write only)
   - Ensure parent directories are not world-readable

4. **User control:**
   - Provide command to clear persisted pools (`/ctx-pools-clear`)
   - Allow opt-out of persistence via plugin config

5. **Audit trail:**
   - Log when pools are persisted/restored (without logging content)
   - Track pool size/token count for monitoring

---

## 4. APP SOURCE FINDINGS

### 4.1 Repository State
```
ctx-lifecycle/
├── docs/
│   ├── RESEARCH_BRIEF_ISSUE_001.md  # context-pager architecture
│   ├── RESEARCH_BRIEF_ISSUE_003.md  # test command patterns
│   └── RESEARCH_BRIEF_ISSUE_005.md  # this brief
├── LICENSE
└── README.md
```

**Current state:** Greenfield implementation. No plugin code yet.

### 4.2 OpenCode V2 Plugin API Patterns

**From OpenCode V2 documentation:**
```typescript
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "context-pager",
  async setup(ctx) {
    // Storage API usage
    await ctx.storage.set("pools/" + projectID, {
      global: [...],
      planning: [...],
      execution: [...],
      testing: [...]
    })
    
    const pools = await ctx.storage.get("pools/" + projectID)
    
    // Scan keys by prefix
    const page = await ctx.storage.scan({ prefix: "pools/", limit: 100 })
  },
})
```

**Key APIs:**
- `ctx.storage.get(key: string): Promise<Json | undefined>`
- `ctx.storage.set(key: string, value: Json): Promise<void>`
- `ctx.storage.remove(key: string): Promise<void>`
- `ctx.storage.scan(options: { prefix, limit, after }): Promise<{ entries, next }>`

**From migration guide:**
> "Every V2 plugin needs a stable `id`. Plugin storage is scoped by this ID."
> "`ctx.location` describes the location where this plugin instance loaded. It is not the location of every session or event the plugin may observe."

### 4.3 Existing Plugin Examples

**`herdr-agent-state.js`** (installed in `~/.config/opencode/plugins/`):
- V1/V2 hybrid plugin
- Reports session state to herdr via Unix socket
- Does not use `ctx.storage` (stateless)

**`opencode-dynamic-context-pruning`** (DCP):
- Stores pruning state in `~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json`
- Uses direct filesystem writes (V1 pattern)
- JSON format with session metadata, tool IDs, statistics

**`opencode-memory`**:
- Uses plugin-owned SQLite databases
- Stores memory as Markdown files
- More complex than needed for context-pager

---

## 5. INFRA FINDINGS

### 5.1 OpenCode Storage Layout

**From filesystem inspection:**
```
~/.local/share/opencode/
├── opencode.db              # SQLite database (sessions, messages, parts)
├── opencode.db-shm
├── opencode.db-wal
├── storage/
│   ├── message/
│   ├── part/
│   ├── project/
│   ├── session/
│   └── session_diff/
├── log/
└── tool-output/

~/.config/opencode/
├── opencode.json            # Global config
├── plugins/
│   ├── herdr-agent-state.js
│   └── ...
├── agents/
└── skills/
```

**Plugin storage path (V2):**
- Pattern: `~/.local/share/opencode/storage/plugin/<plugin-id>/`
- For context-pager: `~/.local/share/opencode/storage/plugin/context-pager/`
- Files: JSON, one per key (or internal DB format)

### 5.2 Project Identification

**From OpenCode storage format:**
- Each git repo has `.git/opencode` containing project ID hash
- Project ID = SHA-1 hash of worktree path
- Used to scope sessions, messages, and pools

**For context-pager:**
- Pool key format: `pools/<project-id>`
- Example: `pools/437bb51279515345f7b879a07f651cfa601f1648`

### 5.3 File Permissions

**From filesystem inspection:**
```
~/.local/share/opencode/auth.json        # -rw------- (600)
~/.local/share/opencode/opencode.db      # -rw------- (600)
~/.config/opencode/plugins/              # drwx------ (700)
```

**Expected for context-pager:**
- Plugin storage inherits OpenCode's permission model
- Files should be `600` (owner read/write only)
- Plugin storage directory should be `700`

---

## 6. POOL SCHEMA FOR PERSISTENCE

### 6.1 Recommended Structure

```typescript
interface PersistedPools {
  version: number              // Schema version for migrations
  projectId: string            // SHA-1 hash of worktree path
  updatedAt: number            // Unix timestamp (ms)
  pools: {
    global: PersistedPool
    planning: PersistedPool
    execution: PersistedPool
    testing: PersistedPool
  }
}

interface PersistedPool {
  messages: ModelMessage[]     // OpenCode's ModelMessage type
  tokenCount: number           // Pre-computed token count
  state: PoolState             // Current state machine state
  lastTransition: number       // Unix timestamp of last state change
  handoffSummary?: string      // Last hand-off summary text
}

enum PoolState {
  PLANNING = "planning",
  CODING = "coding",
  DEBUGGING = "debugging",
  COMPLETE = "complete"
}
```

### 6.2 Message Format

**From OpenCode's `ModelMessage` type:**
```typescript
type ModelMessage = {
  role: "user" | "assistant" | "system"
  content: string | Array<{ type: "text" | "image" | "tool", ... }>
  id?: string
  createdAt?: number
  // ... other OpenCode-specific fields
}
```

**Serialization:**
- Use `JSON.stringify()` with 2-space indentation (matches OpenCode's style)
- Preserve all fields from OpenCode's message objects
- Do not transform or compress (keep human-readable)

---

## 7. SECURITY MODEL

### 7.1 Pre-Storage Redaction

**Implement before `ctx.storage.set()`:**

```typescript
function redactSensitiveData(message: ModelMessage): ModelMessage {
  const patterns = [
    // API keys
    /(sk-[a-zA-Z0-9]{32,})/g,           // OpenAI-style
    /(ghp_[a-zA-Z0-9]{36})/g,           // GitHub PAT
    /(xox[baprs]-[a-zA-Z0-9-]{10,})/g,  // Slack tokens
    // Passwords in common patterns
    /password["']?\s*[:=]\s*["']?([^"'\s]{8,})/gi,
    // High-entropy strings (potential secrets)
    /([a-zA-Z0-9+/]{40,})/g,            // Base64-like
  ]
  
  const redacted = message.content.replace(
    patterns[i],
    `[REDACTED-${i}]`
  )
  
  return { ...message, content: redacted }
}
```

**From LangChain redaction patterns:**
- AI provider keys (OpenAI, Anthropic, etc.)
- Cloud platform credentials (GCP, Azure)
- Database connection strings
- Private keys (RSA, SSH)

### 7.2 Access Control

**At read time:**
```typescript
async function loadPools(ctx, projectID: string) {
  // Verify project ID matches current location
  if (projectID !== ctx.location.project.id) {
    throw new Error("Project ID mismatch: cannot load pools from another project")
  }
  
  const key = `pools/${projectID}`
  const data = await ctx.storage.get(key)
  
  // Validate schema version
  if (data.version !== CURRENT_SCHEMA_VERSION) {
    await migratePools(data)
  }
  
  return data
}
```

### 7.3 User Controls

**Commands to implement:**
- `/ctx-pools-clear` — Delete all persisted pools for current project
- `/ctx-pools-status` — Show pool sizes, last update time, token counts
- `/ctx-pools-export` — Export pools to JSON file (for backup)
- `/ctx-pools-import` — Import pools from JSON file (with validation)

**Config options:**
```jsonc
{
  "context-pager": {
    "persistence": {
      "enabled": true,
      "redactSecrets": true,
      "maxPoolSizeTokens": 50000,
      "retentionDays": 30
    }
  }
}
```

---

## 8. OPEN QUESTIONS ANSWERED

### 8.1 Q: Should pools be project-scoped or user-scoped?
**A:** **Project-scoped.** Context is tied to a specific codebase. Loading pools from the wrong project would cause severe context confusion. Use `ctx.location.project.id` as the storage key prefix.

### 8.2 Q: Should we use `ctx.storage` or direct filesystem writes?
**A:** **`ctx.storage` API.** It's the idiomatic V2 pattern, handles XDG paths automatically, scopes by plugin ID, and survives plugin updates. Direct FS writes are a V1 pattern (used by DCP, opencode-memory).

### 8.3 Q: Is JSON fast enough for pool serialization?
**A:** **Yes.** Pools are expected to be <1MB per project. JSON parse/stringify is sub-millisecond for this size. The human-readability benefit for debugging far outweighs the minor performance cost.

### 8.4 Q: How do we prevent secret leakage?
**A:** **Pre-storage redaction + file permissions.** Scan messages for common secret patterns before calling `ctx.storage.set()`. OpenCode's storage uses `600` permissions, which prevents other users from reading the files.

### 8.5 Q: What about cross-session continuity?
**A:** **Pools persist across sessions, but are project-scoped.** When a user opens a project, the plugin loads pools from `ctx.storage.get("pools/<project-id>")`. If no pools exist (first session), it initializes empty pools.

---

## 9. REMAINING RISKS

### 9.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Schema evolution breaks old pools | Medium | Medium | Include `version` field, implement migration function |
| Redaction misses novel secret formats | Medium | High | Log redaction stats, allow manual pool clearing |
| Storage API changes in OpenCode V2 beta | Low | High | Pin to specific `@opencode/plugin` version, monitor releases |
| Large pool sizes cause slow load times | Low | Medium | Enforce token ceiling per pool, truncate oldest messages |

### 9.2 Unknowns

1. **Exact `ctx.storage` backend:** Is it JSON files, SQLite, or something else? (Doesn't matter for plugin author — API is the same)
2. **Storage quota limits:** Does OpenCode enforce per-plugin storage limits? (Assume yes, design for <10MB per project)
3. **Concurrent access:** What happens if two sessions write to the same pool key? (Assume last-write-wins, like OpenCode's session storage)

---

## 10. RECOMMENDATIONS

### 10.1 Serialization Format
**Use JSON.** It's OpenCode's native format, human-readable, and requires no dependencies. MessagePack/Protobuf add complexity without meaningful benefit for pool sizes.

### 10.2 Storage Location
**Use `ctx.storage` API** with keys like `pools/<project-id>`. This:
- Follows V2 plugin best practices
- Automatically handles XDG paths
- Scopes data to plugin ID
- Survives plugin updates

### 10.3 Security Model
**Implement pre-storage redaction** for common secret patterns (API keys, tokens, passwords). **Validate project ID** before loading pools. **Provide user commands** to clear/export pools.

### 10.4 Schema Design
**Include version field** for migrations. **Store token counts** pre-computed. **Track last update time** for retention policies. **Preserve OpenCode's message structure** exactly.

### 10.5 Implementation Priority
1. Basic persistence with `ctx.storage` (no redaction)
2. Add pre-storage redaction
3. Add user commands (`/ctx-pools-clear`, `/ctx-pools-status`)
4. Add config options for retention, size limits
5. Add export/import for backup

---

## 11. REFERENCES

### 11.1 Official Documentation
- [OpenCode V2 Plugin Storage API](https://dev.opencode.ai/v2/docs/build/plugins/server#storage)
- [OpenCode V2 Plugin Migration Guide](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1)
- [OpenCode Troubleshooting — Storage](https://opencode.ai/docs/troubleshooting#storage)

### 11.2 Related Projects
- [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) — State persistence pattern
- [opencode-memory](https://github.com/ryands17/opencode-skills/blob/main/opencode-memory/references/storage-format.md) — Storage format reference
- [opencode-models-discovery](https://github.com/yuhp/opencode-models-discovery/blob/dev/docs/persisted-model-discovery.md) — `ctx.storage` usage example

### 11.3 Security Research
- [Microsoft "Manage AI memory safety in agentic systems"](https://learn.microsoft.com/security/zero-trust/manage-agentic-memory-safety)
- [LangChain "Redact secrets from traces"](https://docs.langchain.com/langsmith/redact-secrets)
- [PrivAiTe — Self-hosted PII redaction proxy](https://github.com/crp4222/PrivAiTe)
- [Microsoft "Sensitive Information Disclosure"](https://learn.microsoft.com/security/zero-trust/catalog-ai-attack-techniques/sensitive-information-disclosure)

### 11.4 Serialization Research
- ["Beyond Session JSON: Durable State and Runtime Design for Long-Running AI Coding Agents"](https://research.chaitanya.science/papers/beyond-session-json)
- [JSON vs MessagePack comparison](https://jsonic.io/guides/json-msgpack)

---

**File Path:** `/docs/RESEARCH_BRIEF_ISSUE_005.md`
**Status:** Complete — ready for pipeline lead handoff
**Next Owner:** dev-team-lead (for context-pager plugin implementation)