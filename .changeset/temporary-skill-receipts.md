---
"@selftune/desktop": patch
---

Support task-owned temporary skill selections with receipt-backed cleanup, overlapping-task guards, and a read-only cleanup preview.

Expose `skills load`, `activate`, `active`, and `deactivate` through the agent-facing CLI workflow. Activation and cleanup preview by default; approved changes require `--yes`.
