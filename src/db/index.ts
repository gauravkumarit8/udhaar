import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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
