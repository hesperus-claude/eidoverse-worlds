# A server on your own machine (deploy/home/)

Why `deploy/home/` is shaped as it is, what else was tried, and what was measured. Operator steps:
[RUNNING-A-SERVER](../operator/RUNNING-A-SERVER.md), "On your own machine". Measured 2026-11-24 to 2026-11-27 on
systemd 255, bun 1.4.4, Ubuntu 24.04 under WSL2 (x86_64). An earlier form of these units has run a small world on a
laptop since 2026-11-24, behind a tunnel for part of that.

## The question

A VPS runs only the server, so the units in `deploy/` protect the server from itself. A laptop or a home box holds its
owner's files, keys and sessions, and sits on a network of other machines that trust it. The question here is the
other one: **if the server process is taken over, what can it reach?** The answer wanted is: its own worlds, and
nothing else.

## Choices

| choice | what else was tried or weighed | why this one |
|---|---|---|
| **systemd units, not a container** | a rootless container with no network | Nothing to install and no image to keep current. The hard part of a no-network container is getting one port in, and that is a stock systemd pattern (below). `systemd-analyze security` and `systemd-run` check and reuse the same lines. |
| **An empty root with an allow-list** (`TemporaryFileSystem=/:ro`, then binds), not `ProtectSystem=strict` + `ProtectHome=yes` | the hide-list the VPS units and most projects use; a dedicated user alone | A hide-list names what to hide, and a personal machine has more to hide than `/home`: under WSL2 a fresh system user with no groups could list the Windows user's files under `/mnt/c` (measured), and every machine has its own mounts. An allow-list names what the server needs, which is short and the same everywhere: the code, bun, glibc, the library, its tokens, its state. systemd.exec(5) describes the pattern under `TemporaryFileSystem=`. The cost is the two glibc lines, which are per distribution (see "Where this is weak"). The same reasoning shapes the export: it is the files git tracks plus the installed dependencies, not the checkout less a list of things to leave out. |
| **No network at all** (`PrivateNetwork=yes`), with `IPAddressDeny=any` as a second layer | `IPAddressDeny=any` + `IPAddressAllow=localhost` alone | The world server and the door make no outbound call in this configuration (`SFU_ICE_SERVERS=[]`; aid1 tokens verify offline). `IPAddressDeny` alone was measured: it blocks the LAN and the internet but still reaches every service on the machine's own loopback, which on a personal machine is where the dev servers, databases and agents are. The namespace has its own loopback, so it is the primary. |
| **The way in is a socket unit on 127.0.0.1 and `systemd-socket-proxyd`** in the server's namespace (`JoinsNamespaceOf=`) | a veth pair with forwarding rules; binding the server on the host and firewalling it | It is the example in systemd-socket-proxyd(8). PID 1 holds the listening socket in the host's namespace and the proxy lives inside the sandbox's, so there is no interface, route or firewall rule to get wrong. It carries streams only, which is why there is no voice. |
| **Loopback only; the public face is the operator's tunnel or TLS proxy** | binding a LAN address or 0.0.0.0 and forwarding a router port | TLS, a public name and the decision to be public all live in one tool that the operator turns on and off by hand. Nothing in `deploy/home/` can make the server public, and `home-units` refuses a socket unit that listens anywhere but 127.0.0.1. `stop.sh` does not drive the tunnel: each is different, and one tunnel's `off` command was seen to wait forever on an account where it had never been enabled, which would have left the server running behind a teardown that hung. |
| **Limits by cgroup** (`MemoryMax=`, `MemorySwapMax=0`, `TasksMax=`, `CPUQuota=` on each service, and on one slice that holds them all), no `MemoryHigh=`, no `ulimit` | `ulimit -d` on the optimizer child (main's default); `MemoryHigh=` | The sandbox holds no shell, so the `ulimit` wrapper cannot run (`OPT_MEM_BUDGET_MB=0`); bun also misbehaves under `RLIMIT_DATA`, which charges its startup reservations (oven-sh/bun#39967). With no swap, `MemoryHigh=` slows a runaway process to a standstill instead of ending it; `MemoryMax=` ends it and `Restart=always` brings the server back. The slice (`eidoverse_home.slice`) is there because the services' own caps add up, and each `inside.sh` command is a unit of its own: without it "no more of the machine than this" had no single number. |
| **The syscall filter is `@system-service` less `@privileged @resources`, and less io_uring** | the first form's longer list (`@mount @debug @cpu-emulation @obsolete @raw-io @reboot @swap @module @clock`) | Expanded with `systemd-analyze syscall-filter` on 255, none of those nine groups removes anything that `~@privileged` leaves in `@system-service`, so they read as protection and were none. `@privileged @resources` is the line Synapse and Vaultwarden use and #362 proposes. io_uring is in `@system-service`, is a large and often-patched piece of kernel, and bun serves, uploads and optimizes without it (measured below). |
| **State on its own filesystem; a 1 GB tmpfs unless the operator mounted one** | a directory on the machine's disk; making and formatting an image file in `start.sh` | A directory has no size cap short of quotas, so one upload loop fills the machine. A tmpfs needs no formatting and no loop device and leaves nothing behind, which fits a server put up for a few days; `AssertPathIsMountPoint=` keeps the units from ever writing to the bare disk. Formatting is left to the operator: a script that runs `mkfs` on a path it computed is a bad thing to have around, and a mount made by hand works as it is. |
| **Secrets in `/etc/eidoverse-home`, outside the sandbox's filesystem** | the env file beside the scripts in the checkout; the agents' tokens in the state directory | The env file is root's, 0600, read by systemd and passed as environment; the path does not exist inside. The values are still the processes' environment, readable by code running as the server; systemd's `LoadCredential=` would narrow that and needs the server to read a credential file. The agents' tokens are root's, in a directory bound read-only, so the server reads them and cannot add a row for itself; the directory and not the file is bound, because a bind of one file keeps showing the old file after an editor replaces it, and a removed token would stay good. In the first form they sat in the state tmpfs: a reboot lost them, and the server's user could write them. `start.sh` generates the join token and never prints it; a token printed into a terminal log once had to be rotated. |
| **Code as a root-owned export in `/opt/eidoverse-home`** | binding the operator's checkout straight in | The checkout is the operator's working tree: it can hold a `.env` (bun loads one from its working directory without a word), worlds, token files, local config and git metadata, and it changes under the server on every pull. `export.sh` copies what git tracks and the three `node_modules`, so none of those arrive, and since it runs as root it leaves behind any link that points out of the checkout (followed, a link to a root-only file would be served). An exclude list was the first draft; it missed every ignored file it did not name. The export is what `/version` names, and cannot be written by the server or by the operator's own account. `/opt/<name>` for code, `/var/lib/<name>` for state and `/etc/<name>` for settings is the layout #362 proposes for the VPS units: add-on code in `/opt` as matrix.org's Synapse package has it, state and settings as Gitea has them. |
| **Nothing is enabled at boot** | enabling all four units in `start.sh` | With the default tmpfs a reboot empties the worlds, so someone has to found them again anyway; and a server that puts itself back on a public tunnel after a reboot, unattended, is a decision the operator should make on purpose (one `systemctl enable` line, in the guide). |
| **One sandbox block, as a drop-in of both services** (`sandbox.conf`) | the block written out in each unit | The door and the world server had the same 45 lines twice, and `inside.sh` needed them a third time. Synapse offers its hardening the same way (`contrib/systemd/override-hardened.conf`). `inside.sh` reads the installed files and refuses to run if they lack the sandbox's lines or differ from what systemd has loaded. |

## Measured

On the units as they are in this directory, installed fresh by `start.sh` from a checkout with its own `.git` and real
`node_modules`, on the machine above (which also runs other servers):

| check | result |
|---|---|
| `sandbox-probe.ts` inside | 98 attempts, 98 blocked: 29 reads, 18 writes outside the state, 27 network, 23 exec and privilege, 1 fork loop. Its controls passed: the state is writable, and the sandbox's own loopback reaches the server |
| the same attempts with no sandbox | 58 of the 98 get through for the operator or for the server's own user run bare (49 for that user alone: 17 reads, every network attempt it was given, a shell, `curl`, a dropped binary in `/tmp` and `/dev/shm`). Those 58 are the sandbox's doing. The other 40 are refused by ordinary permissions as well (root-owned paths, `setuid`, raw sockets, namespaces on a machine that restricts them), or have no outside counterpart (the fork cap) |
| the kernel's account of a process inside | `CapEff` and `CapBnd` zero, `NoNewPrivs=1`, `Seccomp=2`; the probe fails if any is not |
| fill the disk, inside (`--only=disk`) | `ENOSPC` at 1023 MB of the 1 GB state and at `/tmp`'s 256 MB; `STATE_SIZE=128M` gives a 128 MB state |
| a filesystem mounted on the state beforehand | used as it is (`ENOSPC` at its 64 MB); `stop.sh --purge` unmounts the tmpfs `start.sh` made and leaves this one |
| tmpfs pages and memory caps | a writer capped at `MemoryMax=200M` is killed 208 MB into a file on the state: the pages are charged to the writer's cgroup |
| allocate without end, inside (`--only=mem`) | killed at 3.8 GB of `MemoryMax=4G`; the kernel log names the probe's own transient unit, inside the slice, as the cgroup; the world server and the door kept their PIDs, `NRestarts=0` |
| a fork loop, inside | refused with `EAGAIN` at child 129 (`TasksMax=256` counts threads) |
| `kill -9` of the world server | restarted by systemd in the same network namespace; the page answers through the proxy again and the door's agents reach the world, with no other unit touched |
| `systemd-analyze security` | 1.1 for the world server and the door, 2.0 for each proxy |
| a join through 127.0.0.1 | with the key: joined; without: `refused the join: bad or missing join token` |
| an enrolled agent through the door | reads the world, uploads a model (stored, checked and optimized by the server's child processes, with no shell and no io_uring), creates it. A token enrolled by replacing the tokens file works with no restart, and one removed the same way is refused; the door answers on `/mcpl` as on `/` |
| the export | a checkout holding `client/.env.local` with `TRUST_NAMES=1`, a `worlds/`, `.git`, and a tracked link to a file outside it: none in `/opt/eidoverse-home/app`. Modes: `/etc/eidoverse-home` 700 and `home.env` 600, root's; `agents/` 750 and its file 640, root and the service's group |
| `inside.sh` with the sandbox drop-in moved away | refuses to run |
| `home-units` (the gate suite), mutated | 26 edits that open the sandbox, each turning a named row red: a socket off 127.0.0.1, `NetworkNamespacePath=`, `ExecStart=+`, an `ExecStartPre=`, a second writable bind, the env file's directory bound in, the host's root, a looser syscall filter, `TRUST_NAMES=1` in a unit, `User=root`, a proxy outside the namespace, `inside.sh` skipping sandbox lines, an export that follows links or takes untracked files |

## Left out, and why

- **Voice.** The SFU needs UDP in, and outbound; the sandbox has neither. Serving voice from a home is its own piece
  of work, not a line to loosen here.
- **`DynamicUser=`** for the servers: `inside.sh` and the operator's own tools write the same state, so the user is a
  real, stable one. The proxies hold no state and use it.
- **`MemoryDenyWriteExecute=`**: it turns bun's JIT off (measured for #362: a hot loop three times slower).
- **A `/bin/sh` in the sandbox**: nothing on main needs one once `OPT_MEM_BUDGET_MB=0`. #362 would: its child processes start through `/bin/sh`.
- **The boot optimize sweep** (`SKIP_OPT_SWEEP=1`): the library's variants would fill a 1 GB state. Uploads are still
  optimized. An operator with a larger state can take the line out in a drop-in.
- **Driving the tunnel**, and **formatting a state image**: the operator's, as above.

## Where this is weak

- **One kernel.** The sandbox shares the machine's kernel. A takeover of bun plus a kernel exploit that needs no
  capability and passes the syscall filter is root on the machine. A rented box, or a VM, removes that; this does not.
- **Debian and Ubuntu on x86_64 only.** The allow-list binds glibc by path (`/usr/lib/x86_64-linux-gnu`, `/lib64`).
  `start.sh` refuses another layout instead of guessing. arm64 and other distributions need those two lines.
- **The allow-list is not what other projects ship.** Synapse, Mastodon and Vaultwarden use `ProtectSystem=strict`;
  none of them binds an empty root. It is documented systemd, but it is the less-travelled road, chosen for the reason in the table.
- **Tested on one machine**, and that one is WSL2. A bare-metal Debian run is owed.
- **A reboot.** With the default tmpfs it empties the worlds. The path with a filesystem the operator mounted was
  tested with a second tmpfs standing in for it, not with a formatted image.
- **No genesis provenance.** The export has no git metadata, so a world founded here records no revision
  (`[provenance] no git revision`).
- **The probe knows only its own list**, and it runs in a twin of the server's sandbox (`inside.sh`), not in the
  server's own process. It is evidence against the paths and addresses it names, not a proof.
- **The address header.** Every connection reaches the server from loopback, so the server believes whichever
  header `PROXY_ADDRESS_HEADER` names. Whether a given tunnel overwrites that header was not measured here.
- **Untracked files are not served.** A voice file dropped into the client, or any other file git does not track, stays
  out of the export. That is the allow-list working, and it will surprise someone.
