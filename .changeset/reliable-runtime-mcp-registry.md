---
"@selftune/desktop": patch
---

Make packaged runtimes discover bundled DuckDB resources without Desktop-only environment setup, let npm and Bun CLI installs follow a verified same-or-newer Desktop-managed runtime, remove unpublished workspace packages from registry resolution during installation, and add the bounded read-only `selftune mcp serve` local skill registry.
