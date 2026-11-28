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
| **An empty root with an allow-list** (`TemporaryFileSystem=/:ro`, then binds), not `ProtectSystem=strict` + `ProtectHome=yes` | the hide-list the VPS units and most projects use; a dedicated user alone | A hide-list names what to hide, and a personal machine has more to hide than `/home`: under WSL2 a fresh system user with no groups could list the Windows user's files under `/mnt/c` (measured), and every machine has its own mounts. An allow-list names what the server needs, which is short and the same everywhere: the code, bun, glibc, the library, its tokens, its state. systemd.exec(5) describes the pattern under `TemporaryFileSystem=`. The cost is the two glibc lines, which are per distribution (see "Where this is weak"). |
| **No network at all** (`PrivateNetwork=yes`), with `IPAddressDeny=any` as a second layer | `IPAddressDeny=any` + `IPAddressAllow=localhost` alone | The world server and the door make no outbound call in this configuration (`SFU_ICE_SERVERS=[]`; aid1 tokens verify offline). `IPAddressDeny` alone was measured: it blocks the LAN and the internet but still reaches every service on the machine's own loopback, which on a personal machine is where the dev servers, databases and agents are. The namespace has its own loopback, so it is the primary. |
| **The way in is a socket unit on 127.0.0.1 and `systemd-socket-proxyd`** in the server's namespace (`JoinsNamespaceOf=`) | a veth pair with forwarding rules; binding the server on the host and firewalling it | It is the example in systemd-socket-proxyd(8). PID 1 holds the listening socket in the host's namespace and the proxy lives inside the sandbox's, so there is no interface, route or firewall rule to get wrong. It carries streams only, which is why there is no voice. |
| **Loopback only; the public face is the operator's tunnel or TLS proxy** | binding a LAN address or 0.0.0.0 and forwarding a router port | TLS, a public name and the decision to be public all live in one tool that the operator turns on and off by hand. Nothing in `deploy/home/` can make the server public, and `home-units` refuses a socket unit that listens anywhere but 127.0.0.1. `stop.sh` does not drive the tunnel: each is different, and one tunnel's `off` command was seen to wait forever on an account where it had never been enabled, which would have left the server running behind a teardown that hung. |
| **Limits by cgroup** (`MemoryMax=`, `MemorySwapMax=0`, `TasksMax=`, `CPUQuota=`), no `MemoryHigh=`, no `ulimit` | `ulimit -d` on the optimizer child (main's default); `MemoryHigh=` | The sandbox holds no shell, so the `ulimit` wrapper cannot run (`OPT_MEM_BUDGET_MB=0`); bun also misbehaves under `RLIMIT_DATA`, which charges its startup reservations (oven-sh/bun#39967). With no swap, `MemoryHigh=` slows a runaway process to a standstill instead of ending it; `MemoryMax=` ends it and `Restart=always` brings the server back. |
| **State on its own filesystem; a 1 GB tmpfs unless the operator mounted one** | a directory on the machine's disk; making and formatting an image file in `start.sh` | A directory has no size cap short of quotas, so one upload loop fills the machine. A tmpfs needs no formatting and no loop device and leaves nothing behind, which fits a server put up for a few days; `AssertPathIsMountPoint=` keeps the units from ever writing to the bare disk. Formatting is left to the operator: a script that runs `mkfs` on a path it computed is a bad thing to have around, and a mount made by hand works as it is. |
| **Secrets in `/etc/eidoverse-home`, outside the sandbox's filesystem** | the env file beside the scripts in the checkout; the agents' tokens in the state directory | The env file is root's, 0600, read by systemd and passed as environment; the path does not exist inside. The agents' tokens are root's and bound read-only, so the server reads them and cannot add a row for itself. In the first form they sat in the state tmpfs: a reboot lost them, and the server's user could write them. `start.sh` generates the join token and never prints it; a token printed into a terminal log once had to be rotated. |
| **Code as a root-owned export in `/opt/eidoverse-home`** | binding the operator's checkout straight in | The checkout is the operator's working tree: it can hold a `.env` (bun loads one from its working directory without a word), worlds, token files and git metadata, and it changes under the server on every pull. The export leaves those out (`export-exclude`), is what `/version` names, and cannot be written by the server or by the operator's own account. `/opt/<name>` for code, `/var/lib/<name>` for state and `/etc/<name>` for settings is the layout #362 proposes for the VPS units: add-on code in `/opt` as matrix.org's Synapse package has it, state and settings as Gitea has them. |
| **Nothing is enabled at boot** | enabling all four units in `start.sh` | With the default tmpfs a reboot empties the worlds, so someone has to found them again anyway; and a server that puts itself back on a public tunnel after a reboot, unattended, is a decision the operator should make on purpose (one `systemctl enable` line, in the guide). |
| **One sandbox block, as a drop-in of both services** (`sandbox.conf`) | the block written out in each unit | The door and the world server had the same 45 lines twice, and `inside.sh` needed them a third time. A drop-in is how Synapse ships its hardening (`override-hardened.conf`); `inside.sh` reads the installed files, so a one-off command cannot run under a different sandbox than the server's. |

## Measured

On the units as they are in this directory, installed by `start.sh` on the machine above:

| check | result |
|---|---|
| `sandbox-probe.ts` outside (the control) | the user's home, keys and config read; every local service it found connected; the internet reached |
| `sandbox-probe.ts` inside | 86 attempts, 86 blocked: 30 reads (homes, `/etc`, `/mnt`, the env file, `/proc/1`, `/sys`), 17 writes outside the state, 18 network (the machine's own loopback services, its LAN address, the internet over TCP, UDP and DNS), 20 exec and privilege (a shell, a binary dropped in each writable place, setuid, namespaces, mount, raw sockets, ptrace), 1 fork loop (refused by `TasksMax`). Its controls passed: the state is writable and the sandbox's own loopback reaches the server |
| fill the disk, inside | `ENOSPC` at the state's size and at `/tmp`'s 256 MB; the machine's disk unchanged |
| allocate without end, inside (`--only=mem`) | killed at 3.8 GB of `MemoryMax=4G`; the kernel log names the probe's own transient unit as the cgroup; the world server and the door kept their PIDs, `NRestarts=0` |
| `systemd-analyze security` | 1.2 for the world server and the door, 2.8 for each proxy |
| a browser-shaped join through 127.0.0.1 | with the key: joined; without: `refused the join: bad or missing join token` |
| an enrolled agent through the door | reads the world, uploads a model (stored, checked and optimized by the server's child processes, with no shell), creates it; an unknown token is refused; a row added to the tokens file works with no restart |
| the export | a checkout holding a `.env` with `TRUST_NAMES=1`, a `worlds/` and `.git`: none of the three in `/opt/eidoverse-home/app` |
| `home-units` (the gate suite), mutated | 11 edits that open the sandbox (a socket on 0.0.0.0, no `PrivateNetwork`, a second writable bind, the env file bound in, the host's root, a proxy outside the namespace, a `.env` exported, …): each turns a named row red |

## Left out, and why

- **Voice.** The SFU needs UDP in, and outbound; the sandbox has neither. Serving voice from a home is its own piece
  of work, not a line to loosen here.
- **`DynamicUser=`** for the servers: `inside.sh` and the operator's own tools write the same state, so the user is a
  real, stable one. The proxies hold no state and use it.
- **`MemoryDenyWriteExecute=`**: it turns bun's JIT off (measured for #362: a hot loop three times slower).
- **A `/bin/sh` in the sandbox**: nothing on main needs one once `OPT_MEM_BUDGET_MB=0`.
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
- **The probe knows only its own list.** It is evidence against the paths and addresses it names, not a proof.
