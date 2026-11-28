// deploy/home/ is a server on someone's own machine, in a sandbox. These rows pin its unit files, so that an edit which
// opens the sandbox is an edit to this file too, and run its export. What must hold:
//   U1  each way in listens on 127.0.0.1 and nowhere else;
//   U2  sandbox.conf is exactly the lines below: a line added, dropped or changed fails here;
//   U3  each service's [Service] holds only the keys listed, starts exactly one command with no privilege prefix, and
//       sets none of the sandbox's keys nor TRUST_NAMES;
//   U4  each proxy lives in the world server's namespace, points at its service's port, and holds no privilege;
//   U5  start.sh gives both services the drop-in; inside.sh reads the installed lines, skips only what a one-off
//       command can't carry, and refuses to run without the sandbox;
//   U6  the export (export.sh, run here over a scratch checkout) carries what git tracks and the dependencies: no
//       ignored file, no git metadata, no link that points out of the checkout.
//
//   bun test/server/home-units-test.ts
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
import { linkInto } from "../gate/common.ts";

const S = suite("home-units");
const KIT = fileURLToPath(new URL("../../deploy/home/", import.meta.url));
const text = (name: string) => readFileSync(join(KIT, name), "utf8");
/** A unit file's `Key=value` lines by section, in order, comments and blanks dropped. */
function unit(name: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}; let section = "";
  for (const raw of text(name).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line.slice(1, -1); out[section] = []; continue; }
    (out[section] ??= []).push(line);
  }
  return out;
}
const values = (lines: string[] = [], key: string) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
const keys = (lines: string[] = []) => [...new Set(lines.map((l) => l.slice(0, l.indexOf("="))))];
const differ = (got: string[], want: string[]) => [...got.filter((l) => !want.includes(l)).map((l) => `+ ${l}`), ...want.filter((l) => !got.includes(l)).map((l) => `- ${l}`)];

const sockets = readdirSync(KIT).filter((f) => f.endsWith(".socket"));
S.ok(sockets.length === 2, "U1 two socket units, the page's and the door's", sockets);
for (const f of sockets) {
  const u = unit(f), listen = (u.Socket ?? []).filter((l) => l.startsWith("Listen"));
  S.ok(listen.length === 1 && /^ListenStream=127\.0\.0\.1:\d+$/.test(listen[0]), `U1 ${f} listens on 127.0.0.1 only`, listen);
  S.ok(keys(u.Socket).join() === "ListenStream", `U1 ${f} sets nothing else on its socket (no FreeBind, no BindToDevice)`, keys(u.Socket));
}

