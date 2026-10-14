import { desc, sql, type SQL } from "drizzle-orm";
import { loans } from "@/db/schema";

/**
 * Which loans come first in a list: the ones still running, newest first.
 *
 * A dashboard shows a page of loans, and the question it has to answer is
 * "what is live right now". Ordering by `created_at` alone buries an active loan
 * under every closed one, and the query had no ORDER BY at all before this -
 * the rows arrived in whatever order the join produced and the screen rendered
 * them in it.
 *
 * Shared by the dashboard and `GET /api/loans` so page one of each is the same
 * page, and so "the first five" means one thing.
 */
export function activeLoansFirst(): SQL[] {
  return [sql`case when ${loans.status} = 'active' then 0 else 1 end`, desc(loans.createdAt)];
}
