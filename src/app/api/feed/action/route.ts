import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken, hasLikeScope, recordActionAndEvict } from "@/lib/supabase";
import { saveTrack, type SpotifyTrack } from "@/lib/spotify";

interface ActionBody {
  action: "liked" | "skipped";
  track: SpotifyTrack;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as ActionBody;
  if (!body?.track?.id || !body?.action) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  if (body.action === "skipped") {
    await recordActionAndEvict(userId, body.track, "skipped");
    return NextResponse.json({ savedToSpotify: null, evicted: true });
  }

  // action === "liked"
  const tokens = await getValidAccessToken(userId);
  if (!tokens) {
    return NextResponse.json(
      {
        savedToSpotify: false,
        reauthRequired: true,
        detail: "You're not signed in to Spotify. Please sign in again.",
      },
      { status: 401 }
    );
  }

  // Fail fast with a clear, actionable message if we already know this
  // token can't write to the library - avoids a confusing bare 403 round
  // trip to Spotify when we can tell the user exactly what to do.
  if (!hasLikeScope(tokens)) {
    return NextResponse.json(
      {
        savedToSpotify: false,
        reauthRequired: true,
        detail:
          "Your Spotify sign-in doesn't currently grant permission to save songs to your Liked Songs. Sign out and sign back in to grant it.",
      },
      { status: 403 }
    );
  }

  const result = await saveTrack(tokens.access_token, body.track.id);

  if (!result.ok) {
    const reauthRequired =
      result.reason === "insufficient_scope" || result.reason === "unauthorized";
    return NextResponse.json(
      {
        savedToSpotify: false,
        reauthRequired,
        detail: reauthRequired
          ? "Spotify rejected the save (permission issue). Sign out and sign back in to re-grant access, then try again."
          : result.detail,
      },
      { status: result.status || 500 }
    );
  }

  // Only record the like (which permanently hides the track) once Spotify
  // has actually confirmed the save. Recording it unconditionally was never
  // this app's intent, but this is stated explicitly so it stays true after
  // future edits.
  await recordActionAndEvict(userId, body.track, "liked");

  return NextResponse.json({ savedToSpotify: true, evicted: true });
}
