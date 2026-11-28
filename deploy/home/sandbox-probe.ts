// What could code running as the home server do? This tries: read and write outside its state, reach the machine's
// loopback, the LAN and the internet, run a shell or a dropped binary, gain privilege, fill the disk, fork without end.
//   bun deploy/home/sandbox-probe.ts --outside [--also=/a/path,...]
//       the control, as yourself: an attempt that reads "present" here and "blocked" inside is the sandbox's doing; one
//       that reads "ABSENT" here too is refused by ordinary permissions and proves nothing about the sandbox.
//       It finds this machine's own network targets and prints the command for the inside run.
//   sudo -u eidoverse-home /opt/eidoverse-home/bin/bun /opt/eidoverse-home/app/deploy/home/sandbox-probe.ts --outside
//       the stricter control: the server's own user with no sandbox.
//   sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts [--also=...] [--net=host:port,...]
//       inside: every line should read "blocked"; it exits 1 on any BREACH. --only=fs,net,exec,fork picks groups.
//   sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts --only=disk     (on an idle server: it fills the state)
//   sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts --only=mem
//       allocates until the cgroup kills it (so no summary follows); `journalctl -k` shows the kill and its unit.
// It prints names, sizes and error codes, never a file's contents. docs/research/home-sandbox.md has a run.
import fs from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";

const OUTSIDE = process.argv.includes("--outside");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (name: string) => (arg(name) ?? "").split(",").filter(Boolean);
const only = arg("only");
const want = (group: string) => (only ? only.split(",").includes(group) : group !== "mem" && group !== "disk");
if (OUTSIDE && process.getuid!() === 0) { console.error("the control runs as an ordinary user, not root: its attempts are real"); process.exit(2); }
const STATE = "/var/lib/eidoverse-home", OPT = "/opt/eidoverse-home";
let bad = 0, blocked = 0;
// inside, an attempt that got through is a breach; outside, it is the control passing
const line = (what: string, reached: boolean, detail: string) => {
  const verdict = OUTSIDE ? (reached ? "present  " : "ABSENT(!)") : reached ? "BREACH(!)" : "blocked  ";
  if (!OUTSIDE) reached ? bad++ : blocked++;
  console.log(`  ${verdict} ${what.padEnd(58)} ${detail}`);
};
const code = (e: any) => e?.code ?? e?.errno ?? String(e?.message ?? e).slice(0, 60);
const names = (dir: string) => { try { return fs.readdirSync(dir).join(" ") || "(empty)"; } catch (e) { return String(code(e)); } };

function read(path: string) {
  try {
    const st = fs.statSync(path);
    if (st.isDirectory()) return line(`read ${path}`, true, `dir, ${fs.readdirSync(path).length} entries`);
    const fd = fs.openSync(path, "r"), n = fs.readSync(fd, Buffer.alloc(16)); fs.closeSync(fd);
    line(`read ${path}`, true, `file, ${st.size} bytes (read ${n})`);
  } catch (e) { line(`read ${path}`, false, code(e)); }
}
/** Whether a TCP connect to host:port succeeds, and how it ended. */
function connect(host: string, port: number, ms = 2500): Promise<[boolean, string]> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res([false, "timeout"]); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res([true, "connected"]); });
    s.on("error", (e) => { clearTimeout(t); res([false, String(code(e))]); });
  });
}
const tcp = async (host: string, port: number, note = "") => { const [ok, how] = await connect(host, port); line(`tcp ${host}:${port}${note && ` (${note})`}`, ok, how); return ok; };
function udpDns(host: string, ms = 2000): Promise<void> {
  return new Promise((res) => {
    const s = dgram.createSocket("udp4");
    const q = Buffer.from("123401000001000000000000076578616d706c6503636f6d0000010001", "hex");   // example.com A
    const end = (ok: boolean, how: string) => { clearTimeout(t); try { s.close(); } catch { /* closed */ } line(`udp dns ${host}:53`, ok, how); res(); };
    const t = setTimeout(() => end(false, "no reply"), ms);
    s.on("message", (m) => end(true, `reply ${m.length} bytes`));
    s.on("error", (e) => end(false, String(code(e))));
    s.send(q, 53, host, (e) => { if (e) end(false, String(code(e))); });
  });
}
/** This machine's own targets, read outside: the default gateway, and up to 24 TCP ports something here listens on
 *  (the home server's own two ways in left out: inside, that address is the sandbox's own server). */
