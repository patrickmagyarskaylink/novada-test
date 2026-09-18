# Fargate deployment — no code changes

Deploys the gateway image to ECS Fargate with **zero modifications** to
`npm-package/` or `hosted-server/`. Everything that would normally require a code
change is absorbed by the task topology instead.

**Diagram and design rationale: [`ARCHITECTURE.md`](./ARCHITECTURE.md).** This
file is the build order.

```
Client ──HTTPS──► ALB (idle timeout 350 s, access logs OFF, WAF rate rule)
                    │  HTTP :8080, health check /health
                    ▼
        ┌───────── ECS Fargate task (awsvpc: one network namespace) ─────────┐
        │  gateway  novada-mcp:gateway        :8080   ← the only ALB target  │
        │      │  KV_REST_API_URL=http://127.0.0.1:8079                      │
        │      ▼                                                             │
        │  kv       hiett/serverless-redis-http :8079  (sidecar, not exposed)│
        └──────────────────────────┬─────────────────────────────────────────┘
                                   │ rediss://:AUTH@…:6379
                                   ▼
                        ElastiCache (Valkey/Redis, TLS + AUTH)
```

`taskdef.json` in this directory is the artifact. Replace `ACCOUNT_ID`, the region
and the image tag; everything else is deployable as-is.

## Why the sidecar is not optional

`api/mcp.ts` reaches KV through `@vercel/kv`, which is `@upstash/redis` — an
HTTP/REST protocol, not the Redis wire protocol. ElastiCache cannot answer that,
so *something* has to translate. Without touching code there are exactly two
options: Upstash (REST-native, not an AWS service) or SRH in the task. This setup
uses SRH so the datastore can be ElastiCache.

SRH speaks TLS: a `rediss://` connection string sets `ssl: true` plus HTTPS
hostname verification with the `castore` CA bundle
(`lib/srh/redis/client_worker.ex`), so ElastiCache encryption-in-transit works.
Its AUTH token goes in the connection string, which is why
`SRH_CONNECTION_STRING` is a Secrets Manager secret, not an env var.

Be aware of what you are adopting: SRH is a small single-maintainer OSS project
in the request path of every quota check. It is the price of "no code change". The
alternative — a ~60-line KV adapter behind a `REDIS_URL` env var, talking to
ElastiCache directly — needs a PR against `hosted-server/vercel/api/`.

## Why there is no Traefik in the task

Tempting, but it makes things worse. `getClientIp()` (`api/mcp.ts:1745`) reads
only `x-vercel-forwarded-for` and `x-real-ip`; both rate limiters return early
when the IP is `"unknown"` (`:772`, `:789`). An ALB sets `X-Forwarded-For`, never
`X-Real-Ip` — so with a bare ALB the limiters silently no-op.

Measured locally: Traefik in front of the gateway does set `X-Real-Ip`, but to the
**connecting** address, not the `X-Forwarded-For` client — even with
`forwardedHeaders.trustedIPs=0.0.0.0/0`. A request carrying
`X-Forwarded-For: 203.0.113.7` produced the Redis bucket `pra:172.23.0.1:…`, the
proxy's own peer. Behind an ALB that means one shared bucket for all customers:
at `RATE_LIMIT_PER_MIN=60` the whole service throttles itself.

So: ALB → gateway directly, per-IP throttling delegated to an **AWS WAF
rate-based rule** on the ALB (per source IP, native, no code). The per-key monthly
quota is unaffected — it is keyed by token hash, not by IP.

## Runbook

Placeholders: `ACCOUNT_ID`, `REGION=eu-central-1`, `VPC`, `SUBNET_A/B`, `SG_*`.

**1. Build for the right architecture and push**

```bash
# from the repo root. X86_64 in taskdef.json ⇒ build amd64.
aws ecr create-repository --repository-name novada-mcp-gateway --region "$REGION"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
docker buildx build --platform linux/amd64 \
  -f docker/Dockerfile.gateway \
  -t "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/novada-mcp-gateway:0.9.39" --push .
```

For Graviton (cheaper), use `--platform linux/arm64` and set
`runtimePlatform.cpuArchitecture` to `ARM64`. Never push one image for both — `tsx`
pulls a platform-specific `esbuild` binary.

**2. ElastiCache**

```bash
# Valkey/Redis 7+, encryption in transit ON, AUTH token set, private subnets only.
aws elasticache create-replication-group \
  --replication-group-id novada-mcp-kv \
  --replication-group-description "novada-mcp gateway KV" \
  --engine valkey --cache-node-type cache.t4g.small \
  --num-node-groups 1 --replicas-per-node-group 1 \
  --transit-encryption-enabled --auth-token "$ELASTICACHE_AUTH_TOKEN" \
  --cache-subnet-group-name "$SUBNET_GROUP" --security-group-ids "$SG_CACHE" \
  --region "$REGION"
```

ElastiCache Serverless works too and *requires* TLS — same `rediss://` string.
Cluster mode must stay **disabled**: SRH/Redix opens a plain client connection and
does not follow `MOVED` redirects.

**3. Secrets** — three values, one of them shared by both containers

```bash
KV_TOKEN=$(openssl rand -hex 32)          # SRH_TOKEN == KV_REST_API_TOKEN, must match
aws secretsmanager create-secret --name novada-mcp/kv-token        --secret-string "$KV_TOKEN"
aws secretsmanager create-secret --name novada-mcp/oauth-enc-key   --secret-string "$(openssl rand -base64 32)"
aws secretsmanager create-secret --name novada-mcp/elasticache-url \
  --secret-string "rediss://:$ELASTICACHE_AUTH_TOKEN@novada-mcp-kv.xxxx.clustercfg.euc1.cache.amazonaws.com:6379"
```

