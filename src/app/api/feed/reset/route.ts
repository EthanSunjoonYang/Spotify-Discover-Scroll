import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken, clearPool } from "@/lib/supabase";
import { refillPoolFastStart } from "@/lib/pool";

// Raises the ceiling on how long Vercel lets this invocation run - see the
// matching comment in /api/feed/refill/route.ts.
export const maxDuration = 60;

// Powers the "Refresh Feed" button: wipes the current candidate pool and
// rebuilds it. track_history (liked/skipped songs) is left untouched, so a
// refresh can't resurface anything the user already acted on - it only
// regenerates what hasn't been shown yet.
//
// Uses refillPoolFastStart rather than refillPool directly: responds as
// soon as the first ~100 tracks are ready instead of blocking on the full,
// deliberately-sequential pool rebuild, while the rest keeps filling in the
// background (see refillPoolFastStart's doc comment in pool.ts). This is
// what makes "Refresh Feed" feel close to instant.
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
    const result = await refillPoolFastStart(userId, tokens.access_token);
    return NextResponse.json({ status: "ok", ...result });
  } catch (err: any) {
    return NextResponse.json(
      { error: "reset_failed", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}
