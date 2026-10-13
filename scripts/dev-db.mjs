/**
 * Local Postgres for development / smoke tests, without installing Postgres.
 *
 * Runs an in-process PGlite database behind the real Postgres wire protocol,
 * so `pg` (and therefore the app and drizzle-kit) can connect to it exactly as
 * they would to a normal server:
 *
 *   node scripts/dev-db.mjs          # listens on 127.0.0.1:5432
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npx drizzle-kit push
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npm run dev
 *
 * Data lives in .pglite/ (gitignored) and persists between runs.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.PGLITE_PORT || 5432);
const HOST = process.env.PGLITE_HOST || "127.0.0.1";
const DATA_DIR = process.env.PGLITE_DATA_DIR || ".pglite";

const db = await PGlite.create(DATA_DIR);
const server = new PGLiteSocketServer({ db, port: PORT, host: HOST });
await server.start();

console.log(`[dev-db] Postgres (PGlite) listening on ${HOST}:${PORT}, data in ${DATA_DIR}/`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
