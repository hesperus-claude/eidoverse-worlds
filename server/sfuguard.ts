/**
 * Containment for a werift bug that would otherwise crash the world server, scoped to the sockets werift owns.
 *
 * werift creates its UDP socket and binds "message" but never "error" (`werift/lib/common/src/transport.js:130-131`;
 * the ESM bundle mirrors it). An unhandled `'error'` on an EventEmitter throws globally, so when a peer's socket dies
 * and the kernel answers our next send with ICMP port-unreachable, dgram surfaces ECONNREFUSED and takes the process
 * with it ("someone left a busy room, the world server died"). Upstream fix is one line in their transport.
 *
 * Containment sits at the OWNERSHIP SEAM: every raw UDP socket werift creates flows through `UdpTransport.init`, so
 * patching it gives each werift-created socket an "error" handler that swallows positively-identified benign errnos
 * (counted, in /relay-diag) and treats everything else as fatal-with-stack; `send` is wrapped for the callback path.
 * The process-global handlers are PURE fatal reporters (shape is not ownership): an unowned socket erroring with the
 * same errno/syscall must die, and does (tools/sfu-test.ts).
 *
 * Edges: bind-time errors stay default-fatal (the handler attaches after init resolves; EADDRINUSE is not churn).
 * MediaStreamTrackFactory.rtpSource and `werift/nonstandard` create sockets outside the seam; nothing here uses them.
 * A bare re-throw in a handler loses the stack on Bun, so the reporters log it themselves; `uncaughtException` and
 * `unhandledRejection` do not share a handler. server.ts installs this once at boot; constructing an Sfu never does.
 */

import { UdpTransport } from "werift";

/** errno CODES a dead/unreachable UDP peer produces. Structured, never message text. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;
let fatals = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // 🔴 REQUIRE a syscall: an application error with a benign code and no syscall (`Error("fetch failed",
  // code=ECONNREFUSED)`) must not be swallowed. dgram always sets one.
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Log the crash site ourselves (a bare `throw` in a handler loses the stack on Bun), then EXIT. An unknown error is
 *  an unknown process state, never "voice degraded but alive": amendment 2's recovery (restart → durable incarnation
 *  advances → every credential stale → one clean rejoin) needs the process to actually restart. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}):`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  try { onFatal?.(err, kind); } catch { /* a notifier that throws must not recurse */ }
  process.exit(1);
}
export const transportFatals = () => fatals;

/** Containment is bound to OWNED werift transport; every other uncaught failure logs its stack and exits nonzero.
 *  🔴 INSTALL ORDER IS LOAD-BEARING: only transports created AFTER installation are covered, so install BEFORE the
 *  first Sfu / RTCPeerConnection construction. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) {
    if (onFatal) console.warn("[sfu] transport guard already installed — second onFatal ignored");
    return;
  }
  installed = true;
  console.log("[sfu] transport guard installed (werift-owned UDP errno containment)");

  // ── the ownership seam ────────────────────────────────────────────────────
  // Every raw dgram socket werift makes is created inside UdpTransport.init (STUN and TURN both construct through it),
  // so wrapping it IS positive ownership.
  type UdpInit = typeof UdpTransport.init;
  const origInit: UdpInit = UdpTransport.init.bind(UdpTransport);
  (UdpTransport as { init: UdpInit }).init = (async (...args: Parameters<UdpInit>) => {
    const t = await origInit(...args);
    const sock = (t as unknown as { socket?: NodeJS.EventEmitter }).socket;
    if (sock && typeof sock.on === "function") {
      sock.on("error", (err: unknown) => {
        if (isBenignTransportError(err)) { swallowed++; return; }
        reportFatal(err, "werift-udp error", onFatal);
      });
    }
    // the callback-send path surfaces the same errnos as a rejection: contain it at the same seam
    const origSend = (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send;
    if (typeof origSend === "function") {
      (t as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send = async (...a: unknown[]) => {
        try { return await origSend.apply(t, a); }
        catch (err) { if (isBenignTransportError(err)) { swallowed++; return; } throw err; }
      };
    }
    return t;
  }) as UdpInit;

  // ── process scope: pure fatal reporters, NO benign branch ────────────────
  process.on("uncaughtException", (err) => reportFatal(err, "uncaughtException", onFatal));
  process.on("unhandledRejection", (reason) => reportFatal(reason, "unhandledRejection", onFatal));
}

/** Surfaced in /relay-diag: a climbing count is normal churn, but a spike means
 *  peers are dying faster than they should and is worth looking at. */
export function transportErrorsSwallowed() { return swallowed; }

/** Exported for tests — the classifier is the security-relevant half. */
export const __isBenignTransportError = isBenignTransportError;
