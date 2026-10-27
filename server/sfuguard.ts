/**
 * Containment for a werift bug: it binds no UDP "error" handler (`werift/lib/common/src/transport.js:130-131`), so an
 * ICMP port-unreachable after a peer leaves is an uncaught ECONNREFUSED that kills the world server.
 * At UdpTransport.init, benign errnos on werift-created sockets are swallowed (counted in /relay-diag); all else, and
 * an unowned socket of the same shape (tools/sfu-test.ts), and bind-time errors, are fatal with their stack.
 * Unreached: werift/nonstandard (its own UdpTransport) and MediaStreamTrackFactory.rtpSource; import neither.
 */

import { UdpTransport } from "werift";

/** Structured, never textual: matching message text once swallowed a TypeError. */
const BENIGN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

let installed = false;
let swallowed = 0;
let fatals = 0;

function isBenignTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !BENIGN_CODES.has(code)) return false;
  // REQUIRE a syscall (dgram always sets one): a benign code without one (a failed fetch) must not be swallowed
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return typeof syscall === "string" && /^(recv|send)/.test(syscall);
}

/** Logs the stack itself (Bun loses it on re-throw), then EXITs: an unknown error is an unknown state, and recovery
 *  (restart → new incarnation → one clean rejoin) needs the restart. */
function reportFatal(err: unknown, kind: string, onFatal?: (e: unknown, k: string) => void) {
  console.error(`\n[sfu] FATAL (${kind}):`);
  console.error(err instanceof Error && err.stack ? err.stack : err);
  fatals++;
  try { onFatal?.(err, kind); } catch { /* never recurse */ }
  process.exit(1);
}
export const transportFatals = () => fatals;

/** INSTALL ORDER IS LOAD-BEARING: before the first Sfu / RTCPeerConnection, since an earlier socket has no handler.
 *  Once, at boot (server.ts). uncaughtException and unhandledRejection don't share a handler. */
export function installSfuTransportGuard(onFatal?: (err: unknown, kind: string) => void) {
  if (installed) {
    if (onFatal) console.warn("[sfu] transport guard already installed — second onFatal ignored");
    return;
  }
  installed = true;
  console.log("[sfu] transport guard installed (werift-owned UDP errno containment)");

  // ── the ownership seam: every werift dgram socket (STUN and TURN too) is made in UdpTransport.init
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
    // the callback-send path surfaces the same errnos as a rejection: contained here, never at process scope
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

/** /relay-diag: a climbing count is normal churn; a spike means peers are dying too fast. */
export function transportErrorsSwallowed() { return swallowed; }

/** Exported for tests: the classifier is the security-relevant half. */
export const __isBenignTransportError = isBenignTransportError;
