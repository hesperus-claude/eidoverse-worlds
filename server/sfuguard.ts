/**
 * Containment for a werift bug that would otherwise crash the world server. werift binds no UDP "error" handler
 * (`werift/lib/common/src/transport.js:130-131`), so an ICMP port-unreachable after a peer leaves surfaces as an
 * uncaught ECONNREFUSED and takes the process with it.
 *
 * Patched at the ownership seam, UdpTransport.init: on werift-created sockets, positively-identified benign errnos are
 * swallowed (counted in /relay-diag) and everything else is fatal with its stack. The process handlers are pure fatal
 * reporters, so an unowned socket with the same errno/syscall shape still dies (tools/sfu-test.ts). Bind-time errors
 * stay fatal. Reporters log the original stack themselves (Bun loses it on re-throw); uncaughtException and
 * unhandledRejection don't share a handler. server.ts installs it once at boot.
 */

import { UdpTransport } from "werift";

/** errno CODES a dead/unreachable UDP peer produces. Structured, not textual:
 *  matching message text is how v1 swallowed a TypeError. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;
let fatals = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // REQUIRE a syscall: an application error with a benign code but no syscall (a failed fetch) must not be swallowed;
  // dgram always sets one
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Log the crash site ourselves (a bare `throw` in a handler loses the stack on Bun), then EXIT: an unknown error is an
 *  unknown state, and recovery (restart → new incarnation → one clean rejoin) only works if the process restarts. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}):`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  try { onFatal?.(err, kind); } catch { /* a notifier that throws must not recurse */ }
  process.exit(1);
}
export const transportFatals = () => fatals;

/** Containment is bound to OWNED werift transports. INSTALL ORDER IS LOAD-BEARING: install BEFORE the first Sfu /
 *  RTCPeerConnection, since an earlier socket has no handler. Benign errnos on werift sockets are counted; every other
 *  uncaught failure, including a non-werift dgram socket with the identical shape, logs its stack and exits nonzero. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) {
    if (onFatal) console.warn("[sfu] transport guard already installed — second onFatal ignored");
    return;
  }
  installed = true;
  console.log("[sfu] transport guard installed (werift-owned UDP errno containment)");

  // ── the ownership seam: every raw dgram socket werift makes is created in UdpTransport.init (STUN and TURN construct
  // through it), so wrapping the static gives the benign handler to exactly the sockets werift created
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
    // The callback-send path surfaces the same errnos as a rejection rather
    // than an emitter error; contain it at the same seam so it never reaches
    // process scope.
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
