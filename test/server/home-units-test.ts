// deploy/home/ is a server on someone's own machine, in a sandbox: these rows read its unit files and refuse the edits
// that would open it. What must hold:
//   U1  each way in listens on 127.0.0.1 and nowhere else;
//   U2  the sandbox drop-in keeps its network namespace, its empty read-only root and its privilege lines;
//   U3  the only writable bind is the state, and every read-only bind is one the list here names;
//   U4  the two services take their sandbox from the drop-in alone, read the env file, and are capped;
//   U5  each proxy lives in the world server's namespace and points at the port its service listens on;
//   U6  start.sh gives both services the drop-in, and inside.sh reads the installed units;
//   U7  the export leaves out git metadata, a .env and a checkout's runtime files (rsync run over a scratch tree).
//
//   bun test/server/home-units-test.ts
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";

const S = suite("home-units");
const KIT = fileURLToPath(new URL("../../deploy/home/", import.meta.url));
const text = (name: string) => readFileSync(join(KIT, name), "utf8");
/** A unit file's values by `Section.Key`, in order; a key set twice keeps both. */
function unit(name: string): Map<string, string[]> {
  const out = new Map<string, string[]>(); let section = "";
  for (const raw of text(name).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line.slice(1, -1); continue; }
    const at = line.indexOf("="), key = `${section}.${line.slice(0, at)}`;
    out.set(key, [...(out.get(key) ?? []), line.slice(at + 1)]);
  }
  return out;
}
const words = (u: Map<string, string[]>, key: string) => (u.get(key) ?? []).flatMap((v) => v.split(/\s+/)).filter(Boolean);
const one = (u: Map<string, string[]>, key: string) => (u.get(key) ?? []).join(" | ");

const files = readdirSync(KIT);
const sockets = files.filter((f) => f.endsWith(".socket"));
S.ok(sockets.length === 2, "U1 two socket units, the page's and the door's", sockets);
for (const f of sockets) {
  const listen = [...unit(f)].filter(([k]) => k.startsWith("Socket.Listen")).flatMap(([, v]) => v);
  S.ok(listen.length === 1 && /^127\.0\.0\.1:\d+$/.test(listen[0]), `U1 ${f} listens on 127.0.0.1 only`, listen);
  S.ok(one(unit(f), "Socket.FreeBind") === "no", `U1 ${f} binds no address the machine doesn't hold`, one(unit(f), "Socket.FreeBind"));
}

const box = unit("sandbox.conf");
for (const [key, want] of [["PrivateNetwork", "yes"], ["IPAddressDeny", "any"], ["IPAddressAllow", "localhost"], ["NoNewPrivileges", "yes"], ["CapabilityBoundingSet", ""],
  ["AmbientCapabilities", ""], ["RestrictNamespaces", "yes"], ["PrivateDevices", "yes"], ["PrivateUsers", "yes"], ["ProtectProc", "invisible"]] as const) {
  S.ok(one(box, `Service.${key}`) === want, `U2 sandbox.conf ${key}=${want}`, one(box, `Service.${key}`));
}
S.ok((box.get("Service.TemporaryFileSystem") ?? [])[0] === "/:ro", "U2 the root is an empty read-only filesystem, set before any bind", box.get("Service.TemporaryFileSystem"));
S.ok(one(box, "Service.SystemCallFilter").startsWith("@system-service | ~@privileged"), "U2 the syscall filter is @system-service less the privileged groups", one(box, "Service.SystemCallFilter"));
S.ok([...box.keys()].every((k) => k.startsWith("Service.")), "U2 sandbox.conf is one [Service] section (inside.sh passes its lines as properties)", [...box.keys()].filter((k) => !k.startsWith("Service.")));

const READ_ONLY = ["/usr/lib/x86_64-linux-gnu", "/usr/lib64:/lib64", "/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu", "/opt/eidoverse-home/app", "/opt/eidoverse-home/bin",
  "@LIBRARY@:/opt/eidoverse-home/library", "/etc/eidoverse-home/agent-tokens.json"];
