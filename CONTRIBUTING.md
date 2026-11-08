# Contributing

How to change this repo. Building *in* a world is [AGENTS.md](AGENTS.md); the docs are mapped in
[docs/README.md](docs/README.md).

## The loop

- Run a scratch server, never one someone lives on: AGENTS.md "Dev loop".
- The gate is `bun test/gate/run.ts` (or `bun run test:protocol`); name suites to run only those. What it needs
  and how it reports: [docs/contributing/GATE-MANIFEST.md](docs/contributing/GATE-MANIFEST.md). A change ships with the suite that would catch
  it breaking; a new suite goes in `test/gate/suites.ts`, then `run.ts --manifest` regenerates the table.
- Run suites with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (`test:protocol` sets it): a cached transpile once hid a
  stale module.
- `hygiene` refuses patterns that broke the gate before; its baseline (`test/gate/hygiene-baseline.json`) only
  goes down, never `--write` it up.
- New vocabulary (a component, an agent tool) climbs a ladder: [COMPONENT-LADDER](docs/contributing/COMPONENT-LADDER.md),
  [TOOL-LADDER](docs/contributing/TOOL-LADDER.md).

## Where a file goes

A file's directory says who runs it.

| directory | run by |
|---|---|
| `client/` `server/` `shared/` `mcpl/` `scripting/` | the product: browser, sequencer, the shared fold, the agent door, the script kit |
| `defs/` | the server, as content an operator edits (data, not code) |
| `test/` | the gate: `gate/` (the runner), `protocol/`, `client/`, `server/`, `shared/`, `mcpl/`, `tools/` (tests by subject), `harness/`, `stubs/`, `fixtures/`, `labs/` (run by hand) |
| `tools/` | a person or the server, by hand: CLIs, converters, benches |
| `deploy/` | the VPS: install and ops scripts |
| `spec/` | an implementer somewhere else: the CC0 contract, and only what they need |
| `docs/` | a reader |

A doc's directory says who it is for and whether it binds: `spec/` binds; `docs/reference/` describes what is
built; `docs/guide/` (using a world), `docs/operator/` (running a server) and `docs/contributing/` (changing this repo)
get something done; `docs/design/` argues for what isn't built; `docs/research/` holds the why behind built code; `docs/decisions/` and `docs/history/` are dated and
frozen: supersede them, don't edit them.

## Style

- Comments: one line, plus a pointer (a doc section, a suite, an issue) when there is more. The story goes in the
  commit message.
- New docs are UPPER-CASE.md and live in `docs/`, except the root five (README, AGENTS, CONTRIBUTING, DESIGN,
  THIRD-PARTY) and a directory's own README.
- Every relative link and every `docs/…` path in a comment resolves. A moved file updates its references in the
  same commit.
