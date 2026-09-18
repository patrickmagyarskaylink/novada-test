# docker/ — container images & local test stack

Two images, because there are two transports (see `../ARCHITECTURE.md`):

| Image | Dockerfile | Transport | Size | Needs infrastructure |
|---|---|---|---|---|
| `novada-mcp:stdio` | `Dockerfile.stdio` | stdio | 579 MB | **no** |
| `novada-mcp:gateway` | `Dockerfile.gateway` | Streamable HTTP (`/mcp`) | 712 MB | **yes** (Redis-over-REST) |

Both carry the same 38-tool catalog and the same dispatch core
(`npm-package/src/core.ts`). The gateway image vendors a fresh npm-package build
exactly the way `hosted-server/scripts/sync-to-hosted.mjs` does — there is no
second, divergent build path.

---

## Quickstart

The build context is always the **repo root** (both images need `npm-package/`,
the gateway additionally needs `hosted-server/vercel/`):

```bash
# from the repo root
docker build -f docker/Dockerfile.stdio   -t novada-mcp:stdio   .
docker build -f docker/Dockerfile.gateway -t novada-mcp:gateway .
```

Local stack (Traefik + gateway + Redis + KV façade):

```bash
cd docker
cp .env.example .env          # adjust KV_REST_API_TOKEN if you like
docker compose up -d --build
curl -s localhost:8080/health
```

With the telemetry sink (Postgres + PostgREST):

```bash
docker compose --profile telemetry up -d --build
# uncomment TELEMETRY_SUPABASE_URL / _KEY / _SERVICE_KEY in .env first
```

With the browser UI (playground + chat against the local gateway):

```bash
docker compose --profile ui up -d
open http://localhost:8080/playground     # tool-by-tool JSON-RPC console
open http://localhost:8080/chat           # chat that keyword-routes to tools
```

Both want your own Novada API key in the key field (kept in the browser's
`localStorage`). **There is no login** — no account system exists here or on the
gateway; the API key *is* the identity.

The stdio image in an MCP client:

```json
{
  "mcpServers": {
    "novada": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "NOVADA_API_KEY", "novada-mcp:stdio"]
    }
  }
}
```

---

## Which components does the stack need?

The gateway is **stateless** — all state lives in Redis. There is deliberately no
relational database in the request path.

| # | Component | Required? | What for | Local (compose) | AWS |
|---|---|---|---|---|---|
| 1 | **Traefik** | ✅ | Single entrypoint: routes `/mcp`, OAuth, `/rest/v1`, static pages; owns the long-request timeouts | `traefik` | ALB (or Traefik on ECS if you want identical routing rules) |
| 2 | **MCP gateway** (this image) | ✅ | HTTP transport, auth, quota, dispatch | `gateway` | ECS Fargate behind the ALB (or App Runner) |
| 3 | **Redis** | ✅ | Monthly quota per key, per-IP rate limit, token-verify cache (90 s TTL), OAuth codes. All TTL-based → losing it costs counters, not customer data | `redis` | ElastiCache (Valkey/Redis) **or** Upstash |
| 4 | **Upstash-REST façade in front of Redis** | ✅ | `api/mcp.ts` uses `@vercel/kv` = `@upstash/redis` = **HTTP/REST**, not the Redis wire protocol. A bare Redis/ElastiCache is therefore *not* drop-in | `kv` (`hiett/serverless-redis-http`) | Upstash speaks REST natively → façade disappears; or run SRH as a sidecar in front of ElastiCache |
| 5 | **Telemetry sink** (Postgres + PostgREST) | ⬜ optional, fail-open | The `mcp_events` log (metadata only, no payloads). Without `TELEMETRY_SUPABASE_URL`+`_KEY` it no-ops | profile `telemetry`: `telemetry-db` + `postgrest` | keep Supabase **or** RDS/Aurora Postgres + PostgREST on Fargate |
| 6 | **Browser UI** (landing pages) | ⬜ optional | `playground` + `chat` in the browser against the local gateway | profile `ui`: `ui` (busybox httpd) | deploy separately (today: novada.com/mcp) or S3 + CloudFront |
| 7 | **Reconcile cron** | ⬜ optional | `POST /api/reconcile` drains the HQ push backlog (`CRON_SECRET`) | manual curl | EventBridge Scheduler → ALB route |
| 8 | **Sentry** | ⬜ optional | Error monitoring (`SENTRY_DSN`) | – | unchanged, Sentry SaaS |
| 9 | **Browser API endpoint** | ⬜ optional | `novada_browser`, `render:"browser"` — CDP over WebSocket. The caller brings `NOVADA_BROWSER_WS`; the server holds no credentials | – | – (external, at Novada) |

