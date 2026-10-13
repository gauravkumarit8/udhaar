import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [profile] = await db
    .select({
      id: users.id,
      name: users.name,
      mobile: users.mobile,
      pushEnabled: users.pushEnabled,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Channels that have no provider wired up yet are reported so the UI can
  // show them as unavailable instead of offering a switch that does nothing.
  return NextResponse.json({
    profile,
    channels: {
      push: true,
      sms: Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_FLOW_ID),
      whatsapp: false,
    },
  });
}

async function handlePATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { pushEnabled } = body;

  if (typeof pushEnabled !== "boolean") {
    return NextResponse.json({ error: "pushEnabled must be true or false" }, { status: 400 });
  }

  await db.update(users).set({ pushEnabled }).where(eq(users.id, session.id));

  return NextResponse.json({ success: true, pushEnabled });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
export const PATCH = withErrors(handlePATCH);
