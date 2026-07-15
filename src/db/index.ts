import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

let cachedDb: NodePgDatabase | null = null;

function getDbInstance(): NodePgDatabase {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (!globalForDb.__arenaNextJsPostgresqlPool) {
    globalForDb.__arenaNextJsPostgresqlPool = new Pool({
      connectionString: databaseUrl,
    });
  }

  if (!cachedDb) {
    cachedDb = drizzle(globalForDb.__arenaNextJsPostgresqlPool);
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
