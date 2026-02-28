# Invocation Taxonomy Reference

How selftune classifies the ways users trigger (or should trigger) a skill.
Used by the `evals` command and referenced by evolution workflows to understand
coverage gaps.

---

## The 4 Invocation Types

Every query in an eval set is annotated with one of four invocation types.
Three are positive (should trigger the skill), one is negative (should not).

### Explicit

The user names the skill directly.

> "Use the pptx skill to make slides"
> "Run the selftune grade command"
> "Open the reins audit tool"

**What it means:** The user knows the skill exists and asks for it by name.
This is the easiest type to catch. If a skill misses explicit invocations,
something is fundamentally broken.

### Implicit

The user describes the task without naming the skill.

> "Make me a slide deck"
> "Grade my last session"
> "Score this project's readiness"

**What it means:** The user knows what they want but not which skill does it.
The skill description's trigger phrases must cover these natural-language
variations. Missing implicit invocations means the description is too narrow.

### Contextual

The user describes the task with domain-specific noise and context.

> "I need slides for the Q3 board meeting with revenue charts"
> "After that deploy, check if the skill is still working"
> "The last codex run felt off, can you evaluate it"

**What it means:** The user is thinking about their domain, not about skills.
The query contains the intent buried in context. Missing contextual invocations
means the skill description lacks real-world vocabulary.

### Negative

The query should NOT trigger the skill.

> "What format should I use for a presentation?"
> "Explain what eval means in machine learning"
> "How do I write a grading rubric for my class"

**What it means:** The query contains keywords that might confuse a matcher
(e.g., "presentation", "eval", "grading") but the intent does not match
the skill's purpose. Negative examples prevent false positives.

---

## What "Healthy" Looks Like

A healthy skill catches all three positive invocation types:

| Type | Healthy | Unhealthy |
|------|---------|-----------|
| Explicit | Catches all | Misses some (broken) |
| Implicit | Catches most | Only catches explicit (too rigid) |
| Contextual | Catches many | Only catches explicit + some implicit (needs evolution) |
| Negative | Rejects all | False positives on keyword overlap |

### The Coverage Spectrum

```
Explicit only     -->  Skill is too rigid, users must babysit
+ Implicit        -->  Skill works for informed users
+ Contextual      -->  Skill works naturally in real workflows
- Negative clean  -->  No false positives
```

A skill that only catches explicit invocations is forcing users to know its
name and syntax. That defeats the purpose of skill-based routing.

---

## Connection to Evolution

The invocation taxonomy directly drives the evolution feedback loop:

### Missed Implicit = Undertriggering

When `evals` shows implicit queries that don't trigger the skill, the
description is too narrow. The `evolve` command will:
1. Extract the missed implicit patterns
2. Propose description changes that cover them
3. Validate that existing triggers still work

### Missed Contextual = Under-evolved

When implicit queries trigger but contextual ones don't, the skill needs
richer vocabulary. Evolution should add domain-specific language to the
description's trigger phrases.

### False-Positive Negatives = Overtriggering

When negative queries trigger the skill, the description is too broad.
Evolution should tighten the scope or add "Don't Use When" clauses.

### The Evolution Priority

Fix in this order:
1. **Missed explicit** -- broken, fix immediately
2. **Missed implicit** -- undertriggering, evolve next
3. **Missed contextual** -- under-evolved, evolve when implicit is clean
4. **False-positive negatives** -- overtriggering, tighten after broadening

---

## Eval Set Structure

Each entry in a generated eval set looks like:

```json
{
  "id": 1,
  "query": "Make me a slide deck for the Q3 board meeting",
  "expected": true,
  "invocation_type": "contextual",
  "skill_name": "pptx",
  "source_session": "abc123"
}
```

| Field | Description |
|-------|-------------|
| `id` | Sequential identifier |
| `query` | The user's original query text |
| `expected` | `true` = should trigger, `false` = should not |
| `invocation_type` | One of: `explicit`, `implicit`, `contextual`, `negative` |
| `skill_name` | The skill this eval targets |
| `source_session` | Session ID the query came from (if positive) |
