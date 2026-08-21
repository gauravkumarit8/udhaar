import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { registerDeviceToken } from "@/lib/push";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token, platform } = await req.json();

  if (!token || !["android", "ios", "web"].includes(platform)) {
    return NextResponse.json({ error: "token and a valid platform are required" }, { status: 400 });
  }

  await registerDeviceToken(session.id, token, platform);

  return NextResponse.json({ success: true });
}
