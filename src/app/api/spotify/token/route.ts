import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken } from "@/lib/supabase";

// Exposes a short-lived, always-fresh access token to the client for the
// Spotify Web Playback SDK. The SDK needs a raw bearer token; everything
// else in this app talks to Spotify server-side.
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const tokens = await getValidAccessToken(userId);
  if (!tokens) {
    return NextResponse.json({ error: "reauth_required" }, { status: 401 });
  }

  return NextResponse.json({ access_token: tokens.access_token });
}
