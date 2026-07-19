// Spotify Web API wrapper.
//
// IMPORTANT - Spotify's Feb 11/Mar 9 2026 Development Mode changes
// (https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
// permanently removed or replaced several endpoints this app used to rely
// on. This was root-caused by cross-referencing runtime logs (403s on every
// distinct artist for /top-tracks, a 404 on /recommendations) against
// Spotify's own migration guide - these are NOT transient errors or a rate
// limit, the endpoints are gone for dev-mode apps and retrying them is
// pointless (and wastes calls against the shared app-wide rate limit,
// which was part of what caused the earlier login-loop bug). Kept here so
// a future edit doesn't reintroduce calls to something that can't work:
//   - GET /artists/{id}/top-tracks is REMOVED. Do not call it. (This is why
//     "More by this artist" and the refill's top-artist loop used to call
//     it - both now rely solely on /search.)
//   - GET /recommendations is REMOVED (has been 403/404 since Nov 2024
//     without Extended Quota Mode). Do not call it. ("More like this" now
//     relies on the seed track's artist genres + /search.)
//   - PUT/DELETE /me/tracks and GET /me/tracks/contains are REPLACED by
//     generic PUT/DELETE /me/library and GET /me/library/contains, which
//     take comma-separated `uris` (spotify:track:{id}) instead of `ids`.
//   - GET /search's `limit` max dropped from 50 to 10 (default from 20 to
//     5) - always pass an explicit limit=10 and paginate with `offset`
//     when more than one page of results is needed (see boostFeed).
//   - Never call /artists/{id}/albums or /albums/{id}/tracks - this app hit
//     a long-lived 429 ban on those specific endpoints even before the
//     Feb 2026 changes.

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com/api/token";

// No hardcoded fallback on purpose - this file is safe to publish in a
// public repo, so the real client id/secret must only ever come from
// Vercel/local env vars (see .env.example). Fails loudly at import time if
// they're missing rather than silently falling back to a value that would
// have had to live in source control.
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET environment variables. " +
      "Set them in Vercel (Project Settings -> Environment Variables) or in a local .env.local file."
  );
}

export interface SpotifyFetchResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  bodyText: string;
}

// Module-level, in-memory rate-limit tracking, shared by every call made in
// a warm serverless container.
//
// IMPORTANT CONTEXT: every get*/search* helper in this file already guards
// with `if (!result.ok) return []` - meaning a 429 has always looked
// EXACTLY like "this artist just has no tracks" to every caller. That was
// discovered to be a real, serious bug: refillPool ran an entire refill
// through a live, sustained Spotify rate-limit ban without ever seeing an
// error - every call quietly returned [], the refill "succeeded" with a
// near-empty pool, and last_error got cleared to null. Because nothing
// ever looked like a failure, the cooldown logic in /api/feed/refill
// (which only backs off hard when last_error mentions a rate limit) never
// engaged, so the frontend's auto-retry-every-4s kept firing full-volume
// refill bursts into the SAME active ban roughly every 15-20 seconds for
// over 16 hours straight - continuously re-triggering it and likely why a
// ban that should have cleared in minutes never got the chance to.
//
// isSpotifyRateLimited() gives callers (refillPool, boostFeed) a real
// signal to check and throw on, so the failure actually propagates and the
// long cooldown in /api/feed/refill can do its job. It also short-circuits
// further network calls within the same warm invocation once a 429 has
// been seen, instead of piling more requests onto an active ban.
let rateLimitedUntil = 0;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export function isSpotifyRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

/**
 * Rate-gated fetch wrapper. Retries once on 429 honoring Retry-After (capped
 * so we never block a serverless invocation for the full 23h ban some
 * endpoints have handed out in the past). Always captures the raw response
 * body text so callers can log/display the *actual* Spotify error instead of
 * just a status code.
 */
export async function spotifyFetch<T = any>(
  path: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<SpotifyFetchResult<T>> {
  const url = path.startsWith("http") ? path : `${SPOTIFY_API}${path}`;

  // Already known to be rate-limited from an earlier call in this same
  // warm invocation - don't make it worse by firing another request into
  // the same ban window. Return the same shape a real 429 would.
  if (isSpotifyRateLimited()) {
    return {
      ok: false,
      status: 429,
      data: null,
      bodyText: "Rate limited (cached - skipped network call to avoid piling on)",
    };
  }

  const doFetch = async () =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
      },
      cache: "no-store",
    });

  let res = await doFetch();

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 1;
    // Only worth a synchronous retry for short bans; long bans should be
    // surfaced to the caller instead of hanging the request.
    if (!Number.isNaN(retryAfterSec) && retryAfterSec <= 3) {
      await new Promise((r) => setTimeout(r, (retryAfterSec + 1) * 1000));
      res = await doFetch();
    }
  }

  if (res.status === 429) {
    // Still 429 after the short retry (or the wait was too long to retry
    // synchronously) - remember this so every other call in this
    // invocation short-circuits above instead of adding to the ban, and so
    // isSpotifyRateLimited() can tell refillPool/boostFeed to abort and
    // throw a real error rather than limping along with empty results.
    const retryAfterHeader = res.headers.get("Retry-After");
    const parsedMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : NaN;
    const backoffMs = Number.isNaN(parsedMs)
      ? DEFAULT_RATE_LIMIT_BACKOFF_MS
      : Math.min(parsedMs, MAX_RATE_LIMIT_BACKOFF_MS);
    rateLimitedUntil = Date.now() + backoffMs;
  }

  const bodyText = await res.text();
  let data: T | null = null;
  if (bodyText) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    console.error(
      `[spotify] ${res.status} on ${init.method || "GET"} ${path} :: ${bodyText.slice(
        0,
        500
      )}`
    );
  }

  return { ok: res.ok, status: res.status, data, bodyText };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string; name: string; images: { url: string }[] };
  preview_url: string | null;
  uri: string;
  duration_ms: number;
  external_urls?: { spotify?: string };
}

