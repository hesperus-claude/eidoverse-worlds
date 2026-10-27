// The verdict render-watchdog.ts passes on a renderer page, apart from the devtools plumbing, so it tests without a
// browser (tools/render-health-test.ts). Never probe anything the client displays: scraping #hud's fps once killed
// every healthy renderer (docs/INCIDENTS.md).

export const TIMEOUT = Symbol("timeout");
/** Awaits a promise; TIMEOUT after `ms`. */
export type Evaluate = (expr: string, ms?: number) => Promise<unknown>;
export type Health = { alive: boolean; healthy: boolean; reason: string; fps?: number };

export const PROBES = {
  /** any answer means the main thread is not hung */
  alive: "1+1",
  /** counted here, never read off the page */
  frames: "new Promise(r=>{let n=0;const t=performance.now();const f=()=>{n++;performance.now()-t<1000?requestAnimationFrame(f):r(n)};requestAnimationFrame(f)})",
  /** the lite client has no EW, so it never passes */
  joined: "!!(window.EW?.net?.joined)",
  /** 17-111 ms on the main thread every CHECK_SEC; the only probe that sees a world pass throwing every frame */
  capture: "import('/lib/capture.js').then(m => m.captureFrame().length).catch(e => 'ERR ' + (e?.message ?? e))",
} as const;

/** Four probes in order; each gates the next. */
export async function judge(evaluate: Evaluate): Promise<Health> {
  if ((await evaluate(PROBES.alive)) === TIMEOUT) return { alive: true, healthy: false, reason: "main thread hung" };
  const counted = await evaluate(PROBES.frames, 5000);
  const fps = counted === TIMEOUT ? 0 : Number(counted) || 0;
  // joined comes BEFORE capture: a lite page can still import capture.js and return a frame's worth of bytes
  const joined = (await evaluate(PROBES.joined)) === true;
  if (!joined) return { alive: true, healthy: false, reason: "not joined", fps };
  if (fps <= 0) return { alive: true, healthy: false, reason: "no frames", fps };
  // frame.js catches each section's errors, so a world pass throwing every frame still counts 60/s: test what /snap does
  const cap = await evaluate(PROBES.capture, 10000);
  if (cap === TIMEOUT) return { alive: true, healthy: false, reason: "capture timed out", fps };
  if (typeof cap !== "number" || !(cap > 0)) return { alive: true, healthy: false, reason: `capture failed: ${String(cap).slice(0, 120)}`, fps };
  return { alive: true, healthy: true, reason: `fps=${fps} snap=${(cap / 1024).toFixed(0)}KB`, fps };
}

/** the URL it launched says ?renderer */
export const rendererPage = (url: string) => url.includes("renderer");

/** The watchdog's whole check; tools/roaming-renderer-check.ts runs it against real devtools and a real page. */
export async function health(port: number, match: (url: string) => boolean = rendererPage): Promise<Health> {
  let list: any;
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4000) })).json(); }
  catch { return { alive: false, healthy: false, reason: "chrome down" }; }
  const page = list.find((t: any) => t.type === "page" && match(String(t.url)));
  if (!page?.webSocketDebuggerUrl) return { alive: true, healthy: false, reason: "no renderer page" };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = await new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); setTimeout(() => res(false), 4000); });
  if (!opened) return { alive: true, healthy: false, reason: "cannot attach devtools" };

  let id = 1;
  const evaluate: Evaluate = (expr, ms = 5000) => new Promise<unknown>((res) => {
    const i = id++; let done = false;
    const h = (e: any) => { const m = JSON.parse(String(e.data)); if (m.id === i) { done = true; ws.removeEventListener("message", h); res(m.result?.result?.value); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { if (!done) res(TIMEOUT); }, ms);
  });

  try { return await judge(evaluate); }
  finally { ws.close(); }
}

/** Any unhealthy verdict is a strike, `limit` in a row restarts, one healthy check clears them. */
export function tally(strikes: number, h: Health, limit: number): { strikes: number; restart: boolean } {
  if (h.healthy) return { strikes: 0, restart: false };
  const next = strikes + 1;
  return { strikes: next, restart: next >= limit };
}
