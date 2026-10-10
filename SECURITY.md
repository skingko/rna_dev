# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/skingko/rna_dev/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it and the version
(Settings → About, or `./rna --version`). You will get an answer within a week.

## What matters most here

- **Credentials.** Keys live in a separate local credentials file (mode 600) and must never appear
  in configuration responses, logs, state, project files or tool output.
- **The local service.** It listens on `127.0.0.1` only. Anything that lets another origin or another
  local user act through it is in scope.
- **Command and file tools.** Project scope checks, the macOS command sandbox, and the rule that web
  page reads never reach private addresses.
- **Updates and restore points.** Anything that lets an unverified runtime be started or restored.

## Supported versions

Only the latest release receives fixes.
