---
name: Bug report
about: Something in Tower didn't work as expected
title: "[bug] "
labels: bug
---

**What happened**
A clear description of the bug.

**Steps to reproduce**

1. …
2. …

**Expected**
What you expected instead.

**Environment**

- Tower version (`npx -y tower-mcp --version`) / commit if running from a clone:
- Node version (`node -v`, must be 22.13+ or 23.4+ — `node:sqlite` is behind a flag
  below those):
- OS:
- Agent / MCP client (Claude Code, Cursor, Codex, …):

**`tower doctor` output**
Run `npx -y tower-mcp doctor` in the repo where it failed and paste the output.

**Logs / output**
Paste the collision output, server logs, or a failing test.
