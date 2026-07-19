import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getNextBatch, poolSize, getValidAccessToken } from "@/lib/supabase";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Token is optional here (a missing/expired token shouldn't block serving
  // from the pool) - when present it powers a just-in-time check against
  // the user's real Spotify Liked Songs for the rows about to be served,
  // see getNextBatch.
  const tokens = await getValidAccessToken(userId);
  const batch = await getNextBatch(userId, tokens?.access_token ?? null, 10);
  const remaining = await poolSize(userId);

  return NextResponse.json({
    tracks: batch.map((row) => ({
      poolRowId: row.id,
      track: row.track,
      source: row.source,
    })),
    remainingInPool: remaining,
  });
}