export async function getMyTopArtists(
  accessToken: string,
  timeRange: "short_term" | "medium_term" | "long_term" = "medium_term"
): Promise<{ id: string; name: string; genres: string[] }[]> {
  const result = await spotifyFetch<{ items: any[] }>(
    `/me/top/artists?time_range=${timeRange}&limit=50`,
    accessToken
  );
  if (!result.ok || !result.data) return [];
  return result.data.items.map((a) => ({
    id: a.id,
    name: a.name,
    genres: a.genres || [],
  }));
}

export async function getMyRecentlyPlayed(
  accessToken: string
): Promise<SpotifyTrack[]> {
  const result = await spotifyFetch<{ items: { track: SpotifyTrack }[] }>(
    "/me/player/recently-played",
    accessToken
  );
  if (!result.ok || !result.data) return [];
  return result.data.items.map((i) => i.track).filter(Boolean);
}

export interface SavedTracksSnapshot {
  ids: Set<string>;
  contentKeys: Set<string>;
  // Title-only keys (no artist component) for tracks whose title is
  // distinctive enough to match safely - catches slowed/sped-up/nightcore
  // bootleg uploads of an already-liked song where the remix "artist" is
  // credited first, which contentKeys (artist::title) would otherwise miss.
  titleKeys: Set<string>;
}

/**
 * Pages through the user's ENTIRE real Spotify Liked Songs library. Used
 * both to seed "saved artist" discovery and, critically, to prune anything
 * from our local candidate pool that the user has since liked - whether via
 * this app or directly in Spotify.
 */
export async function getMySavedTracksAll(
  accessToken: string
): Promise<SavedTracksSnapshot> {
  const ids = new Set<string>();
  const contentKeys = new Set<string>();
  const titleKeys = new Set<string>();
  const { trackContentKey, trackTitleKey, isDistinctiveTitleKey } =
    await import("./dedupe");

  let url: string | null = "/me/tracks";
  let guard = 0;
  while (url && guard < 200) {
    guard++;
    const result: SpotifyFetchResult<{
      items: { track: SpotifyTrack }[];
      next: string | null;
    }> = await spotifyFetch(url, accessToken);
    if (!result.ok || !result.data) break;
    for (const item of result.data.items) {
      if (!item.track) continue;
      ids.add(item.track.id);
      contentKeys.add(trackContentKey(item.track));
      const titleKey = trackTitleKey(item.track);
      if (isDistinctiveTitleKey(titleKey)) titleKeys.add(titleKey);
    }
    url = result.data.next; // Spotify returns absolute URLs here.
  }

  return { ids, contentKeys, titleKeys };
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
}

// Spotify's Feb 2026 dev-mode changes capped /search's limit at 10 (was 50,
// default was 20 - now 5). Always request the new max explicitly instead of
// omitting it, otherwise every search call now returns only 5 results.
const SEARCH_MAX_LIMIT = 10;

export async function searchTracksByArtist(
  accessToken: string,
  artistName: string,
  opts: SearchOpts = {}
): Promise<SpotifyTrack[]> {
  const q = encodeURIComponent(artistName);
  const limit = opts.limit ?? SEARCH_MAX_LIMIT;
  const offset = opts.offset ?? 0;
  const result = await spotifyFetch<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?q=${q}&type=track&limit=${limit}&offset=${offset}`,
    accessToken
  );
  if (!result.ok || !result.data) return [];
  const wanted = artistName.toLowerCase();
  return result.data.tracks.items.filter((t) =>
    t.artists.some((a) => a.name.toLowerCase() === wanted)
  );
}

export async function searchTracksByGenre(
  accessToken: string,
  genre: string,
  opts: SearchOpts = {}
): Promise<SpotifyTrack[]> {
  const q = encodeURIComponent(genre);
  const limit = opts.limit ?? SEARCH_MAX_LIMIT;
  const offset = opts.offset ?? 0;
  const result = await spotifyFetch<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?q=${q}&type=track&limit=${limit}&offset=${offset}`,
    accessToken
  );
  if (!result.ok || !result.data) return [];
  return result.data.tracks.items;
}