// U2: the sandbox, line for line. Changing it means changing this list, in the same review.
const SANDBOX = [
  "Slice=eidoverse_home.slice",
  "PrivateNetwork=yes", "IPAddressDeny=any", "IPAddressAllow=localhost", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
  "TemporaryFileSystem=/:ro", "TemporaryFileSystem=/tmp:size=256m,mode=1777,nosuid,nodev,noexec",
  "BindReadOnlyPaths=/usr/lib/x86_64-linux-gnu /usr/lib64:/lib64 /usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu",
  "BindReadOnlyPaths=/opt/eidoverse-home/app /opt/eidoverse-home/bin @LIBRARY@:/opt/eidoverse-home/library",
  "BindReadOnlyPaths=/etc/eidoverse-home/agents",
  "BindPaths=/var/lib/eidoverse-home",
  "PrivateUsers=yes", "PrivateDevices=yes", "MountAPIVFS=yes", "TemporaryFileSystem=/run:ro /dev/shm:ro", "InaccessiblePaths=-/dev/mqueue -/dev/hugepages",
  "InaccessiblePaths=-/sys/fs -/sys/kernel -/sys/devices -/sys/firmware -/sys/class -/sys/bus -/sys/block -/sys/dev -/sys/module -/sys/hypervisor -/sys/power",
  "ProtectProc=invisible", "ProcSubset=pid", "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
  "ProtectClock=yes", "ProtectHostname=yes", "PrivateIPC=yes", "UMask=0077",
  "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=", "RestrictNamespaces=yes", "RestrictSUIDSGID=yes", "RestrictRealtime=yes",
  "LockPersonality=yes", "KeyringMode=private", "SystemCallArchitectures=native", "SystemCallErrorNumber=EPERM",
  "SystemCallFilter=@system-service", "SystemCallFilter=~@privileged @resources", "SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register",
];
const box = unit("sandbox.conf");
S.ok(Object.keys(box).join() === "Service", "U2 sandbox.conf is one [Service] section (inside.sh passes its lines as properties)", Object.keys(box));
S.ok(differ(box.Service ?? [], SANDBOX).length === 0 && (box.Service ?? []).length === SANDBOX.length, "U2 sandbox.conf is exactly the pinned lines", differ(box.Service ?? [], SANDBOX));
S.ok((box.Service ?? []).indexOf("TemporaryFileSystem=/:ro") < (box.Service ?? []).findIndex((l) => l.startsWith("Bind")), "U2 the empty root comes before the binds");
S.ok(!text("sandbox.conf").replace(/^#.*$/gm, "").includes("home.env"), "U2 the env file is named nowhere in the sandbox");

// U3: what a service may set beside the sandbox. A key not listed here (NetworkNamespacePath, ExecStartPre, …) fails.
const SERVICE_KEYS = ["User", "Group", "WorkingDirectory", "Type", "ExecStart", "Restart", "RestartSec", "EnvironmentFile", "Environment",
  "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota", "LimitNOFILE", "LimitCORE", "OOMPolicy"];
const ENV_KEYS = ["HOME", "PORT", "HOST", "EIDOVERSE_DIR", "WORLDS_DIR", "BACKUPS_DIR", "OPT_DIR", "SESSIONS_PATH", "AGENT_TOKENS_PATH", "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "SFU_ICE_SERVERS", "OPT_MEM_BUDGET_MB", "SKIP_OPT_SWEEP", "MCPL_PORT", "WORLD_URL", "MCPL_TOKENS", "MCPL_STATE"];
for (const [f, exec, port] of [["eidoverse-home.service", "/opt/eidoverse-home/bin/bun server/server.ts", "PORT=8940"], ["eidoverse-home-door.service", "/opt/eidoverse-home/bin/bun mcpl/net-server.ts", "MCPL_PORT=8941"]] as const) {
  const u = unit(f), sv = u.Service ?? [], env = values(sv, "Environment").flatMap((v) => v.split(/\s+/));
  S.ok(keys(sv).every((k) => SERVICE_KEYS.includes(k)), `U3 ${f} sets only the listed [Service] keys`, keys(sv).filter((k) => !SERVICE_KEYS.includes(k)));
  S.ok(keys(sv).every((k) => !keys(SANDBOX).includes(k)), `U3 ${f} sets no key the sandbox sets`, keys(sv).filter((k) => keys(SANDBOX).includes(k)));
  S.ok(values(sv, "ExecStart").join("|") === exec, `U3 ${f} starts exactly \`${exec}\`, with no privilege prefix`, values(sv, "ExecStart"));
  S.ok(values(sv, "User").join() === "eidoverse-home" && values(sv, "Group").join() === "eidoverse-home", `U3 ${f} runs as eidoverse-home`);
  S.ok(env.every((e) => ENV_KEYS.includes(e.slice(0, e.indexOf("=")))) && env.includes(port), `U3 ${f} sets only the listed environment (no TRUST_NAMES), and ${port}`, env.filter((e) => !ENV_KEYS.includes(e.slice(0, e.indexOf("=")))));
  S.ok(values(sv, "EnvironmentFile")[0] === "/etc/eidoverse-home/home.env", `U3 ${f} reads the env file, and cannot start without it`, values(sv, "EnvironmentFile"));
  S.ok(/^\d+[MG]$/.test(values(sv, "MemoryMax").join()) && values(sv, "MemorySwapMax").join() === "0" && /^\d+$/.test(values(sv, "TasksMax").join()), `U3 ${f} is capped: memory, no swap, tasks`);
  S.ok(values(u.Unit, "AssertPathIsMountPoint").join() === "/var/lib/eidoverse-home", `U3 ${f} starts only on a mounted state`);
}
S.ok(values(unit("eidoverse-home.service").Service, "Environment").join(" ").includes("HOST=127.0.0.1"), "U3 the world server binds loopback inside too");
S.ok(values(unit("eidoverse-home-door.service").Unit, "JoinsNamespaceOf").join() === "eidoverse-home.service", "U3 the door shares the world server's network namespace");
const slice = unit("eidoverse_home.slice").Slice ?? [];
S.ok(/^\d+[MG]$/.test(values(slice, "MemoryMax").join()) && /^\d+$/.test(values(slice, "TasksMax").join()) && /^\d+%$/.test(values(slice, "CPUQuota").join()), "U3 the slice caps the whole: memory, tasks, CPU", slice);

for (const [f, service, port] of [["eidoverse-home-web-proxy.service", "eidoverse-home.service", "8940"], ["eidoverse-home-door-proxy.service", "eidoverse-home-door.service", "8941"]] as const) {
  const u = unit(f), sv = u.Service ?? [], has = (l: string) => sv.includes(l);
  S.ok(has("PrivateNetwork=yes") && values(u.Unit, "JoinsNamespaceOf").join() === "eidoverse-home.service" && !keys(sv).includes("NetworkNamespacePath"), `U4 ${f} lives in the world server's namespace`);
  S.ok(values(sv, "ExecStart").join("|") === `/usr/lib/systemd/systemd-socket-proxyd --connections-max=512 127.0.0.1:${port}`, `U4 ${f} carries connections to 127.0.0.1:${port} and runs nothing else`, values(sv, "ExecStart"));
  S.ok(keys(sv).filter((k) => k.startsWith("Exec")).join() === "ExecStart", `U4 ${f} has no other Exec line`);
  S.ok(values(u.Unit, "Requires").join(" ").split(" ").includes(service) && values(u.Unit, "After").join(" ").split(" ").includes(service), `U4 ${f} needs ${service} up first`);
  S.ok(has("CapabilityBoundingSet=") && has("NoNewPrivileges=yes") && has("DynamicUser=yes") && has("Slice=eidoverse_home.slice"), `U4 ${f} holds no privilege, in the slice`);
}

const start = text("start.sh"), inside = text("inside.sh");
S.ok(/for s in eidoverse-home eidoverse-home-door; do[\s\S]*?sandbox\.conf[\s\S]*?\$s\.service\.d\/10-sandbox\.conf/.test(start), "U5 start.sh installs sandbox.conf as a drop-in of both services");
S.ok(start.includes('"$KIT/export.sh" "$ROOT" $OPT/app') && !/\brsync\b.*\$ROOT/.test(start), "U5 start.sh exports through export.sh only");
S.ok(inside.includes("$SD/eidoverse-home.service $SD/eidoverse-home.service.d/*.conf") && inside.includes("-p JoinsNamespaceOf=eidoverse-home.service"), "U5 inside.sh reads the installed unit and its drop-ins, and joins the server's namespace");
S.ok(inside.includes(`case "$line" in ''|'#'*|ExecStart=*|Type=*|Restart=*|RestartSec=*|OOMPolicy=*) continue;; esac`), "U5 inside.sh skips only the lines a one-off command can't carry");
S.ok(inside.includes('*" PrivateNetwork=yes "*) ;;') && inside.includes('*" TemporaryFileSystem=/:ro "*) ;;') && inside.includes("NeedDaemonReload"), "U5 inside.sh refuses to run without the sandbox's lines, or on units changed since they were loaded");

// U6: export.sh, run. A scratch git checkout with a decoy of each kind; only tracked files and the dependencies arrive.
const need = ["bash", "rsync", "git"].filter((t) => !Bun.which(t));
if (need.length || process.platform === "win32") S.na("U6 the export carries only what git tracks and the dependencies", need.length ? `no ${need.join(", ")} on this host` : "export.sh is for the Linux it installs on");
else {
  const tmp = mkdtempSync(join(tmpdir(), "home-export-")), src = join(tmp, "src"), dst = join(tmp, "out", "app");
  const put = (f: string, body = "x") => { mkdirSync(join(src, f, ".."), { recursive: true }); writeFileSync(join(src, f), body); };
  const tracked = ["server/server.ts", "client/index.html", "mcpl/tokens.example.json", "deploy/home/start.sh"];
  const ignored = [".env", "client/.env.local", "mcpl/.env", "mcpl/tokens.json", "mcpl/state.json", ".sessions.json", ".mcp.json", "worlds/w/log.jsonl", "worlds-dev/w/log.jsonl", "backups/b", "assets/opt/store/x.glb", "services/voicebot/voices.json"];
  const untracked = ["spare/untracked-note.txt"];
  const deps = ["node_modules/a/index.js", "client/node_modules/b/index.js", "mcpl/node_modules/c/index.js"];
  for (const f of [...tracked, ...ignored, ...deps]) put(f);
  put(".gitignore", readFileSync(fileURLToPath(new URL("../../.gitignore", import.meta.url)), "utf8"));
  writeFileSync(join(tmp, "outside-secret"), "x");
  const linked = linkInto(join(tmp, "outside-secret"), join(src, "client/leak")) === "linked";
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git("init", "-q"); git("add", "-A"); git("add", "-f", "client/leak");
  const committed = git("commit", "-q", "-m", "scratch").exitCode === 0;
  for (const f of untracked) put(f);
  const run = () => Bun.spawnSync(["bash", join(KIT, "export.sh"), src, dst]);
  const r = run();
  S.ok(committed && r.exitCode === 0, "U6 export.sh exports a checkout", r.stderr.toString());
  S.ok([...tracked, ...deps].every((f) => existsSync(join(dst, f))), "U6 tracked files and the three dependency directories arrive", [...tracked, ...deps].filter((f) => !existsSync(join(dst, f))));
  S.ok([...ignored, ...untracked, ".git/config"].every((f) => !existsSync(join(dst, f))), "U6 no ignored file, untracked file or git metadata arrives", [...ignored, ...untracked, ".git/config"].filter((f) => existsSync(join(dst, f))));
  if (!linked) S.na("U6 a tracked link out of the checkout is left behind", "this host makes no file symlinks");
  else S.ok(lstatSync(join(dst, "client/leak"), { throwIfNoEntry: false }) === undefined, "U6 a tracked link out of the checkout is left behind, not followed");
  put("server/server.ts", "edited"); rmSync(join(src, "client/index.html"));
  S.ok(run().exitCode === 0 && readFileSync(join(dst, "server/server.ts"), "utf8") === "edited" && !existsSync(join(dst, "client/index.html")), "U6 a second export replaces the first: an edit arrives, a deleted file goes");
  rmSync(join(src, "mcpl/node_modules"), { recursive: true }); linkInto(join(src, "node_modules"), join(src, "mcpl/node_modules"));
  const refused = run();
  S.ok(refused.exitCode !== 0 && readFileSync(join(dst, "server/server.ts"), "utf8") === "edited", "U6 a dependency directory that is a link is refused, and the standing export is left as it was", refused.stderr.toString());
  rmSync(tmp, { recursive: true, force: true });
}
S.done();
