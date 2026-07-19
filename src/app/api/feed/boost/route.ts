import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken } from "@/lib/supabase";
import { boostFeed } from "@/lib/pool";

interface BoostBody {
  mode: "artist" | "similar";
  trackId: string;
  artistId: string;
  artistName: string;
}

// Powers the "More like this" / "More by this artist" in-feed steering
// buttons. Inserts hand-requested candidates with front-of-pool priority
// (see insertPriorityPoolCandidates) and returns them so the client can
// splice them in right after the current card - that's what makes this
// feel like a real-time tweak to the feed instead of a background refill.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as BoostBody;
  if (
    !body?.mode ||
    (body.mode !== "artist" && body.mode !== "similar") ||
    !body?.trackId ||
    !body?.artistId ||
    !body?.artistName
  ) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  const tokens = await getValidAccessToken(userId);
  if (!tokens) {
    return NextResponse.json(
      { error: "reauth_required", detail: "No Spotify tokens on file." },
      { status: 401 }
    );
  }

  try {
    const rows = await boostFeed(userId, tokens.access_token, body);
    return NextResponse.json({
      status: "ok",
      added: rows.length,
      tracks: rows.map((row) => ({
        poolRowId: row.id,
        track: row.track,
        source: row.source,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "boost_failed", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}
