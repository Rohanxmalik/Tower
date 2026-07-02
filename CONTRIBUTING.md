# Contributing to Tower

Thanks for helping build the coordination layer for AI coding agents. Tower is early
and moving fast — issues, PRs, and protocol feedback are all welcome.

## Getting set up

Requires **Node 22+** (Tower uses the built-in `node:sqlite`, so there is no native
module to compile).

```bash
git clone https://github.com/Rohanxmalik/Tower
cd Tower
npm install
npm run build
npm test        # should be green, 80% coverage gate
npm run demo    # the two-agent collision demo
```

## Ground rules

- **Tests first (TDD).** Every change lands with tests; the 80% coverage gate is
  enforced in CI and must stay green.
- **Zod at boundaries.** Wire types live in `packages/shared/src/protocol.ts` and are the
  single source of truth — don't redefine them elsewhere.
- **Keep it model-agnostic.** Nothing Claude-specific in the core; it's an MCP server any
  agent can speak to.
- **Small, focused files.** Match the surrounding style; `npm run lint` (eslint + prettier)
  must pass.
- **Conventional Commits** for messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`…).

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm test
```

## Scope

Building toward: predictive conflict detection, auto-resolution, cross-repo intent
graphs. Explicitly out of MVP scope for now — see the roadmap in
[MVP-SPEC.md](MVP-SPEC.md). Open an issue to discuss anything large before writing it.

## Protocol changes

The wire contract is documented in [docs/protocol.md](docs/protocol.md). Changes to tool
schemas are protocol changes — flag them clearly in your PR so downstream agents can adapt.