S.ok(one(box, "Service.BindPaths") === "/var/lib/eidoverse-home", "U3 the one writable bind is the state", one(box, "Service.BindPaths"));
const binds = words(box, "Service.BindReadOnlyPaths");
S.ok(binds.length === READ_ONLY.length && binds.every((b) => READ_ONLY.includes(b)), "U3 the read-only binds are exactly the listed ones (the env file is not among them)", binds.filter((b) => !READ_ONLY.includes(b)));
S.ok(!text("sandbox.conf").replace(/^#.*$/gm, "").includes("home.env"), "U3 the env file is named nowhere in the sandbox");

const services = { "eidoverse-home.service": "PORT=8940", "eidoverse-home-door.service": "MCPL_PORT=8941" };
for (const [f, port] of Object.entries(services)) {
  const u = unit(f);
  const own = [...u.keys()].filter((k) => box.has(k));
  S.ok(own.length === 0, `U4 ${f} sets no line the sandbox sets`, own);
  S.ok(one(u, "Service.EnvironmentFile") === "/etc/eidoverse-home/home.env", `U4 ${f} reads the env file`, one(u, "Service.EnvironmentFile"));
  S.ok(one(u, "Service.User") === "eidoverse-home" && one(u, "Unit.AssertPathIsMountPoint") === "/var/lib/eidoverse-home", `U4 ${f} runs as its own user, on a mounted state only`);
  S.ok(/^\d+[MG]$/.test(one(u, "Service.MemoryMax")) && one(u, "Service.MemorySwapMax") === "0" && /^\d+$/.test(one(u, "Service.TasksMax")), `U4 ${f} is capped: memory, no swap, tasks`, [one(u, "Service.MemoryMax"), one(u, "Service.TasksMax")]);
  S.ok(words(u, "Service.Environment").includes(port), `U4 ${f} listens on ${port}`, words(u, "Service.Environment"));
}
S.ok(words(unit("eidoverse-home.service"), "Service.Environment").includes("HOST=127.0.0.1"), "U4 the world server binds loopback inside too");
S.ok(one(unit("eidoverse-home-door.service"), "Unit.JoinsNamespaceOf") === "eidoverse-home.service", "U4 the door shares the world server's network namespace");

for (const [f, service, port] of [["eidoverse-home-web-proxy.service", "eidoverse-home.service", "8940"], ["eidoverse-home-door-proxy.service", "eidoverse-home-door.service", "8941"]] as const) {
  const u = unit(f);
  S.ok(one(u, "Service.PrivateNetwork") === "yes" && one(u, "Unit.JoinsNamespaceOf") === "eidoverse-home.service", `U5 ${f} lives in the world server's namespace`);
  S.ok(one(u, "Service.ExecStart").endsWith(` 127.0.0.1:${port}`), `U5 ${f} carries connections to 127.0.0.1:${port}`, one(u, "Service.ExecStart"));
  S.ok(words(u, "Unit.Requires").includes(service) && words(u, "Unit.After").includes(service), `U5 ${f} needs ${service} up first`, one(u, "Unit.Requires"));
  S.ok(one(u, "Service.CapabilityBoundingSet") === "" && one(u, "Service.NoNewPrivileges") === "yes" && one(u, "Service.DynamicUser") === "yes", `U5 ${f} holds no privilege`);
}

const start = text("start.sh"), inside = text("inside.sh");
S.ok(/for s in eidoverse-home eidoverse-home-door; do[\s\S]*?sandbox\.conf[\s\S]*?\$s\.service\.d\/10-sandbox\.conf/.test(start), "U6 start.sh installs sandbox.conf as a drop-in of both services");
S.ok(inside.includes("$SD/eidoverse-home.service $SD/eidoverse-home.service.d/*.conf") && inside.includes("JoinsNamespaceOf=eidoverse-home.service"), "U6 inside.sh reads the installed unit and its drop-ins, and joins the server's namespace");
S.ok(start.includes('--exclude-from="$KIT/export-exclude"') && start.includes("--delete-excluded"), "U6 start.sh exports through export-exclude, and removes what an older export carried");

// U7: the exclude list, run. A decoy of each kind in a scratch checkout; none may arrive, and the code must.
if (!Bun.which("rsync")) S.na("U7 the export leaves out .git, .env and runtime files", "no rsync on this host");
else {
  const tmp = mkdtempSync(join(tmpdir(), "home-export-")), src = join(tmp, "src"), dst = join(tmp, "dst");
  const decoys = [".git/config", ".env", ".env.local", "worlds/w/log.jsonl", "backups/b", "assets/opt/store/x.glb", ".sessions.json", "mcpl/tokens.json", "mcpl/state.json", "client/.git/config"];
  const kept = ["server/server.ts", "mcpl/tokens.example.json", "client/worlds/kept.js", "docs/.env-notes.md"];
  for (const f of [...decoys, ...kept]) { mkdirSync(join(src, f, ".."), { recursive: true }); writeFileSync(join(src, f), "x"); }
  const r = Bun.spawnSync(["rsync", "-a", "--delete", "--delete-excluded", `--exclude-from=${join(KIT, "export-exclude")}`, `${src}/`, `${dst}/`]);
  S.ok(r.exitCode === 0, "U7 rsync takes export-exclude", r.stderr.toString());
  S.ok(decoys.every((f) => !existsSync(join(dst, f))), "U7 the export leaves out .git, .env and runtime files", decoys.filter((f) => existsSync(join(dst, f))));
  S.ok(kept.every((f) => existsSync(join(dst, f))), "U7 the export keeps the code, and same-named files elsewhere in the tree", kept.filter((f) => !existsSync(join(dst, f))));
  rmSync(tmp, { recursive: true, force: true });
}
S.done();
