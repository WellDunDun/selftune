<!-- Verified: 2026-02-28 -->

# Core Beliefs

Agent-first operating principles that guide all development decisions.

## 1. Repository is the Single Source of Truth

If it's not in the repo, it doesn't exist to the agent. Slack discussions, meeting notes, and tribal knowledge must be captured in versioned markdown.

## 2. Agents Are First-Class Team Members

Design docs, architecture guides, and workflows are written for agent consumption first. Human readability is a bonus, not the goal.

## 3. Constraints Enable Speed

Strict architectural rules, enforced mechanically, allow agents to ship fast without creating drift. Freedom within boundaries.

## 4. Corrections Are Cheap

In a high-throughput agent environment, fixing forward is usually cheaper than blocking. Optimize for flow, not perfection at merge time.

## 5. Taste Is Captured Once, Enforced Continuously

Human engineering judgment is encoded into golden principles and tooling, then applied to every line of code automatically. Taste doesn't scale through review — it scales through automation.

## 6. Technical Debt Is a High-Interest Loan

Pay it down continuously in small increments. Background agents handle cleanup. Never let it compound.

## 7. Progressive Disclosure Over Information Dumps

Give agents a map (short AGENTS.md) and teach them where to look. Don't overwhelm context with everything at once.