/**
 * Checks which of the given track ids are in the user's REAL Spotify Liked
 * Songs right now (not our local snapshot). Used as a just-in-time check on
 * the handful of rows about to be served to the client, closing the gap
 * where a track was liked directly in Spotify (or liked in-app) after it
 * was added to the pool but before the periodic prune caught up - the
 * concrete cause of already-liked songs still showing up in the feed.
 *
 * Migrated from GET /me/tracks/contains?ids=... to the generic
 * GET /me/library/contains?uris=... per Spotify's Feb 2026 dev-mode
 * changes (the old endpoint is gone). Batches respect the new 40-URI cap
 * per request (was 50 ids).
 */
export async function checkTracksSaved(
  accessToken: string,
  trackIds: string[]
): Promise<Set<string>> {
  const saved = new Set<string>();
  if (trackIds.length === 0) return saved;
  for (let i = 0; i < trackIds.length; i += 40) {
    const batch = trackIds.slice(i, i + 40);
    const uris = batch.map((id) => `spotify:track:${id}`).join(",");
    const result = await spotifyFetch<boolean[]>(
      `/me/library/contains?uris=${encodeURIComponent(uris)}`,
      accessToken
    );
    if (!result.ok || !result.data) continue;
    result.data.forEach((isSaved, idx) => {
      if (isSaved) saved.add(batch[idx]);
    });
  }
  return saved;
}

/**
 * Single-artist lookup (genres, name). NOT one of the endpoints removed by
 * Spotify's Feb 2026 dev-mode changes (only the plural /artists batch fetch
 * and /artists/{id}/top-tracks were) - still safe to call.
 */
export async function getArtist(
  accessToken: string,
  artistId: string
): Promise<{ id: string; name: string; genres: string[] } | null> {
  const result = await spotifyFetch<{ id: string; name: string; genres: string[] }>(
    `/artists/${artistId}`,
    accessToken
  );
  if (!result.ok || !result.data) return null;
  return result.data;
}

export type SaveTrackReason =
  | "success"
  | "insufficient_scope"
  | "unauthorized"
  | "forbidden_other"
  | "error";

export interface SaveTrackResult {
  ok: boolean;
  status: number;
  reason: SaveTrackReason;
  detail: string;
}

/**
 * Save a track to the user's real Spotify Liked Songs.
 *
 * Root-caused history:
 *  1) This previously sent `PUT /me/tracks?ids=X` (query param), which
 *     Spotify rejected. Sending a JSON body fixed the request *shape*, but
 *     it kept 403ing anyway - because the underlying access token's refresh
 *     token was issued under an OLDER consent that never included the
 *     `user-library-modify` scope (scopes don't apply retroactively; only a
 *     fresh sign-in grants them).
 *  2) As of Spotify's Feb 2026 dev-mode migration, `PUT /me/tracks` itself
 *     was REMOVED entirely and replaced by a generic `PUT /me/library`
 *     endpoint that takes comma-separated Spotify URIs (`spotify:track:{id}`)
 *     via a query param instead of a JSON `ids` body. Confirmed against
 *     Spotify's official migration guide - this (not a scope problem) was
 *     the actual reason the Like button stopped working: every save was
 *     hitting a dead endpoint. A bare 403 here still gets treated as
 *     scope-related below since that's still the most common *remaining*
 *     cause once the endpoint itself is correct.
 */
export async function saveTrack(
  accessToken: string,
  trackId: string
): Promise<SaveTrackResult> {
  const uri = encodeURIComponent(`spotify:track:${trackId}`);
  const result = await spotifyFetch(`/me/library?uris=${uri}`, accessToken, {
    method: "PUT",
  });

  if (result.ok) {
    return { ok: true, status: result.status, reason: "success", detail: "" };
  }

  if (result.status === 401) {
    return {
      ok: false,
      status: 401,
      reason: "unauthorized",
      detail: result.bodyText || "Access token invalid or expired.",
    };
  }

  if (result.status === 403) {
    return {
      ok: false,
      status: 403,
      reason: "insufficient_scope",
      detail:
        result.bodyText ||
        "Spotify returned 403 Forbidden - your current sign-in does not have permission to modify your library.",
    };
  }

  return {
    ok: false,
    status: result.status,
    reason: "error",
    detail: result.bodyText || `Spotify returned HTTP ${result.status}.`,
  };
}

export interface RefreshedTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<RefreshedTokens | null> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64"
  );
  const res = await fetch(SPOTIFY_ACCOUNTS, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`[spotify] token refresh failed :: ${bodyText.slice(0, 500)}`);
    return null;
  }

  try {
    return JSON.parse(bodyText) as RefreshedTokens;
  } catch {
    return null;
  }
}

export { CLIENT_ID as SPOTIFY_CLIENT_ID, CLIENT_SECRET as SPOTIFY_CLIENT_SECRET };
