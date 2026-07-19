import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recordActionAndEvict, suppressArtist } from "@/lib/supabase";
import type { SpotifyTrack } from "@/lib/spotify";

interface SuppressBody {
  track: SpotifyTrack;
  artistId: string;
  artistName: string;
}

// Powers the "Less like this" in-feed steering button - the inverse of
// "More like this" / "More by this artist". Records the current track as
// skipped (so it can't resurface, same as a normal skip) AND remembers the
// artist as suppressed: every remaining pool row featuring that artist -
// as either the primary or a featured credit - is evicted immediately, and
// future refills skip that artist entirely until "Refresh Feed" clears the
// suppression list (see clearPool's doc comment in lib/supabase.ts).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as SuppressBody;
  if (!body?.track?.id || !body?.artistId || !body?.artistName) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  try {
    await recordActionAndEvict(userId, body.track, "skipped");
    const removed = await suppressArtist(userId, body.artistId, body.artistName);
    return NextResponse.json({ status: "ok", removedFromPool: removed });
  } catch (err: any) {
    return NextResponse.json(
      { error: "suppress_failed", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}
