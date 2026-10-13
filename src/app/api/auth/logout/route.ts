import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";
import { withErrors } from "@/lib/api-handler";

async function handlePOST() {
  await clearSession();
  return NextResponse.json({ success: true });
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
