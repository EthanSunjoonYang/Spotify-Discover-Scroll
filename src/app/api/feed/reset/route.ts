import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken, clearPool } from "@/lib/supabase";
import { refillPool } from "@/lib/pool";

// Powers the "Refresh Feed" button: wipes the current candidate pool and
// rebuilds it from scratch. track_history (liked/skipped songs) is left
// untouched, so a refresh can't resurface anything the user already acted
// on - it only regenerates what hasn't been shown yet.
export async function POST() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const tokens = await getValidAccessToken(userId);
  if (!tokens) {
    return NextResponse.json(
      { error: "reauth_required", detail: "No Spotify tokens on file." },
      { status: 401 }
    );
  }

  try {
    await clearPool(userId);
    const result = await refillPool(userId, tokens.access_token);
    return NextResponse.json({ status: "ok", ...result });
  } catch (err: any) {
    return NextResponse.json(
      { error: "reset_failed", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}
