import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withErrors } from "@/lib/api-handler";

async function handleGET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user: session });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const GET = withErrors(handleGET);