function localTargets(): [string, number, string][] {
  const out: [string, number, string][] = [];
  try {
    for (const row of fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const [, dest, gw] = row.split("\t");
      if (dest === "00000000" && gw) { const ip = gw.match(/../g)!.reverse().map((h) => parseInt(h, 16)).join("."); for (const p of [53, 80, 443]) out.push([ip, p, "the default gateway"]); }
    }
  } catch { /* no route table */ }
  const own = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
  const any = (port: number) => { out.push(["127.0.0.1", port, "a service on this machine"]); for (const a of own.slice(0, 1)) out.push([a, port, "the same, by this machine's LAN address"]); };
  try {
    for (const row of fs.readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) {
      const f = row.trim().split(/\s+/); if (f[3] !== "0A") continue;                                 // 0A: listening
      const [hex, portHex] = f[1].split(":"), port = parseInt(portHex, 16);
      const ip = hex.match(/../g)!.reverse().map((h) => parseInt(h, 16)).join(".");
      if (ip === "0.0.0.0") any(port); else out.push([ip, port, ip.startsWith("127.") ? "a loopback service on this machine" : "a service on this machine"]);
    }
  } catch { /* no /proc/net/tcp */ }
  try {   // a listener on :: takes IPv4 too; ::1 is the machine's IPv6 loopback
    for (const row of fs.readFileSync("/proc/net/tcp6", "utf8").split("\n").slice(1)) {
      const f = row.trim().split(/\s+/); if (f[3] !== "0A") continue;
      const [hex, portHex] = f[1].split(":"), port = parseInt(portHex, 16);
      if (/^0+$/.test(hex)) any(port); else if (/^0+01000000$/.test(hex)) out.push(["::1", port, "an IPv6 loopback service on this machine"]);
    }
  } catch { /* no IPv6 */ }
  const mine = new Set<string>();
  for (const unit of ["eidoverse-home-web-proxy.socket", "eidoverse-home-door-proxy.socket"]) {
    const r = spawnSync("systemctl", ["show", "-p", "Listen", "--value", unit], { encoding: "utf8" });
    for (const m of (r.stdout ?? "").matchAll(/(\S+:\d+) \(Stream\)/g)) mine.add(m[1]);
  }
  const seen = new Set<string>();
  return out.filter(([h, p]) => !mine.has(`${h}:${p}`) && !seen.has(`${h}:${p}`) && !!seen.add(`${h}:${p}`)).slice(0, 24);
}

console.log(`== probe ${OUTSIDE ? "OUTSIDE (the control)" : "INSIDE the sandbox"}: uid=${process.getuid!()} gid=${process.getgid!()} groups=[${process.getgroups!()}] cwd=${process.cwd()}`);
const home = OUTSIDE ? os.homedir() : "";
const also = [...list("also"), ...(OUTSIDE ? [home, `${home}/.ssh`, `${home}/.config`, `${home}/.gitconfig`].filter((p) => fs.existsSync(p)) : [])];

