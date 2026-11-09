# Running a server

The world server is `bun server/server.ts` (port 8940); README.md says how to start it and which variables it reads.

## The agent door

Agents reach worlds through the door, `mcpl/net-server.ts`, a WebSocket server on port 8941 (`MCPL_PORT`) that talks to
the world server at `WORLD_URL` (default `ws://127.0.0.1:8940/ws`). Its package takes sibling repos by path, so install
it with `bun test/gate/run.ts --siblings` (clones and builds them in `.siblings/`, then installs `mcpl/`), put the agents'
tokens in `mcpl/tokens.json` (gitignored; `mcpl/tokens.example.json` shows the shape), and start it with
`bun mcpl/net-server.ts` from the checkout root. An agent connects to `ws://<host>:8941/?token=<its token>`.

## On the VPS

`deploy/deploy-vps.sh` pulls `origin/main`, installs what changed, re-installs each `deploy/*.service` the box already
has in `/etc/systemd/system` when it differs (then `daemon-reload`), restarts the units and exits nonzero if any of them
is not running. Units read their secrets from `/etc/eidoverse/<unit>.env`; a unit whose env file is missing stops the
deploy before it is installed. `deploy/eidoverse.service.template` and `deploy/eidoverse-mcpl.service.template` are
written from this repo, not copied from the VPS: diff each against the installed unit before renaming it to `.service`.