Not needed: no relational DB in the request path, no session store (Streamable
HTTP runs stateless with `sessionIdGenerator: undefined`, so no sticky sessions
at the load balancer), no object storage, no queue.

### Two env vars are hard requirements

```
KV_REST_API_URL / KV_REST_API_TOKEN   otherwise /mcp answers 500 KV_NOT_CONFIGURED
STUB_AUTH_WARNING_ACCEPTED=true       operator ack, otherwise 503 STUB_AUTH_UNACKED
```

`/health` and `/` work without either — which is what makes them usable as the
load balancer / ECS health probe.

### No API key in the image

`api/mcp.ts` deletes **every** server-side Novada consumption credential from
`process.env` at load time (`NOVADA_API_KEY`, proxy, unblocker and browser
creds). Each caller authenticates with their own key (`?apikey=` or
`Authorization: Bearer`) and pays on their own account. So the gateway image
needs no Novada secret at all — only the stdio image reads `NOVADA_API_KEY`.

---

## Why Traefik, and where nginx went

Everything reaches the stack through Traefik on **one** host port. The routing
table is a plain file (`traefik/dynamic.yml`), **not** the Docker provider: that
would require mounting `/var/run/docker.sock` into the edge proxy, which is
host-daemon control handed to the most exposed container in the stack. A static
file is also what ports to ECS, where no Docker socket exists.

| Job | Owner | Why |
|---|---|---|
| Path routing (`/mcp`, `/<key>/mcp`, OAuth, `/api/*`) | Traefik router | plain rules, incl. `PathRegexp` for the path-auth variant |
| `/rest/v1/*` → PostgREST's root-level table routes | Traefik `stripPrefix` | replaces what used to be an nginx `proxy_pass` + rewrite |
| Extensionless URLs (`/playground` → `playground.html`) | Traefik `replacePathRegex` | mirrors Vercel's `cleanUrls: true` |
| Serving the static pages | `busybox httpd` | this is file serving, not proxying — Traefik has no file server |
| Rewriting the hardcoded endpoint in the pages | `sed` at container start | Traefik cannot rewrite response bodies (only a Yaegi plugin could) |

nginx is gone from the stack entirely. It was doing two things Traefik does
better (path routing, prefix stripping) and two things Traefik cannot do at all
(serving files, response-body rewriting) — those two moved to a 6-line busybox
command, which is also more transparent than an `nginx sub_filter`: you can `ls`
and `cat` the files actually being served.

Access logs are **off** in `traefik.yml` on purpose: MCP clients authenticate
with `?apikey=<key>` in the query string, so an access log is a plaintext
credential store. Same reasoning as "do not enable ALB access logs" below.

---

## Cloud readiness of the images

The gateway image is not local-only — nothing in it assumes compose. Verified by
running it standalone, no compose, no sidecars, env vars only:

| Property | Status |
|---|---|
| Binds `0.0.0.0:$PORT` (default 8080), `PORT`/`HOST` overridable | ✅ `docker run -p 9099:8080` → `/health` 200 |
| `/health` needs neither auth nor KV → usable as ALB/ECS probe | ✅ 200 while KV was unconfigured |
| Fails loud, not silently, when KV is missing | ✅ `/mcp` → 500 `KV_NOT_CONFIGURED` |
| Runs as non-root | ✅ `User=node` |
| SIGTERM drain (ECS stops with SIGTERM, SIGKILL after 30 s) | ✅ "draining connections" → "closed cleanly", exit 0 |
| No secrets baked in, no volumes, no writable state | ✅ config is env-only |
| x86 Fargate | ✅ `docker buildx build --platform linux/amd64` builds and boots (`process.arch = x64`, `/health` 200, ~1m37s) |
| Graviton Fargate (`runtimePlatform: ARM64`) | ✅ the default local build is already arm64 |

Build per target architecture, never copy an image across: `tsx` pulls `esbuild`,
which ships a platform-specific prebuilt binary (`@esbuild/linux-x64` vs
`linux-arm64`), resolved at install time inside the build stage.

What is *not* the image's problem but still blocks a green deployment:

- **KV must speak the Upstash REST protocol.** ElastiCache does not, so it needs
  either Upstash or an SRH sidecar in the task (row 4 of the component table).
  This is the one dependency that is not a managed-AWS drop-in.