if (want("fs")) {
  console.log("-- filesystem: read");
  if (!OUTSIDE) console.log(`  (the whole root in here: ${names("/")} | /usr: ${names("/usr")} | /etc: ${names("/etc")} | /opt: ${names("/opt")} | /var: ${names("/var")} | /dev: ${names("/dev")})`);
  for (const p of [...also, "/home", "/root", "/mnt", "/media", "/srv", "/etc/passwd", "/etc/shadow", "/etc/ssh", "/etc/systemd", "/etc/eidoverse-home/home.env",
    `${OPT}/app/.git`, "/var/log", "/var/lib/systemd", "/bin/sh", "/usr/bin", "/usr/sbin", "/run/user", "/run/systemd/private", "/proc/1/environ", "/proc/1/root",
    "/sys/fs/cgroup", "/sys/class/net", "/sys/kernel"]) read(p);
  if (!OUTSIDE) for (const d of ["/sys", "/dev/shm", "/run", "/tmp", STATE]) console.log(`  (info) ${d} holds: ${names(d)}`);
  {
    const pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    const foreign = pids.filter((p) => { try { return fs.readFileSync(`/proc/${p}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1] !== String(process.getuid!()); } catch { return false; } });
    line("see another user's process in /proc", foreign.length > 0, `${pids.length} pids visible, ${foreign.length} not this uid's`);
    console.log("-- filesystem: write outside the state");
    for (const p of ["/x", `${OPT}/app/x`, `${OPT}/app/server/server.ts`, `${OPT}/bin/bun`, `${OPT}/library/x`, "/etc/eidoverse-home/agents/agent-tokens.json", "/etc/eidoverse-home/agents/x", "/usr/lib/x86_64-linux-gnu/x",
      "/etc/x", "/home/x", "/run/x", "/dev/x", "/dev/shm/x", "/dev/mqueue/x", "/dev/hugepages/x", "/sys/x", "/proc/sys/kernel/hostname"]) {
      const was = fs.existsSync(p);
      try { fs.closeSync(fs.openSync(p, "a")); line(`write ${p}`, true, "opened for append"); if (!was) fs.unlinkSync(p); } catch (e) { line(`write ${p}`, false, code(e)); }
    }
    try { fs.mkdirSync("/home/x"); line("mkdir /home/x", true, "created"); fs.rmdirSync("/home/x"); } catch (e) { line("mkdir /home/x", false, code(e)); }
    if (!OUTSIDE) {
      try { fs.writeFileSync(`${STATE}/worlds/.probe`, "ok"); fs.unlinkSync(`${STATE}/worlds/.probe`); console.log(`  (control) write ${STATE}/worlds/.probe: ok, the one place it may write`); }
      catch (e) { console.log(`  (control) write ${STATE}/worlds FAILED: ${code(e)}; the server could not run`); bad++; }
    }
  }
}

if (want("net")) {
  console.log("-- network");
  const ifs = os.networkInterfaces();
  console.log(`  interfaces: ${Object.entries(ifs).map(([n, a]) => `${n}[${(a ?? []).map((x) => x.address).join(",")}]`).join(" ") || "(none)"}`);
  if (!OUTSIDE) line("has an interface besides loopback", Object.keys(ifs).some((n) => n !== "lo"), Object.keys(ifs).join(",") || "none");
  const reached: string[] = [];
  const targets: [string, number, string][] = OUTSIDE ? localTargets() : list("net").map((t) => [t.slice(0, t.lastIndexOf(":")), Number(t.slice(t.lastIndexOf(":") + 1)), "named by the control"]);
  if (!OUTSIDE && !targets.length) console.log("  (no --net targets: run the control first; only the internet is tried below)");
  for (const [h, p, note] of targets) if (await tcp(h, p, note)) reached.push(`${h}:${p}`);
  await tcp("1.1.1.1", 443, "the internet"); await tcp("2606:4700:4700::1111", 443, "the internet, IPv6");
  await udpDns("1.1.1.1");
  try { const a = await Promise.race([dns.lookup("example.com"), new Promise<never>((_, rej) => setTimeout(() => rej({ code: "timeout 6s" }), 6000))]); line("dns lookup example.com", true, a.address); } catch (e) { line("dns lookup example.com", false, code(e)); }
  try { const r = await fetch("https://example.com", { signal: AbortSignal.timeout(3000) }); line("fetch https://example.com", true, `status ${r.status}`); } catch (e) { line("fetch https://example.com", false, code(e)); }
  if (OUTSIDE) console.log(`\n  now, inside:\n    sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts${also.length ? ` --also=${also.join(",")}` : ""}${reached.length ? ` --net=${reached.join(",")}` : ""}\n`);
  else {
    const [ok, how] = await connect("127.0.0.1", 8940, 4000);
    console.log(`  (control) tcp 127.0.0.1:8940, the server on the sandbox's own loopback: ${how}${ok ? ", so the failures above are not a dead socket API" : ""}`);
    if (!ok) bad++;
  }
}

if (want("exec")) {
  console.log("-- exec and privilege");
  for (const c of ["/bin/sh", "/usr/bin/sudo", "/usr/bin/curl", "/usr/bin/python3"]) { const r = spawnSync(c, ["-c", "id"], { timeout: 4000 }); line(`exec ${c}`, !r.error, r.error ? String(code(r.error)) : `ran, status ${r.status}`); }
  for (const dir of [STATE, "/tmp", "/run", "/dev/shm", "/dev"]) {   // bring your own binary: copy bun where it may write, then run it
    const dst = `${dir}/.probe-bin`;
    try { fs.copyFileSync(process.execPath, dst); fs.chmodSync(dst, 0o755); const r = spawnSync(dst, ["--version"], { timeout: 8000 }); line(`exec a binary dropped in ${dir}`, !r.error, r.error ? String(code(r.error)) : `ran, status ${r.status}`); }
    catch (e) { line(`exec a binary dropped in ${dir}`, false, code(e)); } finally { try { fs.unlinkSync(dst); } catch { /* never written */ } }
  }
  for (const [n, f] of [["setuid(0)", () => process.setuid!(0)], ["setgid(0)", () => process.setgid!(0)], ["setgroups([0,27])", () => process.setgroups!([0, 27])]] as const) {
    try { f(); line(n, true, `now uid ${process.getuid!()}`); } catch (e) { line(n, false, code(e)); }
  }
  try { process.kill(1, 0); line("signal pid 1", true, "allowed"); } catch (e) { line("signal pid 1", false, code(e)); }
  const st = fs.readFileSync("/proc/self/status", "utf8"), g = (k: string) => st.match(new RegExp(`^${k}:\\s+(.*)$`, "m"))?.[1];
  // the kernel's own account of this process: systemd turns a sandbox feature off without a word where the kernel lacks it
  line("hold a capability", !/^0+$/.test(g("CapEff") ?? "") || !/^0+$/.test(g("CapBnd") ?? ""), `CapEff=${g("CapEff")} CapBnd=${g("CapBnd")}`);
  line("gain privilege through exec (no NoNewPrivs)", g("NoNewPrivs") !== "1", `NoNewPrivs=${g("NoNewPrivs")}`);
  line("make any syscall (no seccomp filter)", g("Seccomp") !== "2", `Seccomp=${g("Seccomp")} Seccomp_filters=${g("Seccomp_filters")}`);
  try {   // raw syscalls through libc: what a native exploit would reach for
    const { dlopen, FFIType, ptr, read: mem } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      unshare: { args: [FFIType.i32], returns: FFIType.i32 }, mount: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 }, ptrace: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    const errno = () => mem.i32(libc.symbols.__errno_location() as any, 0);
    const cs = (s: string) => ptr(Buffer.from(s + "\0"));
    const sys = (name: string, r: number | bigint) => line(`syscall ${name}`, Number(r) >= 0, Number(r) >= 0 ? `returned ${r}` : `errno ${errno()}`);
    sys("socket(AF_PACKET, SOCK_RAW)", libc.symbols.socket(17, 3, 0x0300));
    sys("socket(AF_INET, SOCK_RAW, ICMP)", libc.symbols.socket(2, 3, 1));
    sys("ptrace(PTRACE_ATTACH, pid 1)", libc.symbols.ptrace(16n, 1, null, null));
    // last: outside, a new user namespace succeeds on most machines and changes what the calls after it may do
    sys("unshare(CLONE_NEWUSER)", libc.symbols.unshare(0x10000000));
    sys("unshare(CLONE_NEWNET)", libc.symbols.unshare(0x40000000));
    sys("unshare(CLONE_NEWNS)", libc.symbols.unshare(0x00020000));
    sys("mount(tmpfs on /tmp)", libc.symbols.mount(cs("none"), cs("/tmp"), cs("tmpfs"), 0n, null));
  } catch (e) { console.log(`  the raw-syscall attempts did not run: ${code(e)}`); bad++; }
}

if (want("disk") && !OUTSIDE) {
  console.log("-- fill the disk");
  for (const dir of [STATE, "/tmp"]) {   // the caps are the mounts' own sizes: nothing outside to compare with
    const f = `${dir}/.probe-fill`, chunk = Buffer.alloc(32 << 20, 1); let wrote = 0, err = "";
    try { const fd = fs.openSync(f, "w"); try { while (wrote < 64 * 2 ** 30) wrote += fs.writeSync(fd, chunk); } finally { fs.closeSync(fd); } } catch (e) { err = String(code(e)); } finally { try { fs.unlinkSync(f); } catch { /* never written */ } }
    line(`write without end to ${dir}`, !err, err ? `stopped by ${err} after ${(wrote / 2 ** 20).toFixed(0)} MB; file removed` : `wrote ${(wrote / 2 ** 30).toFixed(0)} GB unchecked; file removed`);
  }
}

if (want("fork") && !OUTSIDE) {
  console.log("-- fork without end (each child is a sleeping bun; TasksMax counts its threads too)");
  const kids: ReturnType<typeof spawn>[] = []; let err = "";
  for (let i = 0; i < 2000 && !err; i++) {
    try { const k = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" }); await new Promise<void>((res) => { k.once("spawn", () => { kids.push(k); res(); }); k.once("error", (e) => { err = String(code(e)); res(); }); }); } catch (e) { err = String(code(e)); }
  }
  line("spawn 2000 processes", !err, err ? `refused at child ${kids.length + 1} with ${err}` : "all 2000 spawned");
  for (const k of kids) try { k.kill("SIGKILL"); } catch { /* gone */ }
}

if (want("mem") && !OUTSIDE) {
  console.log("-- memory without end (expect this process to be killed: no summary line follows)");
  const hog: Buffer[] = []; for (;;) { hog.push(Buffer.alloc(256 << 20, 1)); console.log(`  holding ${hog.length * 256} MB`); }
}

console.log(OUTSIDE ? "== control done: a line that reads ABSENT here is refused by ordinary permissions, with or without the sandbox" : bad ? `== ${bad} BREACH(ES), ${blocked} blocked` : `== no breach: ${blocked} attempts, every one blocked`);
process.exit(bad ? 1 : 0);
