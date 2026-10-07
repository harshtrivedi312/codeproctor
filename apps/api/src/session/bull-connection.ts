// BullMQ connection options from REDIS_URL (shared by every queue of the session jobs).
import type { ConnectionOptions } from 'bullmq';

/** The messages never print the URL: it can carry the Redis password. */
export function bullConnection(redisUrl: string): ConnectionOptions {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL is not a valid URL');
  }
  const port = url.port === '' ? 6379 : Number(url.port);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('REDIS_URL has a port that is not an integer from 1 to 65535');
  }
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error('REDIS_URL has a database that is not a non-negative integer');
  }
  return {
    host: url.hostname,
    port,
    ...(url.username !== '' ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password !== '' ? { password: decodeURIComponent(url.password) } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
