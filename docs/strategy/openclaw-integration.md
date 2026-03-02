# OpenClaw Integration — Technical Strategy & Design

**Status:** Active
**Version:** 1.0.0
**Last Updated:** 2026-03-02
**Owner:** Daniel Petro
**Priority:** P0 — Primary growth vector

> OpenClaw is the hottest agent platform right now. This document captures the full integration surface, three integration paths, the autonomous cron loop design, and the GTM implications.

---

## Table of Contents

1. [Why OpenClaw First](#why-openclaw-first)
2. [Platform Audit Summary](#platform-audit-summary)
3. [Three Integration Paths](#three-integration-paths)
4. [Session Ingestion Adapter](#session-ingestion-adapter)
5. [Autonomous Cron Loop Design](#autonomous-cron-loop-design)
6. [Feature Parity Matrix](#feature-parity-matrix)
7. [Implementation Roadmap](#implementation-roadmap)
8. [GTM Impact](#gtm-impact)
9. [Open Questions](#open-questions)

---

## Why OpenClaw First

OpenClaw has the richest integration surface of any agent platform for selftune:

| Factor | Claude Code | Codex | OpenCode | **OpenClaw** |
|--------|:-----------:|:-----:|:--------:|:------------:|
| Hooks system | 3 named hooks | None (wrapper) | None (SQLite) | **Event-driven pub/sub + plugin SDK** |
| Cron/scheduler | None | None | None | **Built-in Gateway Scheduler** |
| Session format | JSONL transcripts | JSONL rollouts | SQLite | **JSONL transcripts + metadata manifest** |
| Skill system | Agent Skills standard | Agent Skills | Agent Skills | **AgentSkills-compatible + ClawHub marketplace** |
| Hot reload | No | No | No | **File watcher on SKILL.md changes** |
| Plugin SDK | Limited | None | None | **Full plugin API (600+ exports, 48+ extensions)** |
| Autonomous execution | No | No | No | **Isolated cron sessions, no user interaction** |

**The killer feature:** OpenClaw's cron system lets selftune run the full observe → grade → evolve → deploy loop **completely autonomously** on a schedule — no human intervention. This is the M9 vision (autonomous mode) delivered for free by the platform.

---

## Platform Audit Summary

### Hooks & Events

OpenClaw uses an **event-driven publish-subscribe architecture** with typed events:

| Event | Phase | Equivalent in Claude Code | Data Available |
|-------|-------|--------------------------|----------------|
| `agent:bootstrap` | Agent init | — | workspace, config, agentId, sessionId |
| `message:received` | User prompt | `UserPromptSubmit` | sender, content, channelId, provider |
| `message:sent` | Assistant response | — | content, delivery status, errors |
| Tool before-call | Pre-tool | — | tool name, arguments |
| Tool after-call | Post-tool | `PostToolUse` | tool name, result, duration |
| `beforeMessageWrite` | Persistence | — | full message object before write |
| `gateway:startup` | System init | — | config, dependencies |
| `gateway:stop` | System shutdown | `Stop` | — |
| Session start/end | Session lifecycle | — | session key, metadata |

**Plugin registration model:**
```typescript
export default async function register(api: OpenClawPluginApi) {
  api.on("message:received", async (event) => {
    // Capture user query for selftune logging
  })
  api.on("agent:bootstrap", async (event, ctx) => {
    // Capture session start + skills snapshot
  })
  // Register custom CLI commands
  api.registerCli(({ program }) => {
    program.command('selftune').action(() => { ... })
  })
}
```

### Cron/Scheduler

**Built-in Gateway Scheduler** with three schedule types:

| Type | Format | Use Case |
|------|--------|----------|
| `cron` | 5/6-field cron expression + IANA timezone | Recurring evolution loops |
| `every` | Milliseconds interval | Continuous monitoring |
| `at` | ISO 8601 timestamp | One-shot evolution runs |

**Two execution modes:**
- **`isolated`** — Clean session per run, no context accumulation (preferred for selftune)
- **`main`** — Runs in main session with full context (not recommended)

**Key behaviors:**
- Jobs persist at `~/.openclaw/cron/jobs.json` (survives restarts)
- Automatic retry with exponential backoff (30s → 1m → 5m → 15m → 60m)
- Output delivery via webhook, messaging channel, or silent
- Stagger support to avoid load spikes
- Per-job agent binding (`agentId` parameter)

**Known limitations:**
- Cron tools blocked in Docker sandbox mode (feature request #29921 open)
- Newly created jobs via API may not fire until Gateway restart (bug)
- Direct shell execution (bypassing LLM) proposed but not yet implemented (#18136)

### Session/Transcript Format

**Storage:** JSONL files at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

**Metadata manifest:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

**JSONL structure per file:**
```
Line 1: {"type":"session","version":5,"id":"<uuid>","timestamp":"<iso>","cwd":"<path>"}
Line 2+: {"role":"user|assistant|toolResult","content":[...],"timestamp":<ms>,"usage":{...}}
```

**Content block types:**
- `text` — Plain text
- `thinking` — Extended reasoning (with optional signature)
- `image` — Base64 encoded (with byte count)
- `toolCall` / `toolUse` — Tool invocations with id, name, input
- `toolResult` — Tool results with error flag
- `partialJson` — Streaming partial JSON

**Session metadata fields relevant to selftune:**
- `inputTokens`, `outputTokens`, `totalTokens` — Token tracking
- `cacheRead`, `cacheWrite` — Cache metrics
- `skillsSnapshot` — Available skills at session time (name, primaryEnv, requiredEnv, full prompt)
- `compactionCount` — Context compaction events
- `model`, `modelProvider` — Model used
- `abortedLastRun` — Error tracking

### Skills Architecture

**AgentSkills-compatible** but with OpenClaw-specific extensions:

**Skill definition:** `SKILL.md` with YAML frontmatter (single-line JSON metadata)

**Discovery from 6 sources (lowest → highest precedence):**
1. Extra directories (`skills.load.extraDirs`)
2. Bundled skills (`/src/agents/skills/`)
3. Managed skills (`~/.openclaw/skills/`)
4. Personal agents skills (`~/.agents/skills/`)
5. Project agents skills (`<workspace>/.agents/skills/`)
6. Workspace skills (`<workspace>/skills/`)

**Key difference from Claude Code:** Skills are injected into the **system prompt** as an XML block. The LLM decides invocation based on skill name + description presence in the prompt, subject to token budget limits.

**ClawHub marketplace:** Public registry at `clawhub.ai` with versioned bundles, vector search, moderation, install counts.

**Hot reload:** File watcher on `SKILL.md` changes, 250ms debounce, bumps snapshot version on next turn.

---

## Three Integration Paths

### Path 1: OpenClaw Plugin (Deepest Integration)

**What:** Create `selftune` as a native OpenClaw plugin/extension.

**How:**
```
~/.openclaw/extensions/selftune/
├── openclaw.plugin.json     # Plugin manifest
├── index.ts                 # Plugin entry (register hooks)
├── hooks/
│   ├── prompt-capture.ts    # message:received → all_queries_log.jsonl
│   ├── session-stop.ts      # Session end → session_telemetry_log.jsonl
│   └── skill-tracker.ts     # Tool hooks → skill_usage_log.jsonl
└── cli/
    └── selftune-commands.ts  # Register CLI: /selftune status, /selftune evolve, etc.
```

**Plugin manifest (`openclaw.plugin.json`):**
```json
{
  "id": "selftune",
  "kind": "extension",
  "name": "selftune — Skill Observability",
  "description": "Self-correcting agent skills. Observes, grades, and evolves skill descriptions.",
  "skills": ["./skill"]
}
```

**Hook registrations:**
```typescript
export default async function register(api: OpenClawPluginApi) {
  // 1. Capture every user query
  api.on("message:received", async (event) => {
    appendToJsonl(ALL_QUERIES_LOG, {
      timestamp: new Date().toISOString(),
      session_id: event.sessionKey,
      query: event.content,
      source: "openclaw"
    });
  });

  // 2. Track skill triggers via tool calls
  api.on("tool:after-call", async (event) => {
    if (isSkillInvocation(event.toolName)) {
      appendToJsonl(SKILL_USAGE_LOG, {
        timestamp: new Date().toISOString(),
        session_id: event.sessionKey,
        skill_name: event.toolName,
        query: event.lastUserQuery,
        triggered: true,
        source: "openclaw"
      });
    }
  });

  // 3. Session telemetry on session end
  api.on("session:end", async (event) => {
    appendToJsonl(SESSION_TELEMETRY_LOG, {
      timestamp: new Date().toISOString(),
      session_id: event.sessionId,
      source: "openclaw",
      // ... full telemetry record
    });
  });

  // 4. Register /selftune slash commands
  api.registerCli(({ program }) => {
    program.command('selftune-status').action(() => runSelftune('status'));
    program.command('selftune-evolve').action(() => runSelftune('evolve'));
    program.command('selftune-dashboard').action(() => runSelftune('dashboard'));
  });
}
```

**Pros:**
- Deepest integration — real-time event capture, zero latency
- Native slash commands (`/selftune-status`)
- Access to full plugin runtime API
- Hot-reload compatible
- Can register as first-class OpenClaw citizen

**Cons:**
- Requires maintaining OpenClaw-specific code
- Plugin API may change between versions
- Must handle OpenClaw's sandbox restrictions

### Path 2: Direct Session Ingestor (Like OpenCode)

**What:** Batch-ingest OpenClaw JSONL transcripts, similar to the existing OpenCode SQLite adapter.

**How:** New file at `cli/selftune/ingestors/openclaw-ingest.ts`

```typescript
// Scan ~/.openclaw/agents/*/sessions/*.jsonl
// Parse each transcript: extract user queries, tool calls, skills triggered
// Write to selftune's shared JSONL schema
// Idempotent via marker file (like claude-replay.ts)
```

**Session file parsing:**
```
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
  → Line 1: session header (id, timestamp, cwd)
  → Line 2+: messages (role, content blocks, usage, tool calls)
```

**Metadata from sessions.json:**
```
~/.openclaw/agents/<agentId>/sessions/sessions.json
  → skillsSnapshot: available skills at session time
  → inputTokens, outputTokens: token usage
  → model, modelProvider: model used
```

**CLI command:** `selftune ingest-openclaw`

**Pros:**
- Simple to implement (follows existing OpenCode pattern)
- No dependency on OpenClaw plugin API
- Works with any OpenClaw version
- Retroactive ingestion of all historical sessions

**Cons:**
- Batch only (not real-time)
- No event-level granularity (must infer from transcripts)
- Requires parsing OpenClaw's JSONL format

### Path 3: Cron-Registered Autonomous Loop (Unique to OpenClaw)

**What:** Register a selftune cron job that runs the full evolution pipeline autonomously.

**How:**
```bash
openclaw cron add \
  --name "selftune-evolve" \
  --cron "0 3 * * 0" \          # Weekly at 3am Sunday
  --tz "America/New_York" \
  --session isolated \
  --message "Run selftune: check all skills for undertriggering, generate evals, grade recent sessions, propose improvements for any skill below 80% pass rate, validate proposals, and deploy if they improve by >5%. Report results." \
  --deliver webhook \
  --to "https://localhost:0/selftune/cron-complete"
```

**Recommended cron schedule:**

| Job | Cron Expression | Purpose |
|-----|----------------|---------|
| `selftune-status` | `0 8 * * *` | Daily health check at 8am |
| `selftune-evolve` | `0 3 * * 0` | Weekly evolution at 3am Sunday |
| `selftune-watch` | `0 */6 * * *` | Monitor regressions every 6 hours |
| `selftune-ingest` | `*/30 * * * *` | Ingest new sessions every 30 min |

**Autonomous loop flow:**
```
Cron fires (isolated session)
    ↓
Agent reads selftune skill instructions
    ↓
Runs: selftune status --json
    ↓
Identifies undertriggering skills (pass rate < 80%)
    ↓
For each undertriggering skill:
    ├── selftune evals --skill <name>
    ├── selftune grade --skill <name>
    ├── selftune evolve --skill <name> --dry-run
    ├── Review proposal
    ├── selftune evolve --skill <name> (deploy if >5% improvement)
    └── selftune watch --skill <name>
    ↓
Report results via webhook/channel
    ↓
Done (session destroyed — isolated mode)
```

**Pros:**
- **Fully autonomous** — no human intervention needed
- Leverages OpenClaw's built-in scheduler (no external cron)
- Isolated sessions prevent context pollution
- Automatic retry with exponential backoff
- Can deliver results to Slack/Discord/WhatsApp
- This IS the M9 vision (autonomous mode)

**Cons:**
- Each cron run costs tokens (full LLM session)
- Currently blocked in Docker sandbox mode (#29921)
- Newly created cron jobs may need Gateway restart (known bug)
- Direct shell execution not yet available (must go through LLM)

### Recommended Approach: All Three, Sequenced

| Phase | Path | When | Why |
|-------|------|------|-----|
| **Phase 1** | Path 2 (Ingestor) | Immediate | Lowest effort, retroactive data, follows existing pattern |
| **Phase 2** | Path 3 (Cron) | Week 2 | Unique differentiator, autonomous loop |
| **Phase 3** | Path 1 (Plugin) | Month 2 | Deepest integration, real-time events, slash commands |

---

## Session Ingestion Adapter

### Mapping OpenClaw Transcripts → selftune Shared Schema

**Source:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

**Target:** selftune's three JSONL log files

#### all_queries_log.jsonl

| selftune Field | OpenClaw Source | Notes |
|---------------|----------------|-------|
| `timestamp` | Message `timestamp` (ms → ISO) | Convert epoch ms to ISO string |
| `session_id` | Session header `id` | UUID from line 1 |
| `query` | `role: "user"` message → `content[0].text` | Extract text from content blocks |
| `source` | `"openclaw"` | Hardcoded |

#### session_telemetry_log.jsonl

| selftune Field | OpenClaw Source | Notes |
|---------------|----------------|-------|
| `timestamp` | Last message timestamp | Session end time |
| `session_id` | Session header `id` | From line 1 |
| `source` | `"openclaw"` | Hardcoded |
| `cwd` | Session header `cwd` | Working directory |
| `transcript_path` | File path | Full path to `.jsonl` |
| `last_user_query` | Last `role: "user"` message | Extract text |
| `tool_calls` | Count by tool name | `{ "bash": 5, "read": 3 }` |
| `total_tool_calls` | Sum of all tool calls | From `role: "assistant"` toolCall blocks |
| `bash_commands` | Commands from bash tool calls | Extract from toolCall inputs |
| `skills_triggered` | Skills from skill invocations | Map toolCall names to skills |
| `assistant_turns` | Count of `role: "assistant"` messages | Simple count |
| `errors_encountered` | Count of `isError: true` tool results | From toolResult messages |
| `transcript_chars` | Sum of all message text | Approximate |

#### skill_usage_log.jsonl

| selftune Field | OpenClaw Source | Notes |
|---------------|----------------|-------|
| `timestamp` | ToolCall message timestamp | When skill was invoked |
| `session_id` | Session header `id` | From line 1 |
| `skill_name` | ToolCall name → skill mapping | Need to map tool names to skills |
| `skill_path` | From sessions.json `skillsSnapshot` | Resolve via metadata |
| `query` | Most recent `role: "user"` before toolCall | Backtrack to find trigger query |
| `triggered` | `true` | If tool was called, skill triggered |
| `source` | `"openclaw"` | Hardcoded |

### Skill Detection Heuristic

OpenClaw doesn't explicitly log "skill X triggered." Skill invocations must be inferred from:

1. **Skill tool pattern:** The agent reads a `SKILL.md` file → this is a skill trigger
2. **Slash command dispatch:** `/skill-name` in user message → explicit trigger
3. **Session metadata:** `skillsSnapshot` lists which skills were available
4. **Tool call names matching skill names:** Tool calls whose names match loaded skill names

### Implementation Notes

- Use `sessions.json` metadata manifest for fast session enumeration (avoid scanning all JSONL files)
- Parse JSONL files lazily — only read full transcript when needed
- Idempotent via marker file: `~/.selftune/openclaw-ingest-marker.json` (maps agentId + sessionId → ingested timestamp)
- Support `--since`, `--dry-run`, `--force`, `--verbose` flags (same as `claude-replay.ts`)
- Handle multi-agent setups: scan all `~/.openclaw/agents/*/` directories

---

## Autonomous Cron Loop Design

### The Vision

OpenClaw's cron system enables something no other platform can: **selftune running as a fully autonomous background service** that continuously improves all skills without human intervention.

### Cron Job Configuration

```json
{
  "id": "selftune-autonomous",
  "name": "selftune autonomous evolution",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 3 * * 0",
    "tz": "America/New_York"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "You are running as an autonomous selftune agent. Execute the full self-improvement pipeline:\n\n1. Run `selftune ingest-openclaw` to capture any new sessions\n2. Run `selftune status --json` to identify undertriggering skills\n3. For each skill with pass rate below 80%:\n   a. `selftune evals --skill <name>` to generate eval set\n   b. `selftune grade --skill <name>` to grade recent sessions\n   c. `selftune evolve --skill <name>` to propose and deploy improvements\n4. Run `selftune watch --skill <name>` on any recently evolved skills\n5. Summarize what you did and the results.\n\nDo not ask for confirmation. Execute the full pipeline autonomously."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack"
  }
}
```

### Safety Controls

| Control | Implementation | Notes |
|---------|---------------|-------|
| **Dry-run first** | `selftune evolve --dry-run` before real deploy | Preview proposals before committing |
| **Regression threshold** | <5% regression on existing triggers | Built into `validate-proposal.ts` |
| **Auto-rollback** | `selftune watch` auto-rollbacks on regressions | Built into `monitoring/watch.ts` |
| **Audit trail** | Every evolution recorded in `evolution_audit_log.jsonl` | Full history of all changes |
| **SKILL.md backup** | `.bak` file before every deploy | Rollback path always exists |
| **Isolated sessions** | Cron runs in clean session (no context pollution) | Each run is independent |
| **Human override** | `selftune rollback --skill <name>` anytime | Manual safety valve |
| **Pin descriptions** | Config flag to freeze specific skills | Prevent evolution on sensitive skills |

### Cron + Hot Reload Synergy

This is where it gets powerful:

```
Cron fires → selftune evolves skill → writes new SKILL.md
     ↓
OpenClaw file watcher detects SKILL.md change (250ms debounce)
     ↓
Skill snapshot version bumped
     ↓
Next agent turn uses updated skill description
     ↓
Improved triggering in real-time — no restart needed
```

**This means:** Skills improve and take effect within seconds of the cron job completing. No deployment step, no restart, no manual intervention. The skill system is truly self-correcting.

---

## Feature Parity Matrix

What selftune needs to support OpenClaw at full parity with Claude Code:

| Feature | Claude Code | OpenClaw Status | Gap? |
|---------|:-----------:|:---------------:|:----:|
| **Hooks: query capture** | `UserPromptSubmit` hook | `message:received` event (Path 1) or JSONL parse (Path 2) | Covered |
| **Hooks: session end** | `Stop` hook | `session:end` event (Path 1) or JSONL parse (Path 2) | Covered |
| **Hooks: tool tracking** | `PostToolUse` hook | Tool after-call event (Path 1) or JSONL parse (Path 2) | Covered |
| **Batch ingest** | `selftune replay` | New `openclaw-ingest.ts` needed | **To build** |
| **Skill detection** | Skill name in tool calls | Infer from SKILL.md reads + toolCall names | **Needs heuristic** |
| **Session path resolution** | `~/.claude/projects/` | `~/.openclaw/agents/*/sessions/` | **Different path** |
| **Agent detection** | `which claude` | `which openclaw` | **Update init.ts** |
| **Cron integration** | N/A | `openclaw cron add` command | **NEW — unique to OpenClaw** |
| **Plugin mode** | N/A | Native extension with plugin API | **NEW — unique to OpenClaw** |
| **ClawHub integration** | N/A | Marketplace quality signals | **NEW — future** |
| **Hot reload** | N/A | SKILL.md changes take effect immediately | **Leveraged for free** |

### Implementation Inventory

| File | Change Type | Priority |
|------|-------------|----------|
| `cli/selftune/ingestors/openclaw-ingest.ts` | **New** | P0 |
| `cli/selftune/init.ts` | Update: detect OpenClaw | P0 |
| `cli/selftune/types.ts` | Update: add `openclaw` to agent types | P0 |
| `cli/selftune/constants.ts` | Update: OpenClaw log paths | P0 |
| `skill/Workflows/Ingest.md` | Update: add OpenClaw workflow | P1 |
| `skill/Workflows/CronSetup.md` | **New**: cron setup workflow | P1 |
| `cli/selftune/cron/setup.ts` | **New**: register cron jobs | P1 |
| `extensions/openclaw-plugin/` | **New**: native plugin (Path 1) | P2 |
| `tests/sandbox/fixtures/` | Update: add OpenClaw fixtures | P0 |
| `ARCHITECTURE.md` | Update: add OpenClaw domain | P1 |
| `README.md` | Update: add OpenClaw to supported platforms | P0 |
| `PRD.md` | Update: OpenClaw support section | P1 |

---

## Implementation Roadmap

### Week 1: Core Ingestor (Path 2)

- [x] Add `openclaw` to `SelftuneConfig.agent_type` union in `types.ts`
- [x] Add OpenClaw paths to `constants.ts`
- [x] Implement `openclaw-ingest.ts` (scan → parse → write to shared schema)
- [x] Update `init.ts` to detect OpenClaw (`which openclaw`)
- [ ] Add OpenClaw fixtures to sandbox harness
- [x] Write tests for OpenClaw JSONL parsing
- [x] CLI command: `selftune ingest-openclaw`
- [x] Update `README.md` with OpenClaw section

### Week 2: Cron Integration (Path 3)

- [x] Implement `cli/selftune/cron/setup.ts`
- [ ] Create `skill/Workflows/CronSetup.md`
- [ ] Register default cron jobs via `openclaw cron add`
- [x] Add `selftune cron` CLI command (setup, list, remove)
- [ ] Test isolated session execution
- [ ] Document safety controls and override procedures

### Month 2: Plugin Integration (Path 1)

- [ ] Create `extensions/openclaw-plugin/` directory
- [ ] Implement `openclaw.plugin.json` manifest
- [ ] Register hooks: `message:received`, `tool:after-call`, `session:end`
- [ ] Register CLI commands: `/selftune-status`, `/selftune-evolve`
- [ ] Test in OpenClaw devcontainer
- [ ] Publish to ClawHub marketplace

### Month 3: ClawHub Integration

- [ ] Explore ClawHub API for skill health metrics
- [ ] Propose "Skill Health Badge" integration with ClawHub
- [ ] Build `selftune` as a discoverable skill on ClawHub
- [ ] Explore aggregated signal sharing via ClawHub

---

## GTM Impact

### OpenClaw Changes the Bowling Pin Strategy

**Before OpenClaw:** selftune's autonomous loop (M9) was a future milestone requiring custom infrastructure.

**After OpenClaw:** The autonomous loop is available NOW via the platform's built-in cron system. This accelerates the entire roadmap.

**Updated bowling pin sequence:**

```
Pin 0 (NEW): OpenClaw Early Adopters
├─ Who: OpenClaw users who want self-improving skills
├─ Unique hook: "Skills that improve while you sleep" (cron-powered)
├─ Win condition: 50+ OpenClaw users with cron-based evolution
├─ Timeline: Immediate — this is the new #1 priority
│
Pin 1: Skill Authors (across all platforms)
Pin 2: Agent Power Users
Pin 3: Platform Teams
Pin 4: Enterprise
```

### OpenClaw-Specific GTM Hacks

**Hack: "Skills That Improve While You Sleep"**
- Marketing message: "Set up selftune cron. Go to bed. Wake up to better skills."
- Demo: 60-second video showing cron setup → overnight results
- Unique to OpenClaw (no other platform has this story)

**Hack: ClawHub Quality Badges**
- Same as the skills.sh badge concept but for ClawHub marketplace
- OpenClaw's marketplace is more active and has vector search

**Hack: Native Plugin Distribution**
- Publish selftune as an OpenClaw extension
- Users install with one command: `openclaw extensions install selftune`
- No separate `npx skills add` step needed

**Hack: Channel-Based Reporting**
- Cron can deliver evolution results to Slack/Discord/WhatsApp
- "Your pptx skill improved 18% overnight" → direct message to your team channel
- Creates visible social proof within teams

### Updated Feature Gap Analysis (for ICP-GTM doc)

| Feature | ICP 1 (Skill Devs) | ICP 2 (Users) | OpenClaw-Unique? |
|---------|:------------------:|:--------------:|:----------------:|
| Cron-based autonomous evolution | Primary | **Primary** | Yes |
| Slash command integration | Primary | **Primary** | Yes |
| Channel-based reporting | Secondary | **Primary** | Yes |
| ClawHub marketplace badges | **Primary** | Secondary | Yes |
| Plugin hot-reload | **Primary** | N/A | Yes |
| Isolated session execution | Both | Both | Yes |

---

## Open Questions

| # | Question | Impact | Decision | Date |
|---|----------|--------|----------|------|
| 1 | Should OpenClaw ingestor share code with `claude-replay.ts`? | Code reuse | TBD | — |
| 2 | How to detect skill triggers in OpenClaw transcripts? | Accuracy | Heuristic needed (SKILL.md read + tool call matching) | — |
| 3 | Should we publish to ClawHub as a skill or extension or both? | Distribution | TBD | — |
| 4 | Cron sandbox limitations (#29921) — workaround? | Autonomous loop | Monitor issue; manual cron as fallback | — |
| 5 | Which cron schedules should be defaults? | UX | See recommended schedule above | — |
| 6 | Token cost per cron run — is it acceptable? | Cost | Need to measure; estimate ~5K tokens/run | — |
| 7 | Should plugin hooks write to same log paths as batch ingestor? | Schema | Yes — same shared JSONL schema | — |
| 8 | Multi-agent OpenClaw setups — how to handle? | Complexity | Scan all `~/.openclaw/agents/*/` | — |

---

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-03-02 | 1.0.0 | Initial OpenClaw integration design from platform audit |
