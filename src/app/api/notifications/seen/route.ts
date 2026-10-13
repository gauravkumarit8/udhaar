import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

/**
 * Marks the Activity feed as read for this user, which clears the tab badge.
 *
 * Called when the screen is actually opened, so "unread" means "arrived since
 * I last looked" rather than "arrived since I last tapped something".
 */
async function handlePOST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db.update(users).set({ notificationsSeenAt: new Date() }).where(eq(users.id, session.id));

  return NextResponse.json({ success: true }, { headers: { "cache-control": "no-store" } });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
