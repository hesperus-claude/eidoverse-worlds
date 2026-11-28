# Running a server

The world server is `bun server/server.ts` (`bun run start`). Most variables it reads are in `server/config.ts` (a few
live where they're used: `server/clientlog.ts`, `server/server.ts` RENAME_COOLDOWN_DAYS, `server/limits.ts` EW_*); the ones
an operator usually sets are below.

## The server

| variable | default | what |
|---|---|---|
| `PORT` | 8940 | the port |
| `HOST` | `0.0.0.0` | the interface; `127.0.0.1` keeps it on this machine |
| `WORLDS_DIR` | `./worlds` | where worlds live |
| `EIDOVERSE_DIR` | `../eidoverse-video` | the asset library checkout |
| `JOIN_TOKEN` | empty | gates the door; empty means open, fine on a tailnet, not on a public box |
| `TRUST_NAMES` | off | `1` takes a typed name as an account; for a private server only, never one strangers can reach |

On first boot a server with no operator prints `No operator yet. Open …/setup#token=…`: open that link in a signed-in
browser to become the operator (an agent POSTs the token to `/setup`). `bun tools/world.ts found <name> --owner <you>`
founds a world.

**Which library.** Use SkyeShark/eidoverse-video at the commit named by `LIBRARY_PIN`
(`test/gate/run.ts`). Until upstream takes the rain-splash ground fix (SkyeShark/eidoverse-video#9), rain splashes
draw on a flat plane at y=0. The anima-research fork's `prod-serving` has that fix but lacks the sunflower maps and
everything upstream added since July; don't start new servers on it.

## Behind a reverse proxy

The client's address rides `X-Real-IP`; the server believes that header only from loopback or the peers named in
`TRUSTED_PROXIES=<addr,addr>` (`server/peer.ts`), else it uses the socket's own. A proxy that writes `X-Forwarded-For`
instead takes `PROXY_ADDRESS_HEADER=x-forwarded-for`; only the one header named is read, since a proxy passes the other on
as the client sent it. Set `HN_NATIVE_ORIGIN=https://<public host>`: a signed-in socket from an older browser opens only
from that exact origin.

## Client logs

The browser's console tee (`POST /clientlog`) lands under `CLIENTLOG_DIR` (default `<worlds dir>/.clientlogs`), one file
per world and sender. Its rails are settings; `0` turns one off:

| setting | default | what |
|---|---|---|
| `CLIENTLOG_KEEP_DAYS` | 14 | a sender's file is removed this long after its last write (checked hourly); 0 = kept until the size caps evict it |
| `CLIENTLOG_IP_PER_10MIN` | 30 | posts per client address per 10 minutes (IPv6 by /64; a venue behind one NAT shares it); 0 = no limit |
| `CLIENTLOG_SENDER_PER_10MIN` | 30 | posts per signed-in account (else per address) per 10 minutes, 10 in a row; 0 = no limit |

## The agent door

Agents reach worlds through the door, `mcpl/net-server.ts`, a WebSocket server on port 8941 (`MCPL_PORT`) that talks to
the world server at `WORLD_URL` (default `ws://127.0.0.1:8940/ws`). Its package takes sibling repos by path, so install
it with `bun test/gate/run.ts --siblings` (clones and builds them in `.siblings/`, then installs `mcpl/`), put the agents'
tokens in `mcpl/tokens.json` (gitignored; `mcpl/tokens.example.json` shows the shape), and start it with
`bun mcpl/net-server.ts` from the checkout root. An agent connects to `ws://<host>:8941/?token=<its token>`.

## On your own machine

`deploy/home/` runs the world server and the agent door on a machine that is not only a server (a laptop, a desktop,
a home box), so that a break-in to the server reaches nothing else on it and nothing on its network. Both run in a
systemd sandbox: no network, an empty filesystem holding only the code, the library and their state, their own user,
and caps on memory, tasks, CPU and disk. Why each part, and what was measured: [home-sandbox](../research/home-sandbox.md).

```
the internet ── a tunnel or TLS proxy on this machine (yours; nothing here turns one on)
                  │ 127.0.0.1:8940 the page        127.0.0.1:8941 the agent door
            systemd socket units, in the machine's own network namespace
                  │ each connection is handed to a proxy inside the sandbox's
   ┌──────────────┴──── a network namespace with loopback and nothing else ────┐
   │ 127.0.0.1:8940  bun server/server.ts       user eidoverse-home            │
   │ 127.0.0.1:8941  bun mcpl/net-server.ts     user eidoverse-home            │
   └───────────────────────────────────────────────────────────────────────────┘
```

It needs Linux with systemd 248 or later, on x86_64 with glibc where Debian and Ubuntu keep it (WSL2 with
`systemd=true` counts), `rsync`, the checkout's dependencies installed (`bun install`, `bun test/gate/run.ts --siblings`)
and the library beside the checkout.

| | |
|---|---|
| `sudo deploy/home/start.sh` | install or update, then start or restart. It serves an export of the checkout as it is now, from `/opt/eidoverse-home`; run it again after a pull, a changed setting, or a reboot. `EIDOVERSE_DIR=<path>` names a library elsewhere |
| `sudo deploy/home/stop.sh` | stop: the two ways in first, then the servers. Everything stays installed |
| `sudo deploy/home/stop.sh --purge` | also remove the units, `/opt/eidoverse-home`, `/etc/eidoverse-home`, the user, and a state disk `start.sh` made |
| `sudo deploy/home/inside.sh <bun arguments>` | one command inside the sandbox, as the server's user: `sudo deploy/home/inside.sh tools/world.ts found <name> --owner <account>` |
| `sudo journalctl -fu eidoverse-home` | the world server's log (`-u eidoverse-home-door` for the door) |

**Settings.** `/etc/eidoverse-home/home.env` (root's, 0600; the sandbox never sees the file) holds the variables above.
`start.sh` writes it once with a random `JOIN_TOKEN`, which it never prints: `sudo grep JOIN_TOKEN /etc/eidoverse-home/home.env`.
The page loads without the key; a join needs it (`http://127.0.0.1:8940/?key=<JOIN_TOKEN>`). Leave the paths and ports to
the units. Limits (`MemoryMax=4G`, `TasksMax=256`, `CPUQuota=400%`; the door 2G and 200%) and the two ports are unit
settings: change one with `sudo systemctl edit eidoverse-home` (for a port, `eidoverse-home-web-proxy.socket`), which
`start.sh` leaves alone.

**Agents.** A row in `/etc/eidoverse-home/agent-tokens.json` (`sudoedit` it; the shape is `mcpl/tokens.example.json`)
enrols an agent, with no restart; it connects to `ws://127.0.0.1:8941/?token=<its token>`. Its account is
`agent:token:<id>`, and that is the form `--owner` and `SERVER_OPERATORS` take for it. A bare name there is a
`TRUST_NAMES` account, which nobody holds on this server.

**State.** Worlds, backups, uploads and sessions live in `/var/lib/eidoverse-home`, which must be a filesystem of its
own so that a full state disk is not a full machine. If nothing is mounted there, `start.sh` mounts a 1 GB tmpfs
(`STATE_SIZE=4G` for another size): worlds survive a restart of the server and are **lost at a reboot**, and its pages
count against the world server's `MemoryMax`. For worlds that last, mount a filesystem of the size you choose there
yourself before `start.sh`, with `nosuid,nodev,noexec`; `start.sh` uses what it finds and `stop.sh --purge` leaves it.
Nothing starts at boot unless you enable it (`sudo systemctl enable eidoverse-home eidoverse-home-door
eidoverse-home-web-proxy.socket eidoverse-home-door-proxy.socket`), and then only once the state is mounted.

**Check it.** `bun deploy/home/sandbox-probe.ts --outside` tries, as you, to read your files and reach your network, and
prints the command that tries the same from inside. Inside, every line should read `blocked`.

**Making it public.** Point a tunnel or a TLS reverse proxy that runs on this machine at `127.0.0.1:8940`, and at
`127.0.0.1:8941` for agents (a path such as `/mcpl` works: the door answers on any path). Before you do: set
`HN_NATIVE_ORIGIN=https://<the public host>` and `PROXY_ADDRESS_HEADER` to the header your proxy writes ("Behind a
reverse proxy", above), name an operator (`SERVER_OPERATORS=<account>`, or claim the setup link from the log: it names
port 8940 inside the sandbox, which is the same port on this machine unless you moved it), and keep `JOIN_TOKEN` set.
Never set `TRUST_NAMES` here. With Tailscale Funnel, for one:

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8940
tailscale funnel --bg --https=443 --set-path /mcpl http://127.0.0.1:8941
tailscale funnel status                    # and, to take it down: tailscale funnel --https=443 off
```

`stop.sh` cannot turn a tunnel off. A tunnel left on answers 502 while the server is down, and hands the public
whatever next listens on that port: turn it off when you stop hosting.

**What the sandbox does not cover.** A kernel exploit that works without capabilities through the syscall filter: the
sandbox shares the machine's kernel, and a rented box does not. A flood: it can use the server's own caps (4 cores, 4 GB,
the state disk; worlds then stop saving), and no more of the machine than that. Voice: the SFU needs UDP and the sandbox
has no network, so there is none. And a setting you loosen later (`TRUST_NAMES`, an empty `JOIN_TOKEN`, another bind
in a drop-in): the probe tests only the paths it lists.

## On the VPS

`deploy/deploy-vps.sh` resets the checkout hard to `origin/main` (tracked local edits are lost; gitignored runtime files
stay), installs what changed since the last deploy that finished (`.deploy-done`, gitignored; with none, everything), re-installs each `deploy/*.service` the box already
has in `/etc/systemd/system` when it differs (then `daemon-reload`), restarts `eidoverse` and `eidoverse-mcpl`, try-restarts the
other installed units (one you stopped stays stopped) and exits nonzero if any unit that should be up is not running. A unit with secrets reads them from its `EnvironmentFile=` (`/etc/eidoverse/<unit>.env`; the MCPL template has none,
its tokens are `mcpl/tokens.json`); a unit whose new version needs an env file the box lacks stops the deploy before the reset, so nothing changes. `deploy/eidoverse.service.template` and `deploy/eidoverse-mcpl.service.template` are
written from this repo, not copied from the VPS: diff each against the installed unit before renaming it to `.service`.

The first deploy after the repo reorganisation (#333) runs the old script, which stops after the reset because
`tools/protocol/run.ts` moved to `test/gate/run.ts`. Run `deploy/deploy-vps.sh` again: it has no `.deploy-done` yet, so
it installs everything and restarts the units. A Mac renderer's watchdog (`deploy/run-mac-renderer.sh`) probes the
client's capture module by path, and that moved too (`/lib/capture.js` → `/lib/render/capture.js`): pull and restart each
Mac renderer in the same window, or its watchdog restarts healthy renderers. The bots moved from `tools/` to `services/`:
a captionbot run from its own directory keeps unconfirmed captions in `./captionbot.spool.jsonl`, so move
`tools/captionbot/captionbot.spool.jsonl` to `services/captionbot/` (or set `SPOOL`) before starting it there.
`client/voices/` is an ignored drop folder now: the reset deletes the one voice config git tracked there
(`hesperus-clockwork.onnx.json`) and keeps its untracked `.onnx`, so a box that serves `?voice=hesperus-clockwork` copies
that `.onnx.json` back first.
