import { createClient } from 'redis';
import { CACHE_SCHEMA_VERSION } from '../src/constants';

/**
 * CLI utility to flush obsolete versioned cache keys from Redis.
 *
 * Usage:
 *   pnpm run cache:flush-version <version>
 *
 * Example:
 *   pnpm run cache:flush-version v1
 *
 * This scans for keys matching `sfe:<version>:*` and deletes them in batches
 * using SCAN (never KEYS) to avoid blocking the Redis server.
 */

const KEY_PREFIX = 'sfe';
const SCAN_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 100;

function usage(): never {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: pnpm run cache:flush-version <version>\n' +
      `Example: pnpm run cache:flush-version v1\n` +
      `Current schema version: ${CACHE_SCHEMA_VERSION}`,
  );
  process.exit(1);
}

function parseVersionArg(argv: string[]): string {
  const version = argv[2]?.trim();
  if (!version) {
    usage();
  }
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    // eslint-disable-next-line no-console
    console.error(
      `Invalid version "${version}". Only alphanumeric characters, dots, underscores, and hyphens are allowed.`,
    );
    process.exit(1);
  }
  return version;
}

async function flushVersion(version: string): Promise<number> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const client = createClient({ url: redisUrl });

  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Redis client error:', err);
  });

  await client.connect();

  const pattern = `${KEY_PREFIX}:${version}:*`;
  let cursor = '0';
  let deleted = 0;
  let scanned = 0;

  try {
    do {
      const reply = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: SCAN_BATCH_SIZE,
      });
      cursor = reply.cursor;
      const keys = reply.keys;
      scanned += keys.length;

      for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
        if (batch.length > 0) {
          const removed = await client.del(batch);
          deleted += removed;
        }
      }
    } while (cursor !== '0');
  } finally {
    await client.quit();
  }

  // eslint-disable-next-line no-console
  console.log(
    `Scanned ${scanned} key(s) matching "${pattern}"; deleted ${deleted} key(s).`,
  );

  return deleted;
}

async function main(): Promise<void> {
  const version = parseVersionArg(process.argv);

  if (version === CACHE_SCHEMA_VERSION) {
    // eslint-disable-next-line no-console
    console.warn(
      `Warning: "${version}" is the current CACHE_SCHEMA_VERSION. ` +
        'Flushing it will remove active cache entries.',
    );
  }

  try {
    await flushVersion(version);
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to flush cache version:', err);
    process.exit(1);
  }
}

void main();