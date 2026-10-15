import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { uploadProofImage } from "@/lib/storage";
import { UPLOAD_PER_USER, tooManyRequests } from "@/lib/rate-limit";
import { withErrors } from "@/lib/api-handler";

async function handlePOST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /*
   * Keyed on the account, not the connection: a signed-in caller cannot rotate
   * this key, so the cap is exact. It bounds what one account can spend on
   * proof storage and what one account can push through the server.
   */
  const limit = UPLOAD_PER_USER.check(session.id);
  if (!limit.allowed) {
    return tooManyRequests(limit, "Too many uploads just now.");
  }

  const body = await req.json();
  const { image } = body;

  if (!image || typeof image !== "string") {
    return NextResponse.json({ error: "image (base64 data URL) is required" }, { status: 400 });
  }

  try {
    const proofId = await uploadProofImage(image);
    // The id, not a URL: the asset is private, and the only way to see it is
    // GET /api/payments/[id]/proof, which re-checks who is asking.
    return NextResponse.json({ proofId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    // 503 for config issues (developer needs to set env vars),
    // 400 for bad/oversized input
    const status = message.includes("not configured") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

// Any unhandled failure becomes a JSON error the UI can actually show.
export const POST = withErrors(handlePOST);