- **Telemetry expects the Supabase REST shape** (`POST /rest/v1/mcp_events`), so
  RDS/Aurora needs a PostgREST container in front of it — or telemetry stays off
  (fail-open, the gateway does not care).
- **IaC** (ECR repo, task definition, ALB, target group, security groups,
  Secrets Manager wiring, EventBridge rule) does not exist in this repo yet.

A code-change-free Fargate topology for exactly these constraints — diagram,
design rationale, task definition and runbook — lives in
[`aws/ARCHITECTURE.md`](./aws/ARCHITECTURE.md),
[`aws/README.md`](./aws/README.md) and [`aws/taskdef.json`](./aws/taskdef.json).

---

## AWS target picture

What the images are built for — the section above is what has actually been
verified about them.

```
MCP client
   │  HTTPS
   ▼
Route 53 → ACM/ALB   (idle timeout > 320 s!)
   │  HTTP :8080, target group health check: /health
   ▼
ECS Fargate service  novada-mcp:gateway   (2+ tasks, 1 vCPU / 2 GB, no stickiness)
   ├── Secrets Manager → KV_REST_API_TOKEN, OAUTH_ENC_KEY, TELEMETRY_*, SENTRY_DSN
   ├── ElastiCache (Valkey) + SRH sidecar   OR   Upstash Redis (REST native)
   ├── optional: RDS/Aurora Postgres + PostgREST  (telemetry)
   └── CloudWatch Logs / Container Insights
EventBridge Scheduler → POST /api/reconcile (Bearer CRON_SECRET)   [optional]
```

The things that actually bite when moving off Vercel:

- **ALB idle timeout.** A tool call may run up to ~296 s (`TOOL_WALL_CLOCK_MS` in
  `api/mcp.ts`). The container is set to a 320 s request timeout
  (`MCP_REQUEST_TIMEOUT_MS`) and Traefik to 330 s. The ALB must sit **above**
  that (e.g. 350 s), or long research/scrape calls die as a 504 that is not valid
  JSON-RPC.
- **Redis ≠ Redis-over-REST.** Row 4 of the table. Either Upstash (a 1:1 match
  for the Vercel KV path, no façade) or SRH as a second container in the task.
- **`?apikey=` in the URL lands in ALB access logs.** If access logs are on,
  that is a secret in S3. Either enforce header auth, or disable access logs for
  this LB, and avoid the path-based `/<key>/mcp` mode too. No proxy cache in
  front of `/mcp`.
- **The per-IP rate limiter goes silent behind a bare ALB.** `getClientIp()`
  (`api/mcp.ts:1745`) reads only `x-vercel-forwarded-for` and `x-real-ip`, never
  the standard `x-forwarded-for`; and both limiters early-return `false` when the
  IP is `"unknown"` (`api/mcp.ts:772` and `:789`). An ALB adds
  `X-Forwarded-For` / `-Proto` / `-Port` and `X-Amzn-Trace-Id` — no `X-Real-Ip`
  — so the pre-auth cost breaker and the post-auth rate limit would both
  no-op silently. Per-key monthly quota still works (it is keyed by token hash).
  In this stack it *does* work because Traefik sets `X-Real-Ip` itself (verified:
  75 requests → 57×401 then 18×429, Redis key `pra:<ip>:<bucket>` = 78). Three
  ways out, in order of honesty: keep a Traefik hop between ALB and gateway and
  give it a trusted-IP config so `X-Real-Ip` carries the real client; or teach
  `getClientIp()` about `x-forwarded-for` (take the **last** entry — the ALB
  appends the connecting client, earlier entries are client-controlled and
  spoofable); or accept per-key quota as the only limiter. ALB "HTTP header
  modification" cannot help here — it inserts static values, not the client IP.
- **Platform architecture.** Building locally on Apple Silicon produces an arm64
  image. For x86 Fargate: `docker buildx build --platform linux/amd64 …`; for
  Graviton Fargate (`runtimePlatform: ARM64`) arm64 is already right.
- **Autoscaling** on ALB `RequestCountPerTarget` or CPU; tasks are stateless, so
  scale-in is harmless (SIGTERM → drain, see `gateway/server.mts`).
- **No deploy script for this path.** `hosted-server/scripts/deploy-hosted.sh`
  remains the Vercel route. For AWS the next step is an ECR push plus an ECS task
  definition (Terraform/CDK) — deliberately not written yet, since account, VPC
  and domain are missing.

---

## Verification (how this was checked)

