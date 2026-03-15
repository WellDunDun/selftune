# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a vulnerability, please report it responsibly.

### How to Report

Use GitHub's **private vulnerability reporting**:

1. Go to the [Security tab](https://github.com/selftune-dev/selftune/security) of this repository
2. Click **Advisories** then **Report a vulnerability**
3. Fill in the details and submit

**Do not open a public issue for security vulnerabilities.**

### Response Timeline

- **Acknowledgment:** Within 48 hours of report submission
- **Initial assessment:** Within 7 days
- **Coordinated disclosure:** 90-day window from acknowledgment

### Scope

The following are in scope for security reports:

- **Hook injection** — Malicious payloads in hook inputs that could execute arbitrary code
- **Log data exposure** — Sensitive data leaking into JSONL log files
- **CLI argument injection** — Crafted arguments that bypass validation or execute unintended commands

### Out of Scope

- Social engineering attacks
- Denial of service against the local CLI
- Issues in upstream dependencies (report those to the respective maintainers)

### Recognition

We appreciate responsible disclosure and will credit reporters in the advisory (unless anonymity is requested).