Grant the **task execution role** `secretsmanager:GetSecretValue` on those three
ARNs (that is the role ECS uses to inject `secrets`, not the task role).

Optional extras, each only if you want the feature — add them to the gateway
container's `secrets` array: `TELEMETRY_SUPABASE_URL`, `TELEMETRY_SUPABASE_KEY`,
`CRON_SECRET`, `SENTRY_DSN`, `NOVADA_LOG_IDENTITY_AES_KEY`. Absent means the
feature no-ops (fail-open); no placeholder values.

There is deliberately **no Novada API key** anywhere: the gateway strips every
server-side consumption credential at load, callers pay with their own key.

**4. Log group, task definition, service**

```bash
aws logs create-log-group --log-group-name /ecs/novada-mcp
aws ecs register-task-definition --cli-input-json file://docker/aws/taskdef.json
aws elbv2 create-target-group --name novada-mcp-tg --protocol HTTP --port 8080 \
  --vpc-id "$VPC" --target-type ip \
  --health-check-path /health --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3
# 350 s > the gateway's 320 s request timeout > its ~296 s tool budget
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" \
  --attributes Key=idle_timeout.timeout_seconds,Value=350 \
               Key=access_logs.s3.enabled,Value=false
aws ecs create-service --cluster novada-mcp --service-name gateway \
  --task-definition novada-mcp-gateway --desired-count 2 --launch-type FARGATE \
  --health-check-grace-period-seconds 60 \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$SG_TASK],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=gateway,containerPort=8080"
```

`assignPublicIp=DISABLED` needs NAT (or VPC endpoints) — the gateway calls
`api.novada.com` on every request and verifies each key against
`POST /v1/wallet/balance`. No egress means every call fails.

**5. Rate limiting at the edge (replaces the app-level limiter)**

```bash
# WAF rate-based rule, per source IP, attached to the ALB
aws wafv2 create-web-acl --name novada-mcp --scope REGIONAL \
  --default-action Allow={} \
  --rules '[{"Name":"per-ip","Priority":0,"Action":{"Block":{}},"Statement":{"RateBasedStatement":{"Limit":600,"AggregateKeyType":"IP"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"per-ip"}}]' \
  --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=novada-mcp
```

**6. Reconcile cron (only with telemetry enabled)**

EventBridge Scheduler cannot call arbitrary HTTP endpoints; use an **API
destination** plus a connection with API-key auth, header name `Authorization`,
value `Bearer <CRON_SECRET>`, target `POST https://<host>/api/reconcile`.

**7. Autoscaling** — target-tracking on `ALBRequestCountPerTarget`, or CPU. Tasks
are stateless; scale-in is safe (SIGTERM → drain → exit 0, `stopTimeout: 40`).

## Verify after deploy

```bash
curl -s https://<alb-dns>/health                    # {"ok":true,...}
curl -s -X POST https://<alb-dns>/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 401 MISSING_TOKEN → gateway alive
curl -s -X POST "https://<alb-dns>/mcp?apikey=$YOUR_KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 38 tools → KV + upstream both work
```

A 500 `KV_NOT_CONFIGURED` means the gateway cannot see the secrets; a 401
`INVALID_TOKEN` on a good key means it cannot reach `api.novada.com` (egress) or
the key really is wrong. Both are visible in `/ecs/novada-mcp`.

## Optional: telemetry on RDS instead of Supabase

`_telemetry.ts` posts to the Supabase REST shape
(`POST {TELEMETRY_SUPABASE_URL}/rest/v1/mcp_events`), so RDS needs PostgREST in
front of it — again a code-free adapter, as a third container in the same task:

- `postgrest/postgrest:v12.2.3`, `PGRST_DB_URI` → RDS, listening on `:3000`
- `TELEMETRY_SUPABASE_URL=http://127.0.0.1:3000` on the gateway, and a
  `PGRST_JWT_SECRET`-signed `service_role` JWT as `TELEMETRY_SUPABASE_KEY`
- PostgREST serves tables at the root, so the `/rest/v1` prefix has to be
  stripped — locally Traefik does it; in the task the cheapest equivalent is
  PostgREST behind its own path-stripping proxy, or simply accepting one extra
  hop. This is the one piece of the local stack that has no clean 1:1 in a
  two-container task.
- Schema: apply `../telemetry/05-mcp-events-baseline.sql`, then
  `../../hosted-server/migrations/2026-07-23-…sql` and `2026-08-26-…sql`, plus the
  roles from `../telemetry/00-roles.sh`.

Telemetry is fail-open. Leaving it off costs the event log, nothing else.

## What is verified, and what is not

Verified locally, on the exact images and versions above:

- The two-container topology with the **shared network namespace** that awsvpc
  gives a Fargate task: gateway → `http://127.0.0.1:8079` → SRH → Redis **with
  AUTH**. `/health` 200, `/mcp` reached the gateway (401 `INVALID_TOKEN` from the
  live upstream probe), and the token-verify cache key landed in Redis.
- SRH's `PING` responds through the Upstash REST body protocol that `@vercel/kv`
  uses, and `nc -z 127.0.0.1 8079` works as its ECS health check.
- `taskdef.json` passes the AWS CLI's client-side schema validation for
  `RegisterTaskDefinition` (it fails only on the expired credentials, not on any
  parameter).
- The amd64 image builds and boots (`process.arch = x64`).

Not verified — needs an account with valid credentials:

- Every `aws` command in the runbook (the session token in `~/.aws` is expired:
  `ExpiredTokenException`).
- SRH against a real TLS ElastiCache endpoint. TLS support is source-verified,
  not runtime-verified; a local self-signed cert would fail peer verification and
  prove nothing.
- ALB timeout behaviour on a genuinely long (>300 s) tool call.