```bash
# stdio: a real MCP handshake, no API key needed
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | docker run --rm -i novada-mcp:stdio | tail -1 | head -c 200
docker run --rm -i novada-mcp:stdio --list-tools | wc -l     # 38

# gateway routes, all through Traefik on one port
curl -s localhost:8080/health
curl -s localhost:8080/.well-known/oauth-authorization-server         # issuer = http://localhost:8080
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/api/reconcile # 401 without CRON_SECRET
curl -s -X POST localhost:8080/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'              # 401 MISSING_TOKEN
curl -s -X POST localhost:8080/sk-eu-novada-anything0000000/mcp \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'              # 401 INVALID_TOKEN → path auth parsed

# which router matched what
curl -s localhost:8090/api/http/routers | grep -o '"name":"[^"]*"'

# KV path (Redis through the REST façade): an invalid key is negative-cached for 90 s
curl -s -o /dev/null "localhost:8080/mcp?apikey=sk-eu-novada-probe000000000000000000" -X POST \
     -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
docker compose exec redis redis-cli --scan          # → tokver:<sha256>
```

With the telemetry profile on, every rejected request becomes a row:

```bash
docker compose exec telemetry-db \
  psql -U postgres -d novada_telemetry \
  -c "select event_type, rejection_stage, status_bucket, ts from mcp_events order by id desc limit 3;"
```

The per-IP rate limiter, exercised (75 requests in one minute window against
`RATE_LIMIT_PER_MIN=60` → 57×401 then 18×429, counter in Redis):

```bash
for i in $(seq 1 75); do curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "localhost:8080/mcp?apikey=sk-eu-novada-probe000000000000000000" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; done | sort | uniq -c
docker compose exec redis redis-cli --scan | grep '^pra:'
```

A client-supplied `X-Real-Ip` does **not** create its own bucket — Traefik
overwrites the header, so the rate-limit bucket cannot be spoofed from outside
(verified: `X-Real-Ip: 1.2.3.4` produced no `pra:1.2.3.4:*` key). Read the
`X-Real-Ip` caveat in the AWS section before putting this behind a bare ALB.

**Not verified:** a successful tool call and the monthly quota counter. Both sit
behind the live key check (the gateway probes `POST /v1/wallet/balance`); an
invalid key is rejected before them. With a real key: add `?apikey=…` to the same
curl call.

### Browser UI (profile `ui`)

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/playground   # 200
curl -s localhost:8080/playground | grep "PG_ENDPOINT ="             # → '/mcp'
```

`playground.html:223` and `chat.html:860` hardcode the production endpoint; it is
rewritten to the relative `/mcp` once at container start into a tmpfs copy, so the
browser stays on one origin (no CORS) and the repo files — mounted read-only — are
never modified. Refresh after editing a page: `docker compose restart ui`.

Deliberately not rewritten: `dashboard.html` builds its URL from a template
(`https://mcp.novada.com/${key}/mcp`) and the install snippets across the pages are
copy-paste material for real clients. Both keep pointing at production.

`chat.html` needs **no** LLM key: `routeTool()` (line 1000) is a keyword router
mapping free text onto `novada_search` / `novada_extract` / `novada_research` and
calling `tools/call` directly.

---

## Files

```
Dockerfile.stdio                    stdio image (multi-stage, non-root)
Dockerfile.gateway                  HTTP gateway image (npm-package build → vendor/, tsx runtime)
gateway/server.mts                  node:http wrapper around api/mcp.ts + api/reconcile.ts, SIGTERM drain
compose.yaml                        local stack (profiles: default | telemetry | ui | stdio)
.env.example                        template → .env (gitignored)
traefik/traefik.yml                 static config: entrypoint, timeouts, file provider, no access log
traefik/dynamic.yml                 routers, middlewares, services (hot-reloaded)
telemetry/00-roles.sh               Supabase roles (anon/authenticated/service_role/authenticator)
telemetry/05-mcp-events-baseline.sql  local baseline table (the in-repo migration is ALTER-only)
aws/ARCHITECTURE.md                 AWS diagram + design rationale (why sidecar, why WAF, timeout chain)
aws/architecture.svg / .png         the diagram itself (SVG is the source of truth)
aws/README.md                       Fargate runbook: ECR → ElastiCache → secrets → service → WAF
aws/taskdef.json                    ECS task definition (gateway + kv sidecar)
```

The gateway image runs the TypeScript sources from `hosted-server/vercel/api/`
through `tsx` — deliberately the same files Vercel deploys, so there is no second
build configuration that can drift. A vendor gate in the build (`core.js` loads,
≥20 tools, tools barrel ≥50 exports) fails the **build**, not production, if the
vendored tree is incomplete.
