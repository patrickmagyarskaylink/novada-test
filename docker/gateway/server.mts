/**
 * server.mts — container entrypoint for the hosted (HTTP) Novada MCP gateway.
 *
 * Wraps `hosted-server/vercel/api/mcp.ts`'s default export — which is already a
 * Node-style `(IncomingMessage, ServerResponse)` handler — in a plain
 * `node:http` server so the SAME code that runs as a Vercel Function can run in
 * a container (ECS/Fargate, App Runner, EKS, or `docker compose` locally).
 *
 * This is the containerized sibling of `hosted-server/vercel/local-harness.mts`.
 * Differences, all deliberate:
 *   - no `.env.local` file loading — container config comes from real env vars
 *   - configurable HOST/PORT (defaults 0.0.0.0:8080)
 *   - SIGTERM/SIGINT graceful drain (ECS sends SIGTERM, then SIGKILL after 30s)
 *   - does NOT set `VERCEL=1` by default: a container CAN hold the persistent
 *     WebSocket the Browser API needs, so `isHostedEnvironment()` must stay
 *     false or `novada_browser` / `render:"browser"` would fail fast for no
 *     reason. Set NOVADA_FORCE_HOSTED_ENV=1 to opt back into serverless
 *     semantics (useful for reproducing a Vercel-only bug).
 *
 * Routes are owned by api/mcp.ts, not by this file:
 *   GET  /            → service banner
 *   GET  /health      → { ok: true } — no auth, no KV; use it as the LB probe
 *   POST /mcp         → MCP Streamable HTTP (auth: ?apikey= or Bearer)
 *   GET  /:key/mcp    → path-based auth variant
 *   /.well-known/*, /register, /authorize, /token → OAuth 2.1 endpoints
 * plus one route this file owns, because Vercel gets it from the filesystem and a
 * single container does not:
 *   POST /api/reconcile → api/reconcile.ts (telemetry backlog cron, CRON_SECRET)
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

/** Longest a single tool call may occupy the socket. Keep >= the gateway's own
 *  TOOL_WALL_CLOCK_MS (296s in api/mcp.ts) plus flush headroom, and keep any
 *  upstream ALB/ingress idle timeout ABOVE this value. */
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 320_000);
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.MCP_KEEP_ALIVE_TIMEOUT_MS ?? 65_000);
const SHUTDOWN_GRACE_MS = Number(process.env.MCP_SHUTDOWN_GRACE_MS ?? 15_000);

if (process.env.NOVADA_FORCE_HOSTED_ENV === "1") {
  process.env.VERCEL = "1";
}

// Import AFTER the env is final: api/mcp.ts runs module-level side effects at
// load time (Sentry init, NOVADA_SERVER_VERSION, stripServerConsumptionCreds()).
const { default: handler } = await import("./api/mcp.js");

// api/reconcile.ts is a SECOND Vercel function (the telemetry push-backlog cron,
// authorized by CRON_SECRET). On Vercel each file is its own route; in one
// container we have to route it ourselves, otherwise mcp.ts's catch-all answers
// 404 and the backlog never drains. Same Node (req, res) handler shape.
const { default: reconcileHandler } = await import("./api/reconcile.js");

const RECONCILE_PATHS = new Set(["/api/reconcile", "/reconcile"]);

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    if (RECONCILE_PATHS.has(path)) {
      await reconcileHandler(req, res);
      return;
    }
    await handler(req, res);
  } catch (err) {
    // api/mcp.ts already converts tool/transport errors into JSON-RPC envelopes;
    // reaching here means the handler itself threw. Never leak the stack.
    console.error("[gateway] unhandled handler error:", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal_error" }));
    } else {
      res.destroy();
    }
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
// Must exceed keepAliveTimeout, else Node races itself on idle connections.
server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[gateway] ${signal} received — draining connections`);
  const timer = setTimeout(() => {
    console.error("[gateway] grace period expired — forcing exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  timer.unref();
  server.close(() => {
    console.error("[gateway] closed cleanly");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  const kvReady = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  const authGate = process.env.STUB_AUTH_WARNING_ACCEPTED === "true";
  console.error(`[gateway] novada-mcp hosted gateway listening on http://${HOST}:${PORT}`);
  console.error(`[gateway] version=${process.env.NOVADA_SERVER_VERSION ?? "unknown"} kv=${kvReady ? "configured" : "MISSING"} auth_gate=${authGate ? "open" : "CLOSED (503 on /mcp)"}`);
  if (!kvReady) console.error("[gateway] WARNING: KV_REST_API_URL/KV_REST_API_TOKEN unset — /mcp will answer 500 KV_NOT_CONFIGURED (/health still works)");
  if (!authGate) console.error("[gateway] WARNING: STUB_AUTH_WARNING_ACCEPTED != true — /mcp will answer 503 STUB_AUTH_UNACKED");
});
