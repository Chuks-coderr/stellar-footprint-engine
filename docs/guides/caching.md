# Caching Guide

The Stellar Footprint Service caches simulation results to avoid redundant RPC calls. Identical requests (same XDR + network) return the cached result instantly without hitting the Stellar RPC.

---

## Dual-Backend Strategy

The service selects a cache backend at startup based on whether `REDIS_URL` is set:

| Condition | Backend | Notes |
|---|---|---|
| `REDIS_URL` is set and Redis is reachable | **Redis** | Shared across all instances; survives restarts |
| `REDIS_URL` is unset or Redis fails to connect | **In-memory LRU** | Per-process; lost on restart |

If Redis connects but later drops, the service logs a warning and transparently falls back to the in-memory cache. No restart is required.

You can confirm which backend is active by checking the startup log:

```
Cache backend: Redis
# or
Cache backend: in-memory LRU (REDIS_URL not set)
```

### Zero-downtime fallback (`ALLOW_CACHE_FALLBACK`)

Redis initialization is **non-blocking**: the server boots and serves traffic even if the Redis host is invalid, offline, or unreachable at startup. Redis connection errors are captured by an `error` event listener that marks the Redis status as `unhealthy` instead of crashing the Node process.

| Variable | Default | Description |
|---|---|---|
| `ALLOW_CACHE_FALLBACK` | `true` in development, `false` in production | When `true`, the service keeps serving requests using the in-memory LRU cache while Redis is unavailable. When `false`, Redis failures are treated as fatal in strict production mode. |

When fallback is active, the service logs a warning such as:

```
[warn] Redis unavailable — falling back to in-memory cache
```

The readiness probe `GET /health/ready` reports Redis connectivity accurately:

- Redis reachable → `redis: "healthy"`, overall status `ready`.
- Redis unreachable with `ALLOW_CACHE_FALLBACK=true` → `redis: "degraded"`, but the service still reports ready and serves traffic.
- Redis unreachable with `ALLOW_CACHE_FALLBACK=false` → readiness fails.

---

## Cache Key Structure

Cache keys are deterministic SHA-256 hashes of the request's canonical JSON (keys sorted alphabetically), namespaced by the current cache schema version:

```
sfe:<CACHE_SCHEMA_VERSION>:sim:sha256(JSON.stringify({ network: "testnet", xdr: "AAAAAgAAAAC..." }))
→ "sfe:v2:sim:a3f2c1d9e8b7..."
```

This means two requests with the same XDR and network always hit the same cache entry, regardless of field order in the request body.

### Schema versioning policy

`CACHE_SCHEMA_VERSION` (defined in `src/constants.ts`) is embedded in every Redis key prefix as `sfe:${CACHE_SCHEMA_VERSION}:sim:...`.

**Bump the version whenever the cached response shape changes incompatibly**, for example:

- Adding or removing fields in the simulation response envelope
- Changing envelope shapes or field types
- Changing the serialization format of cached values

Bumping the version automatically isolates the cache from incompatible legacy entries: new writes go to the new namespace, and old entries are never read (they simply expire via TTL). This prevents deserialization errors or incomplete responses for clients after a schema change.

**Bump procedure:**

1. Update `CACHE_SCHEMA_VERSION` in `src/constants.ts` (e.g. `'v2'` → `'v3'`).
2. Deploy the service. New keys are written under the new prefix; legacy keys are ignored.
3. Optionally reclaim memory immediately by deleting obsolete keys:

   ```bash
   pnpm run cache:flush-version v2
   ```

   The utility uses Redis `SCAN` (never `KEYS`) to iterate keys matching `sfe:v2:*` in batches and deletes them, so it is safe to run against a live production Redis.

4. Confirm the active namespace in the startup log and via `GET /health/ready`.
=======

---

## TTL Configuration

| Variable | Default | Description |
|---|---|---|
| `CACHE_TTL_SECONDS` | `60` | How long a cached result lives (seconds) |
| `CACHE_MAX_SIZE` | `500` | Maximum entries in the in-memory LRU cache |
| `REDIS_URL` | — | Full Redis connection URL (e.g. `redis://localhost:6379`) |
| `REDIS_HOST` | `redis` | Redis hostname (Docker Compose only) |
| `REDIS_PORT` | `6379` | Redis port (Docker Compose only) |

> **Note:** `REDIS_URL` takes precedence over `REDIS_HOST`/`REDIS_PORT`. Use `REDIS_URL` for production deployments (supports `rediss://` for TLS).

### Choosing a TTL

- **Short TTL (30–60 s):** Good for development or when ledger state changes frequently.
- **Longer TTL (5–30 min):** Appropriate for stable contracts where footprints rarely change. Reduces RPC load significantly under high traffic.

---

## Cache Invalidation

### Automatic expiry

Entries expire automatically after `CACHE_TTL_SECONDS`. No manual action needed.

### Manual flush

To immediately clear all cached entries (both Redis and in-memory):

```bash
curl -X DELETE http://localhost:3000/api/cache
```

Response:

```json
{ "message": "Cache cleared" }
```

**When to use `DELETE /cache`:**

- After deploying a new contract version that changes footprint structure
- When debugging unexpected cached responses
- After a ledger migration or network reset on testnet

---

## Redis in Docker Compose

The `docker-compose.yml` includes a Redis service. No extra configuration is needed for local development:

```bash
docker compose up
```

For production, use a managed Redis instance and set `REDIS_URL`:

```env
REDIS_URL=rediss://your-redis-host:6380
```

The `rediss://` scheme enables TLS. Most managed Redis providers (Upstash, Redis Cloud, AWS ElastiCache) require TLS in production.

---

## Further Reading

- [ADR 001 — Caching Strategy](../adr/001-caching-strategy.md)
- [Environment Variables Reference](../../README.md#-environment-variables)
