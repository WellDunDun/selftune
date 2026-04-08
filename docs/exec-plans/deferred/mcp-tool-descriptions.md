# Execution Plan: MCP Tool Descriptions and Surface Quality

<!-- Verified: 2026-03-14 -->

**Status:** Deferred  
**Created:** 2026-03-14  
**Goal:** Improve selftune’s MCP/tool descriptions so agent runtimes can understand and select the right tools more reliably, with less ambiguity and less prompt burden.

---

## Problem Statement

selftune increasingly depends on agents selecting the right commands and flows without human hand-holding. That makes tool surface quality part of the product.

Current risk areas:

- command descriptions are uneven across workflows
- some commands are over-broad or under-specified
- agent runtimes need clearer “when to use this” guidance
- local app/orchestrator/scheduler capabilities have changed faster than the descriptive layer around them

This is especially important for:

- MCP-style tool exposure
- Paperclip / Claude Code / other autonomous agent runtimes
- future cloud/local parity in product semantics

## Priority Note

This is intentionally not in the current release-critical path. It should stay deferred until:

- the SPA/local app path is fully credible
- the autonomous loop is clearer
- the published install proof is complete

---

## Goals

1. Define clean, unambiguous descriptions for the most important selftune tools and commands.
2. Reduce ambiguity in when an agent should use:
   - `sync`
   - `status`
   - `doctor`
   - `evolve`
   - `watch`
   - orchestrator
   - local app/dashboard flows
3. Make the tool surface reflect the current source-truth-first architecture.
4. Improve the ability of external runtimes to use selftune without long custom prompts.

---

## Scope

In scope:

- CLI command descriptions and help text
- MCP/tool descriptions for externally exposed workflows
- workflow routing docs in `skill/workflows/`
- any thin metadata or schema layer needed to describe the tool surface clearly

Out of scope:

- large command regrouping refactors
- product semantics changes
- cloud implementation details

---

## Recommended Work

### 1. Inventory the current tool surface

Create a current map of:

- core user-facing commands
- advanced commands
- commands that should be de-emphasized

### 2. Standardize description format

Each command/tool description should answer:

- what it does
- when to use it
- what preconditions it assumes
- what it outputs
- whether it changes state

### 3. Align with the current architecture

Descriptions should clearly reflect:

- source-truth sync first
- local app as the intended UX path
- OpenClaw cron as optional, not primary
- orchestrator as the autonomous loop entry

### 4. Define agent-friendly descriptions

Produce descriptions that are short enough for tool selection, but specific enough to reduce misuse.

---

## Deliverables

1. A canonical inventory of the selftune tool surface
2. Updated command/workflow descriptions
3. MCP/tool-facing description text for core commands
4. Guidance on which tools should be exposed by default vs advanced

---

## Success Criteria

- Agents choose the right selftune tools with less prompt scaffolding
- Fewer ambiguous tool-selection failures
- The tool surface matches the current product story
- Help/docs/workflow descriptions stop lagging behind the implementation
