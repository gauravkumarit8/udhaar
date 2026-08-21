import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { uploadProofImage } from "@/lib/storage";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { image } = body;

  if (!image || typeof image !== "string") {
    return NextResponse.json({ error: "image (base64 data URL) is required" }, { status: 400 });
  }

  try {
    const url = await uploadProofImage(image);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    // 503 for config issues (developer needs to set env vars),
    // 400 for bad/oversized input
    const status = message.includes("not configured") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
