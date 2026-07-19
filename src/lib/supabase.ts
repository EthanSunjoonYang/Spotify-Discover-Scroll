import { createClient } from "@supabase/supabase-js";
import {
  refreshAccessToken,
  type SpotifyTrack,
  getMySavedTracksAll,
  checkTracksSaved,
} from "./spotify";
import {
  trackContentKey,
  titleKeyFromContentKey,
  isDistinctiveTitleKey,
} from "./dedupe";

// Dedicated Supabase project for this app (split out from a shared project
// that also hosted an unrelated class project's tables). Decided to stay on
// this project rather than revert to the old shared one, since the old
// project's app tables had already been dropped after migration and
// recreating them wasn't worth it - all current data already lives here.
//
// Intentionally NOT reading process.env.SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// / SUPABASE_ANON_KEY here - this Vercel project has a stale
// SUPABASE_SERVICE_ROLE_KEY env var left over from before the project split
// that points at the OLD project and gets silently rejected with "Invalid
// API key" if it's ever read. Hardcoding avoids that footgun.
const SUPABASE_URL = "https://vdncwzhzodssjrpkejrt.supabase.co";
const SUPABASE_KEY = "sb_publishable_6rSkIeTaS6fIYdLWpiGrxg_UtKsu-hJ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const REQUIRED_LIKE_SCOPE = "user-library-modify";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
}

