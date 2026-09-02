---
"@selftune/desktop": patch
---

Fix signed macOS Desktop startup by accounting for code-signing changes to the bundled DuckDB native libraries. Keep signed-bundle verification, exact hashes for other runtime files, and byte-identical installed runtime checks.
