// A world address for a test's WorldAgent that has no world: every read answers 404 at once. Without one the agent falls
// back to ws://127.0.0.1:8940 (agent.ts), which a dev server may answer, and a closed loopback port can hang (WSL).
let server: ReturnType<typeof Bun.serve> | null = null;
/** One per process, unref'd so it never keeps a test alive. */
export function noWorldUrl(): string {
  if (!server) {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no world here", { status: 404 }) });
    server.unref();
  }
  return `ws://127.0.0.1:${server.port}/ws`;
}
