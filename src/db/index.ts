import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { SQL } from "drizzle-orm";

// One pool per process, reused across hot reloads in development.
const globalForDb = globalThis as typeof globalThis & {
  __udhaarPgPool?: Pool;
};

let cachedDb: NodePgDatabase | null = null;

function getDbInstance(): NodePgDatabase {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (!globalForDb.__udhaarPgPool) {
    globalForDb.__udhaarPgPool = new Pool({
      connectionString: databaseUrl,
      /*
       * TCP keepalive on every pooled connection, and an idle timeout shorter
       * than a typical phone's sleep.
       *
       * The app is usually idle between visits; without keepalive a pooled
       * connection can be dead by the time somebody opens a screen, and the
       * first query then pays for a reconnect (TLS handshake included, and on
       * Neon a possibly suspended compute) before it does any work. This is
       * the cheap half of "why is the first tap slow".
       */
      keepAlive: true,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  if (!cachedDb) {
    cachedDb = drizzle(globalForDb.__udhaarPgPool);
  }

  return cachedDb;
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const dbInstance = getDbInstance();
    const value = Reflect.get(dbInstance as unknown as object, prop);
    return typeof value === "function"
      ? (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(dbInstance, args)
      : value;
  },
});

export const db = new Proxy({} as NodePgDatabase, {
  get(_target, prop) {
    const dbInstance = getDbInstance();
    const value = Reflect.get(dbInstance as unknown as object, prop);
    return typeof value === "function"
      ? (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(dbInstance, args)
      : value;
  },
});

/**
 * Run a hand-written statement and get plain rows back.
 *
 * `db.execute` hands back the driver's own result object; this unwraps `.rows`
 * so a caller that needs a window function or a `filter (where ...)` aggregate
 * can stay typed without casting at every call site.
 */
export async function rawRows<T>(query: SQL): Promise<T[]> {
  // Through `unknown`: drizzle types `execute` for index-signature rows, and a
  // hand-written row interface is not one of those.
  const result = (await db.execute(query)) as unknown as { rows?: T[] };
  return result.rows ?? [];
}