export async function upsertUser(user: {
  id: string;
  display_name?: string | null;
  email?: string | null;
  image_url?: string | null;
}) {
  await supabase.from("users").upsert(
    {
      id: user.id,
      display_name: user.display_name ?? null,
      email: user.email ?? null,
      image_url: user.image_url ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

/**
 * ALWAYS overwrites the stored tokens with whatever was just granted -
 * never conditionally skips this. A prior bug class in this app: if sign-in
 * ever "keeps" an existing DB row instead of unconditionally overwriting it,
 * a user re-authenticating to pick up a new OAuth scope (like
 * user-library-modify) would still have their OLD, narrower-scoped refresh
 * token silently reused, and the re-auth would appear to do nothing.
 */
export async function upsertSpotifyTokens(
  userId: string,
  tokens: {
    access_token: string;
    refresh_token: string;
    expires_at: string;
    scope?: string | null;
  }
) {
  const { error } = await supabase.from("spotify_tokens").upsert(
    {
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      scope: tokens.scope ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error(
      `[supabase] upsertSpotifyTokens failed for user_id=${userId} against ${SUPABASE_URL} :: ${JSON.stringify(
        error
      )}`
    );
  }
}

/**
 * Returns a valid access token for the user, transparently refreshing (and
 * persisting the refresh back to Supabase - including the scope Spotify
 * reports for the new token) if the stored one is expired or about to
 * expire.
 */
export async function getValidAccessToken(
  userId: string
): Promise<StoredTokens | null> {
  const { data, error } = await supabase
    .from("spotify_tokens")
    .select("access_token, refresh_token, expires_at, scope")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    console.error(
      `[supabase] getValidAccessToken failed for user_id=${userId} against ${SUPABASE_URL} :: ${
        error ? JSON.stringify(error) : "no data"
      }`
    );
    return null;
  }

  const expiresAt = new Date(data.expires_at).getTime();
  const isExpiringSoon = expiresAt - Date.now() < 60_000;

  if (!isExpiringSoon) {
    return data as StoredTokens;
  }

  const refreshed = await refreshAccessToken(data.refresh_token);
  if (!refreshed) {
    // Refresh failed - fall back to the (likely expired) stored token so the
    // caller gets a clean 401 from Spotify instead of a thrown exception,
    // and can tell the user to re-auth.
    return data as StoredTokens;
  }

  const newExpiresAt = new Date(
    Date.now() + refreshed.expires_in * 1000
  ).toISOString();
  // Spotify only returns a new refresh_token sometimes (rotation) - keep the
  // old one otherwise.
  const newRefreshToken = refreshed.refresh_token || data.refresh_token;
  const newScope = refreshed.scope ?? data.scope;

  await upsertSpotifyTokens(userId, {
    access_token: refreshed.access_token,
    refresh_token: newRefreshToken,
    expires_at: newExpiresAt,
    scope: newScope,
  });

  return {
    access_token: refreshed.access_token,
    refresh_token: newRefreshToken,
    expires_at: newExpiresAt,
    scope: newScope,
  };
}

/**
 * Fast, local, no-Spotify-call check for whether the user's current token
 * actually carries the library-modify scope. Lets the Like flow fail fast
 * with a clear "please re-sign-in" message instead of a confusing bare 403
 * from Spotify when we already know the answer.
 */
export function hasLikeScope(tokens: StoredTokens): boolean {
  if (!tokens.scope) return true; // unknown - let Spotify be the judge, don't false-block
  return tokens.scope.split(" ").includes(REQUIRED_LIKE_SCOPE);
}

export interface PoolRow {
  id: string;
  track_id: string;
  track: SpotifyTrack;
  source: string;
  track_key: string | null;
}

const SERVED_STALE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Serves the next batch of candidates for the feed.
 *
 * This is the AUTHORITATIVE de-dupe point: it re-checks every pool row
 * against track_history at serve time (by exact track id AND by fuzzy
 * content key), rather than trusting that whatever filtered candidates at
 * insert time is still valid. This is what was missing before - a track's
 * pool row was never guaranteed to be cleaned up the moment it was acted on,
 * so anything that only filtered at insert-time could keep re-serving a
 * stale row.
 *
 * Two additional guarantees on top of that:
 *  - served_at: rows returned here get stamped as served (below) and are
 *    excluded from future selection (until a short staleness window
 *    passes, as a safety net for abandoned/lost batches). Without this, a
 *    row that had already been sent to the client but not yet acted on
 *    (e.g. still a few cards ahead of where the user is scrolling) could
 *    get selected AGAIN by the next prefetch call, since nothing marked it
 *    as already-served - this was the concrete cause of the same song
 *    showing up twice a few cards apart in the same session.
 *  - accessToken (optional): if provided, does a live check against the
 *    user's actual Spotify Liked Songs for just the rows about to be
 *    served, and evicts any that are already liked. This closes the gap
 *    where a track was liked (in this app or directly in Spotify) after it
 *    was added to the pool but before the next periodic prune caught up.
 */
export async function getNextBatch(
  userId: string,
  accessToken: string | null,
  limit = 10
): Promise<PoolRow[]> {
  const { data: historyRows } = await supabase
    .from("track_history")
    .select("track_id, track_key")
    .eq("user_id", userId);

  const historyIds = new Set((historyRows || []).map((r) => r.track_id));
  const historyKeys = new Set(
    (historyRows || []).map((r) => r.track_key).filter(Boolean) as string[]
  );
  // Title-only fallback (see dedupe.ts) - catches slowed/sped-up/nightcore/
  // etc. bootleg uploads of a track the user already liked/skipped, where
  // the remix "artist" ends up credited first and the artist::title key
  // above doesn't match.
  const historyTitleKeys = new Set(
    Array.from(historyKeys)
      .map(titleKeyFromContentKey)
      .filter(isDistinctiveTitleKey)
  );

  const staleThreshold = new Date(Date.now() - SERVED_STALE_MS).toISOString();

  const { data: poolRows } = await supabase
    .from("track_pool")
    .select("id, track_id, track, source, track_key")
    .eq("user_id", userId)
    .or(`served_at.is.null,served_at.lt.${staleThreshold}`)
    .order("created_at", { ascending: true })
    .limit(limit * 5); // over-fetch since we filter client-side below

  const filtered = (poolRows || []).filter((row) => {
    if (historyIds.has(row.track_id)) return false;
    if (row.track_key) {
      if (historyKeys.has(row.track_key)) return false;
      const titleKey = titleKeyFromContentKey(row.track_key);
      if (isDistinctiveTitleKey(titleKey) && historyTitleKeys.has(titleKey)) {
        return false;
      }
    }
    return true;
  });

  // Housekeeping: delete the stale rows we just filtered out so future
  // queries don't have to re-filter them, and so the pool's "how many
  // candidates do we have" count (used to decide whether to refill) is
  // accurate.
  const staleIds = (poolRows || [])
    .filter((row) => !filtered.includes(row))
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await supabase.from("track_pool").delete().in("id", staleIds);
  }

  let toServe = filtered.slice(0, limit) as PoolRow[];

  if (accessToken && toServe.length > 0) {
    const liveSaved = await checkTracksSaved(
      accessToken,
      toServe.map((r) => r.track_id)
    );
    if (liveSaved.size > 0) {
      const staleLikedIds = toServe
        .filter((r) => liveSaved.has(r.track_id))
        .map((r) => r.id);
      await supabase.from("track_pool").delete().in("id", staleLikedIds);
      toServe = toServe.filter((r) => !liveSaved.has(r.track_id));
      // Not topping back up to `limit` here on purpose - simpler to just
      // serve slightly fewer, and the frontend's prefetch-when-low effect
      // will naturally ask for more on the next pass.
    }
  }

  if (toServe.length > 0) {
    await supabase
      .from("track_pool")
      .update({ served_at: new Date().toISOString() })
      .in(
        "id",
        toServe.map((r) => r.id)
      );
  }

  return toServe;
}

export async function poolSize(userId: string): Promise<number> {
  const { count } = await supabase
    .from("track_pool")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count || 0;
}

/**
 * Wipes the user's entire candidate pool. Used by the "Refresh Feed"
 * button - lets the user force a completely fresh pool (rebuilt with the
 * current interleaving/weighting logic) on demand, rather than waiting for
 * old, differently-ordered leftover rows to get served/evicted first.
 * Intentionally does NOT touch track_history, so already liked/skipped
 * songs still won't resurface after a refresh.
 *
 * This is also what makes "Refresh Feed" a true fresh slate for any
 * in-session tailoring: "More like this" / "More by this artist" (see
 * insertPriorityPoolCandidates / boostFeed in pool.ts) only ever write
 * priority-ordered rows into this same track_pool table, and "Less like
 * this" only ever writes to suppressed_artists - there's no other
 * affinity/bias state anywhere else - so wiping every row in both tables
 * here, unconditionally, discards any not-yet-served boosted tracks and
 * any artist suppressions along with everything else before refillPool
 * rebuilds from scratch.
 */
export async function clearPool(userId: string) {
  await supabase.from("track_pool").delete().eq("user_id", userId);
  await supabase.from("suppressed_artists").delete().eq("user_id", userId);
}

/**
 * Returns the set of artist ids the user has asked to see less of (via the
 * "Less like this" button). Consulted by refillPool and boostFeed so
 * suppressed artists stop being recommended, not just evicted once.
 */
export async function getSuppressedArtistIds(
  userId: string
): Promise<Set<string>> {
  const { data } = await supabase
    .from("suppressed_artists")
    .select("artist_id")
    .eq("user_id", userId);
  return new Set((data || []).map((r) => r.artist_id));
}

/**
 * Powers the "Less like this" button. Remembers the artist as suppressed
 * (persists until the next "Refresh Feed" - see clearPool above) and
 * immediately evicts every current pool row featuring that artist, as
 * either the primary or a featured credit, so the effect is felt right
 * away rather than only on the next refill. Returns how many rows were
 * evicted, mainly for logging/debugging.
 */
export async function suppressArtist(
  userId: string,
  artistId: string,
  artistName: string
): Promise<number> {
  await supabase.from("suppressed_artists").upsert(
    { user_id: userId, artist_id: artistId, artist_name: artistName },
    { onConflict: "user_id,artist_id" }
  );

  const { data: poolRows } = await supabase
    .from("track_pool")
    .select("id, track")
    .eq("user_id", userId);

  const toDelete = (poolRows || [])
    .filter((row: any) =>
      (row.track?.artists || []).some((a: any) => a.id === artistId)
    )
    .map((row: any) => row.id);

  if (toDelete.length > 0) {
    await supabase.from("track_pool").delete().in("id", toDelete);
  }

  return toDelete.length;
}

export async function insertPoolCandidates(
  userId: string,
  tracks: { track: SpotifyTrack; source: string }[]
) {
  if (tracks.length === 0) return;
  // IMPORTANT: explicitly stamp created_at with a per-row incrementing
  // offset instead of relying on the column default. Postgres evaluates
  // now() once per statement, so every row in a single batch upsert would
  // otherwise get the IDENTICAL timestamp - meaning the caller's shuffled
  // order (see pool.ts) would be silently lost, since getNextBatch's
  // `order("created_at")` has no distinct values left to sort by and tie
  // order isn't guaranteed.
  const base = Date.now();
  const rows = tracks.map(({ track, source }, idx) => ({
    user_id: userId,
    track_id: track.id,
    track,
    source,
    track_key: trackContentKey(track),
    created_at: new Date(base + idx).toISOString(),
  }));
  // Unique on (user_id, track_id) - ignore conflicts rather than erroring.
  await supabase.from("track_pool").upsert(rows, {
    onConflict: "user_id,track_id",
    ignoreDuplicates: true,
  });
}

/**
 * Inserts candidates with timestamps pinned near the Unix epoch, which sort
 * before every naturally-inserted row (those use real wall-clock
 * timestamps). This is what powers "More like this" / "More by this
 * artist": the boosted tracks become the OLDEST rows in the pool, so
 * getNextBatch's created_at-ascending order serves them on the very next
 * fetch instead of queueing them behind whatever was already in the pool.
 * Returns the actually-inserted rows (upsert with ignoreDuplicates skips
 * anything the user already has queued, which won't appear in the
 * `.select()` result) so the caller can splice them straight into the
 * frontend's queue.
 */
export async function insertPriorityPoolCandidates(
  userId: string,
  tracks: { track: SpotifyTrack; source: string }[]
): Promise<PoolRow[]> {
  if (tracks.length === 0) return [];
  const rows = tracks.map(({ track, source }, idx) => ({
    user_id: userId,
    track_id: track.id,
    track,
    source,
    track_key: trackContentKey(track),
    created_at: new Date(idx + 1).toISOString(),
  }));
  const { data, error } = await supabase
    .from("track_pool")
    .upsert(rows, { onConflict: "user_id,track_id", ignoreDuplicates: true })
    .select("id, track_id, track, source, track_key");
  if (error || !data) return [];
  return data as PoolRow[];
}

/**
 * Deletes any pool rows matching the user's CURRENT real Spotify Liked
 * Songs, by exact id or fuzzy content key. Runs on every refill so pool rows
 * that predate this feature, or that got liked directly in Spotify (outside
 * this app), are retroactively cleaned up. This is a second, independent
 * layer of defense on top of the serve-time filtering in getNextBatch -
 * getNextBatch guards against our own recorded history; this guards against
 * the ground truth in the user's actual Spotify library.
 */
export async function pruneLikedFromPool(userId: string, accessToken: string) {
  const saved = await getMySavedTracksAll(accessToken);
  if (
    saved.ids.size === 0 &&
    saved.contentKeys.size === 0 &&
    saved.titleKeys.size === 0
  )
    return;

  const { data: poolRows } = await supabase
    .from("track_pool")
    .select("id, track_id, track_key")
    .eq("user_id", userId);

  const toDelete = (poolRows || [])
    .filter((row) => {
      if (saved.ids.has(row.track_id)) return true;
      if (row.track_key && saved.contentKeys.has(row.track_key)) return true;
      // Title-only fallback: catches slowed/sped-up/nightcore/etc. bootleg
      // uploads of an already-liked song where the remix "artist" ends up
      // listed first, which the artist::title key above would miss.
      if (row.track_key) {
        const titleKey = titleKeyFromContentKey(row.track_key);
        if (isDistinctiveTitleKey(titleKey) && saved.titleKeys.has(titleKey)) {
          return true;
        }
      }
      return false;
    })
    .map((row) => row.id);

  if (toDelete.length > 0) {
    await supabase.from("track_pool").delete().in("id", toDelete);
  }
}

/**
 * Records that the user acted on a track AND immediately removes it from the
 * candidate pool (both by id and by content key), so it can never be served
 * again regardless of any other filtering layer. Call this for both 'liked'
 * and 'skipped' actions.
 */
export async function recordActionAndEvict(
  userId: string,
  track: SpotifyTrack,
  action: "liked" | "skipped" | "played"
) {
  const key = trackContentKey(track);
  const titleKey = titleKeyFromContentKey(key);
  const titleDistinctive = isDistinctiveTitleKey(titleKey);

  await supabase.from("track_history").insert({
    user_id: userId,
    track_id: track.id,
    action,
    track_key: key,
  });

  await supabase
    .from("track_pool")
    .delete()
    .eq("user_id", userId)
    .or(`track_id.eq.${track.id},track_key.eq.${key}`);

  // Title-only fallback: evict any other pool rows that are just a slowed/
  // sped-up/nightcore/etc. bootleg of the song acted on, even if their
  // artist::title key doesn't exactly match (see dedupe.ts).
  if (titleDistinctive) {
    const { data: remaining } = await supabase
      .from("track_pool")
      .select("id, track_key")
      .eq("user_id", userId);
    const staleIds = (remaining || [])
      .filter(
        (row) =>
          row.track_key && titleKeyFromContentKey(row.track_key) === titleKey
      )
      .map((row) => row.id);
    if (staleIds.length > 0) {
      await supabase.from("track_pool").delete().in("id", staleIds);
    }
  }
}

export async function getPoolState(userId: string) {
  const { data } = await supabase
    .from("pool_state")
    .select("*")
    .eq("user_id", userId)
    .single();
  return data;
}

export async function setPoolState(
  userId: string,
  state: Partial<{
    last_refilled_at: string;
    refilling: boolean;
    last_error: string | null;
  }>
) {
  await supabase
    .from("pool_state")
    .upsert({ user_id: userId, ...state }, { onConflict: "user_id" });
}
