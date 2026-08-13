import {
  getMyTopArtists,
  getMyRecentlyPlayed,
  getMySavedTracksAll,
  searchTracksByArtist,
  searchTracksByGenre,
  getArtist,
  isSpotifyRateLimited,
  type SpotifyTrack,
} from "./spotify";
import {
  insertPoolCandidates,
  insertPriorityPoolCandidates,
  pruneLikedFromPool,
  getSuppressedArtistIds,
  setPoolState,
  supabase,
  type PoolRow,
} from "./supabase";
import {
  trackContentKey,
  titleKeyFromContentKey,
  isDistinctiveTitleKey,
} from "./dedupe";
import { waitUntil } from "@vercel/functions";

const TARGET_POOL_SIZE = 400;

// How many tracks refillPoolFastStart waits for before responding to the
// caller, and the chunk size used for every flush after that. Small enough
// that "Refresh Feed" / the very first load feel close to instant instead
// of blocking on the full, deliberately-sequential (rate-limit-safe)
// TARGET_POOL_SIZE build.
const FAST_BATCH_SIZE = 100;
const BACKGROUND_CHUNK_SIZE = 100;

// Cap how much of a single refill can come from non-personalized genre
// discovery. Previously, once the (small) top-artist candidate well ran dry
// - which happened fast, since it only drew from 15 medium_term artists via
// text search - later refills in a long session fell back more and more to
// generic genre filler, which is what the user experienced as the feed
// "drifting" away from their actual taste the longer they scrolled.
const MAX_GENRE_SHARE = 0.25;

// Spotify's Feb 2026 dev-mode changes capped /search's limit at 10 (was up
// to 50) - always request this explicitly (see spotify.ts's SEARCH_MAX_LIMIT)
// instead of relying on the new, much smaller default of 5.
const SEARCH_PAGE_SIZE = 10;

const GENRE_DISCOVERY_SEEDS = [
  "indie pop",
  "alternative rock",
  "electronic",
  "lo-fi",
  "hip hop",
  "r&b",
  "dream pop",
  "folk",
];

interface Candidate {
  track: SpotifyTrack;
  source: string;
}

interface ArtistGroup {
  key: string;
  weight: number;
  items: Candidate[];
}

/**
 * Interleaves candidates grouped by artist (or genre-bucket) so the same
 * artist never appears in a tight run, regardless of how lopsided the raw
 * supply is. This replaces a single Fisher-Yates shuffle over the flat
 * candidate list - which still produced visible "blocks of the same couple
 * artists cycling" whenever those artists happened to dominate the
 * candidate counts, since a uniform shuffle doesn't guarantee spacing.
 *
 * At each step, picks one item from a weighted-random group among those NOT
 * currently on cooldown (favoring higher-weight tiers and groups with more
 * remaining items), then puts that group on cooldown for a few steps. When
 * too few distinct groups remain to honor the cooldown (e.g. near the very
 * end), it falls back to picking among whatever's left rather than
 * stalling.
 */
function interleaveByArtist(groups: ArtistGroup[]): Candidate[] {
  const pool = groups
    .map((g) => ({ key: g.key, weight: g.weight, items: [...g.items] }))
    .filter((g) => g.items.length > 0);
  if (pool.length === 0) return [];

  const cooldown = Math.min(6, pool.length - 1);
  const cooldownUntil = new Map<string, number>();
  const output: Candidate[] = [];
  let step = 0;

  while (pool.some((g) => g.items.length > 0)) {
    const eligible = pool.filter(
      (g) => g.items.length > 0 && (cooldownUntil.get(g.key) ?? -1) < step
    );
    const candidates =
      eligible.length > 0 ? eligible : pool.filter((g) => g.items.length > 0);

    const scores = candidates.map((g) => g.weight * Math.sqrt(g.items.length));
    const totalScore = scores.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalScore;
    let chosenIdx = candidates.length - 1;
    for (let i = 0; i < candidates.length; i++) {
      r -= scores[i];
      if (r <= 0) {
        chosenIdx = i;
        break;
      }
    }

    const chosen = candidates[chosenIdx];
    const item = chosen.items.shift()!;
    output.push(item);
    cooldownUntil.set(chosen.key, step + cooldown);
    step++;
  }

  return output;
}

export interface RefillOptions {
  // Caps how many NEW tracks this call collects (defaults to the full
  // TARGET_POOL_SIZE). Lets a caller ask for a smaller top-up instead of
  // always building toward the full target - e.g. refillPoolFastStart's
  // background phase only needs "however many more get the pool to
  // TARGET_POOL_SIZE," not another full TARGET_POOL_SIZE on top of what's
  // already there.
  maxNewTracks?: number;
  // If set, flushes (interleaves + inserts) whatever's been collected so
  // far as soon as totalCollected first reaches this many, fires
  // onFastBatchReady, then keeps collecting and flushing every
  // BACKGROUND_CHUNK_SIZE after that, up to maxNewTracks. Omit for the
  // original single-flush-at-the-end behavior.
  fastBatchSize?: number;
  onFastBatchReady?: (result: { added: number }) => void;
}

export async function refillPool(
  userId: string,
  accessToken: string,
  opts: RefillOptions = {}
) {
  const maxNewTracks = opts.maxNewTracks ?? TARGET_POOL_SIZE;
  await setPoolState(userId, { refilling: true, last_error: null });

  try {
    const [topArtistsShort, topArtistsMedium, topArtistsLong, recentTracks, saved] =
      await Promise.all([
        getMyTopArtists(accessToken, "short_term"),
        getMyTopArtists(accessToken, "medium_term"),
        getMyTopArtists(accessToken, "long_term"),
        getMyRecentlyPlayed(accessToken),
        getMySavedTracksAll(accessToken),
      ]);

    // CRITICAL: check this before doing anything else. Every get*/search*
    // helper in spotify.ts silently returns [] on any failed request,
    // including a 429 - which means a rate-limited refill would otherwise
    // "succeed" with a near-empty pool and last_error cleared to null,
    // leaving the /api/feed/refill cooldown with no way to know a real
    // problem happened. That silent-failure gap is what let a single
    // Spotify rate-limit ban get continuously re-triggered by the
    // frontend's auto-retry loop for 16+ hours straight instead of
    // clearing in minutes. Throwing here makes the failure real, so
    // refillPool's catch block (below) records it and the route applies
    // its long rate-limit cooldown instead of the normal 15s one.
    if (isSpotifyRateLimited()) {
      throw new Error(
        "Spotify rate limit (429) hit while building your feed - backing off before trying again."
      );
    }

    // Union top artists across all three time ranges (deduped by id)
    // instead of just medium_term's top 15. This is the other half of the
    // "feed drifts from my taste" fix: a much bigger, richer well of
    // personalized artists means refills stay personalized far longer
    // before ever needing to lean on genre discovery.
    const topArtistMap = new Map<string, { id: string; name: string }>();
    for (const a of [...topArtistsShort, ...topArtistsMedium, ...topArtistsLong]) {
      if (!topArtistMap.has(a.id)) topArtistMap.set(a.id, a);
    }
    const topArtists = Array.from(topArtistMap.values());

    const { data: historyRows } = await supabase
      .from("track_history")
      .select("track_id, track_key")
      .eq("user_id", userId);
    const historyIds = new Set((historyRows || []).map((r) => r.track_id));
    const historyKeys = new Set(
      (historyRows || []).map((r) => r.track_key).filter(Boolean) as string[]
    );

    const { data: existingPool } = await supabase
      .from("track_pool")
      .select("track_id, track_key")
      .eq("user_id", userId);
    const poolIds = new Set((existingPool || []).map((r) => r.track_id));
    const poolKeys = new Set(
      (existingPool || []).map((r) => r.track_key).filter(Boolean) as string[]
    );

    // Artists the user has explicitly asked to see less of via "Less like
    // this" - persists across refills until the user hits "Refresh Feed"
    // (see clearPool). Checked both here (skip fetching for them at all)
    // and inside isExcluded below (catches them showing up as a collab
    // credit on someone else's track, or via recent-plays/genre search).
    const suppressedArtistIds = await getSuppressedArtistIds(userId);

    // Title-only fallback sets (see dedupe.ts) - catches slowed/sped-up/
    // nightcore/etc. bootleg uploads that credit the remix "artist" first,
    // which the artist::title keys above would otherwise miss entirely.
    const toTitleKeys = (keys: Set<string>) =>
      new Set(
        Array.from(keys)
          .map(titleKeyFromContentKey)
          .filter(isDistinctiveTitleKey)
      );
    const historyTitleKeys = toTitleKeys(historyKeys);
    const poolTitleKeys = toTitleKeys(poolKeys);

    const seenThisRun = new Set<string>();
    const seenTitlesThisRun = new Set<string>();

    const isExcluded = (track: SpotifyTrack) => {
      const key = trackContentKey(track);
      const titleKey = titleKeyFromContentKey(key);
      const titleDistinctive = isDistinctiveTitleKey(titleKey);

      if (track.artists.some((a) => suppressedArtistIds.has(a.id))) return true;

      if (seenThisRun.has(key)) return true;
      if (titleDistinctive && seenTitlesThisRun.has(titleKey)) return true;

      if (saved.ids.has(track.id) || saved.contentKeys.has(key)) return true;
      if (titleDistinctive && saved.titleKeys.has(titleKey)) return true;

      if (historyIds.has(track.id) || historyKeys.has(key)) return true;
      if (titleDistinctive && historyTitleKeys.has(titleKey)) return true;

      if (poolIds.has(track.id) || poolKeys.has(key)) return true;
      if (titleDistinctive && poolTitleKeys.has(titleKey)) return true;

      return false;
    };

    const markSeen = (track: SpotifyTrack) => {
      const key = trackContentKey(track);
      seenThisRun.add(key);
      const titleKey = titleKeyFromContentKey(key);
      if (isDistinctiveTitleKey(titleKey)) seenTitlesThisRun.add(titleKey);
    };

    // Grouped by artist/genre-bucket (not a flat list) so interleaveByArtist
    // can space out repeats below - a plain shuffle over a flat list can't
    // guarantee that.
    const artistGroups = new Map<string, ArtistGroup>();
    const addToGroup = (
      groupKey: string,
      weight: number,
      track: SpotifyTrack,
      source: string
    ): boolean => {
      if (isExcluded(track)) return false;
      markSeen(track);
      let group = artistGroups.get(groupKey);
      if (!group) {
        group = { key: groupKey, weight, items: [] };
        artistGroups.set(groupKey, group);
      }
      group.items.push({ track, source });
      return true;
    };

    let totalCollected = 0;
    const budgetLeft = () => maxNewTracks - totalCollected;

    // Streams collected candidates to the DB in chunks instead of one bulk
    // insert at the very end, so a caller can get an early, usable batch
    // back (see fastBatchSize/onFastBatchReady) while collection keeps
    // running in the background - this is what lets refillPoolFastStart
    // respond almost immediately with the first ~100 tracks instead of
    // blocking on the full pool build. Trade-off: each chunk is interleaved
    // independently rather than the whole run being jointly interleaved at
    // the end, so artist-spacing is slightly less globally optimal across
    // chunk boundaries - acceptable for being able to stream results out at
    // all. flush() is a no-op (aside from bookkeeping) once nothing new has
    // accumulated, so calling it liberally between loop iterations is cheap.
    let flushedTotal = 0;
    let nextFlushAt = opts.fastBatchSize
      ? Math.min(opts.fastBatchSize, maxNewTracks)
      : maxNewTracks;
    let fastCallbackFired = false;
    const flush = async (force = false) => {
      if (!force && totalCollected < nextFlushAt) return;
      const chunkGroups = Array.from(artistGroups.values()).filter(
        (g) => g.items.length > 0
      );
      const chunk = interleaveByArtist(chunkGroups);
      for (const g of artistGroups.values()) g.items = [];
      if (chunk.length > 0) {
        await insertPoolCandidates(userId, chunk);
        flushedTotal += chunk.length;
      }
      if (!fastCallbackFired) {
        fastCallbackFired = true;
        opts.onFastBatchReady?.({ added: flushedTotal });
      }
      nextFlushAt += BACKGROUND_CHUNK_SIZE;
    };

    // Top artists (union of short/medium/long term): highest-weighted well.
    // This used to call GET /artists/{id}/top-tracks first (one API call,
    // reliable ~10 tracks/artist) and only fall back to search when that
    // came back thin. That endpoint was permanently REMOVED in Spotify's
    // Feb 2026 dev-mode changes (confirmed via runtime logs showing 403 on
    // every distinct artist id, cross-referenced against Spotify's official
    // migration guide) - calling it now always fails AND was silently
    // doubling this loop's API volume back up (the old "fall back to search
    // only when thin" condition was always true once top-tracks always
    // returned []), which is exactly the call-volume problem the earlier
    // rate-limit fix tried to avoid. Search is now the only source here,
    // one call per artist, at the new max limit of 10.
    for (const artist of topArtists) {
      if (budgetLeft() <= 0) break;
      if (suppressedArtistIds.has(artist.id)) continue;
      const tracks = await searchTracksByArtist(accessToken, artist.name, {
        limit: SEARCH_PAGE_SIZE,
      });
      for (const t of tracks) {
        if (budgetLeft() <= 0) break;
        if (addToGroup(`artist:${artist.id}`, 3, t, "top_artist")) {
          totalCollected++;
        }
      }
      await flush();
    }

    // Recently played artists: medium weight, catches current listening
    // habits that may not have caught up to the top-artist rankings yet.
    const recentArtistNames = Array.from(
      new Set(recentTracks.flatMap((t) => t.artists.map((a) => a.name)))
    ).slice(0, 12);
    for (const name of recentArtistNames) {
      if (budgetLeft() <= 0) break;
      const tracks = await searchTracksByArtist(accessToken, name, {
        limit: SEARCH_PAGE_SIZE,
      });
      for (const t of tracks) {
        if (budgetLeft() <= 0) break;
        if (addToGroup(`recent:${name.toLowerCase()}`, 2, t, "recent_artist")) {
          totalCollected++;
        }
      }
      await flush();
    }

    // Genre discovery: lowest weight, capped to a minority share of the
    // batch so it supplements rather than displaces personalized picks even
    // once the artist wells above start running low late in a session.
    const genreBudget = Math.floor(maxNewTracks * MAX_GENRE_SHARE);
    let genreCollected = 0;
    for (const genre of GENRE_DISCOVERY_SEEDS) {
      if (budgetLeft() <= 0 || genreCollected >= genreBudget) break;
      const tracks = await searchTracksByGenre(accessToken, genre, {
        limit: SEARCH_PAGE_SIZE,
      });
      for (const t of tracks) {
        if (budgetLeft() <= 0 || genreCollected >= genreBudget) break;
        if (addToGroup(`genre:${genre}`, 1, t, "genre_discovery")) {
          totalCollected++;
          genreCollected++;
        }
      }
      await flush();
    }

    // Force-flush whatever's left uncommitted (a partial chunk smaller than
    // BACKGROUND_CHUNK_SIZE, or - if fastBatchSize was never reached at all,
    // e.g. a very small library - the very first and only flush, which also
    // fires onFastBatchReady here if it hasn't fired yet).
    await flush(true);

    // Second check: rate limiting can also kick in partway through the
    // per-artist/recent/genre loops above rather than on the very first
    // batch. If it did AND we ended up with nothing to show for it, don't
    // call this a success - throw so it gets recorded as the real failure
    // it is.
    if (isSpotifyRateLimited() && flushedTotal === 0) {
      throw new Error(
        "Spotify rate limit (429) hit partway through building your feed - backing off before trying again."
      );
    }

    // Second layer of defense: retroactively clean anything already liked
    // (in this app or directly in Spotify) out of the pool.
    await pruneLikedFromPool(userId, accessToken);

    await setPoolState(userId, {
      refilling: false,
      last_refilled_at: new Date().toISOString(),
      last_error: null,
    });

    return { added: flushedTotal };
  } catch (err: any) {
    // IMPORTANT: stamp last_refilled_at here too, not just on success.
    // /api/feed/refill's cooldown check gates on last_refilled_at - if a
    // failed attempt never updates it, the cooldown never engages and the
    // frontend's auto-retry-every-4s loop hammers Spotify again immediately
    // on every failure. This was the concrete cause of a transient Spotify
    // 429 turning into a sustained app-wide rate-limit ban (severe enough to
    // also 429 the OAuth userinfo call, breaking sign-in entirely) - each
    // retry kept the ban window sliding forward instead of letting it clear.
    await setPoolState(userId, {
      refilling: false,
      last_refilled_at: new Date().toISOString(),
      last_error: err?.message || String(err),
    });
    throw err;
  }
}

/**
 * Two-phase entry point for "Refresh Feed" and the initial/auto pool build:
 * resolves as soon as the first FAST_BATCH_SIZE tracks are flushed, while
 * the rest of the (still fully sequential, rate-limit-safe) collection
 * keeps running to completion in the background via Vercel's waitUntil -
 * see refillPool's fastBatchSize/onFastBatchReady. This is what makes those
 * flows feel close to instant instead of blocking on the full pool build:
 * the caller gets back a small, immediately-usable batch, and the pool
 * keeps quietly filling in behind it for an endless-scroll feel rather than
 * hitting a hard wall once the fast batch runs out.
 *
 * waitUntil keeps the serverless invocation alive past the point the
 * caller's response is sent, but does NOT guarantee it can't still be
 * interrupted by the platform's function-duration limit if the background
 * phase runs long - that's fine here because flush() commits progress
 * incrementally rather than only at the very end, so an interrupted run
 * just leaves a partially-filled pool (still fully usable) instead of
 * losing collected work. pool_state.refilling stays true for the ENTIRE
 * duration (both phases), so a concurrent /api/feed/refill call from the
 * client correctly sees "already refilling" and doesn't kick off a
 * duplicate, overlapping collection run.
 */
export async function refillPoolFastStart(
  userId: string,
  accessToken: string,
  opts: { maxNewTracks?: number } = {}
): Promise<{ added: number }> {
  let settleFast: (result: { added: number }) => void;
  let rejectFast: (err: any) => void;
  const fastResult = new Promise<{ added: number }>((resolve, reject) => {
    settleFast = resolve;
    rejectFast = reject;
  });

  const fullRun = refillPool(userId, accessToken, {
    maxNewTracks: opts.maxNewTracks,
    fastBatchSize: FAST_BATCH_SIZE,
    onFastBatchReady: (result) => settleFast(result),
  });

  // Covers the case where the whole run fails before ever reaching a fast
  // flush (e.g. an immediate rate limit) - without this, fastResult would
  // just hang forever instead of surfacing the error to the caller.
  fullRun.catch((err) => rejectFast(err));

  waitUntil(
    fullRun.catch((err) => {
      console.error("[refillPoolFastStart] background phase failed:", err);
    })
  );

  return fastResult;
}

interface BoostOptions {
  mode: "artist" | "similar";
  trackId: string;
  artistId: string;
  artistName: string;
}

const BOOST_LIMIT = 25;

/** Small local shuffle so multi-source boost results (genre searches +
 * artist search pages) don't land in rigid source-grouped blocks. */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pages through /search for a given artist name, feeding each page through
 * `add` (which applies the exclusion pipeline) until either enough
 * candidates have been collected or a page comes back short (meaning
 * there's nothing more Spotify has to offer for this query).
 *
 * This exists because of a very real bug this feature had: refillPool
 * already runs a `searchTracksByArtist(name)` at offset 0 for every one of
 * the user's top/recent artists, so a boost request for one of THOSE
 * artists - the most likely ones a user would actually click "More by X"
 * on - was re-running the identical query and getting back the identical
 * results, all of which were already in the pool and got filtered out by
 * isExcluded. The boost silently "succeeded" with 0 new tracks. Paging
 * through further offsets is what actually surfaces content the initial
 * refill didn't already claim. This got more important, not less, after
 * Spotify's Feb 2026 changes dropped /search's max page size from 50 to
 * 10 - a single call now supplies far fewer candidates than before.
 */
async function searchArtistPaged(
  accessToken: string,
  artistName: string,
  add: (tracks: SpotifyTrack[], source: string) => void,
  source: string,
  hasEnough: () => boolean,
  maxPages = 4
): Promise<void> {
  for (let page = 0; page < maxPages && !hasEnough(); page++) {
    const tracks = await searchTracksByArtist(accessToken, artistName, {
      limit: SEARCH_PAGE_SIZE,
      offset: page * SEARCH_PAGE_SIZE,
    });
    if (tracks.length === 0) break; // exhausted - no more pages to try
    add(tracks, source);
    if (tracks.length < SEARCH_PAGE_SIZE) break; // that was the last page
  }
}

/**
 * Powers the "More like this" / "More by this artist" in-feed steering
 * buttons. Runs the exact same exclusion pipeline as refillPool (real
 * Liked Songs, this app's history, and the current pool - all via both
 * exact-id and fuzzy content/title keys) so boosted tracks can't
 * reintroduce the liked-song or duplicate-track bugs this feature shipped
 * alongside a fix for. Candidates are inserted via
 * insertPriorityPoolCandidates, which pins them to serve next rather than
 * queueing behind the rest of the pool.
 */
export async function boostFeed(
  userId: string,
  accessToken: string,
  opts: BoostOptions
): Promise<PoolRow[]> {
  // These four lookups are all independent (one Spotify call, three
  // Supabase reads) - running them concurrently instead of one at a time
  // shaves the sum of the Supabase round trips off every boost click's
  // latency. refillPool already does this for its own independent fetches;
  // this one was just never brought in line with that.
  const [saved, historyResult, poolResult, suppressedArtistIds] =
    await Promise.all([
      getMySavedTracksAll(accessToken),
      supabase
        .from("track_history")
        .select("track_id, track_key")
        .eq("user_id", userId),
      supabase
        .from("track_pool")
        .select("track_id, track_key")
        .eq("user_id", userId),
      // Respects "Less like this" here too: a boosted "similar" search
      // could otherwise resurface a suppressed artist via genre overlap.
      getSuppressedArtistIds(userId),
    ]);

  // Same silent-failure gap as refillPool (see the comment there): every
  // Spotify helper returns [] on a 429, so without this check a
  // rate-limited boost would just quietly return "0 songs found" with no
  // indication anything was actually wrong.
  if (isSpotifyRateLimited()) {
    throw new Error(
      "Spotify rate limit (429) hit - try again in a minute or two."
    );
  }

  const historyRows = historyResult.data;
  const historyIds = new Set((historyRows || []).map((r) => r.track_id));
  const historyKeys = new Set(
    (historyRows || []).map((r) => r.track_key).filter(Boolean) as string[]
  );

  const existingPool = poolResult.data;
  const poolIds = new Set((existingPool || []).map((r) => r.track_id));
  const poolKeys = new Set(
    (existingPool || []).map((r) => r.track_key).filter(Boolean) as string[]
  );

  const toTitleKeys = (keys: Set<string>) =>
    new Set(
      Array.from(keys).map(titleKeyFromContentKey).filter(isDistinctiveTitleKey)
    );
  const historyTitleKeys = toTitleKeys(historyKeys);
  const poolTitleKeys = toTitleKeys(poolKeys);

  const seen = new Set<string>();
  const seenTitles = new Set<string>();

  const isExcluded = (track: SpotifyTrack) => {
    const key = trackContentKey(track);
    const titleKey = titleKeyFromContentKey(key);
    const distinctive = isDistinctiveTitleKey(titleKey);

    if (track.artists.some((a) => suppressedArtistIds.has(a.id))) return true;

    if (seen.has(key)) return true;
    if (distinctive && seenTitles.has(titleKey)) return true;

    if (saved.ids.has(track.id) || saved.contentKeys.has(key)) return true;
    if (distinctive && saved.titleKeys.has(titleKey)) return true;

    if (historyIds.has(track.id) || historyKeys.has(key)) return true;
    if (distinctive && historyTitleKeys.has(titleKey)) return true;

    if (poolIds.has(track.id) || poolKeys.has(key)) return true;
    if (distinctive && poolTitleKeys.has(titleKey)) return true;

    return false;
  };

  const collected: Candidate[] = [];
  const add = (tracks: SpotifyTrack[], source: string) => {
    for (const t of tracks) {
      if (collected.length >= BOOST_LIMIT) return;
      if (isExcluded(t)) continue;
      const key = trackContentKey(t);
      seen.add(key);
      const titleKey = titleKeyFromContentKey(key);
      if (isDistinctiveTitleKey(titleKey)) seenTitles.add(titleKey);
      collected.push({ track: t, source });
    }
  };

  if (opts.mode === "artist") {
    // GET /artists/{id}/top-tracks is permanently gone (Feb 2026 dev-mode
    // changes) - search is the only remaining source. Page through several
    // offsets (see searchArtistPaged) instead of a single call, since a
    // single offset-0 call almost always just re-fetches what refillPool
    // already put in the pool for this exact artist.
    await searchArtistPaged(
      accessToken,
      opts.artistName,
      add,
      "boost_artist",
      () => collected.length >= BOOST_LIMIT
    );
  } else {
    // "similar": deliberately a DIFFERENT kind of steering than "artist"
    // mode - a broader genre/vibe shift that surfaces OTHER artists in a
    // related space, not more of this same one (that's what "More by
    // artist" is for). This distinction used to collapse in practice: the
    // old fallback, whenever genre data or recommendations came up empty,
    // silently re-ran the same per-artist search "artist" mode uses -
    // making the two buttons feel identical, which is exactly what was
    // reported. Fixed two ways below: (1) any track by the seed artist is
    // explicitly filtered out of "similar" results, and (2) the fallback
    // when the seed artist has no tagged genres is a few of the app's
    // generic genre-discovery seeds, never a same-artist search.
    //
    // GET /recommendations is permanently gone (removed for non-Extended-
    // Quota apps; confirmed 404 in production logs), so genre search is
    // the only real signal available. getArtist() (singular /artists/{id})
    // is NOT one of the removed endpoints, so genres are still available
    // here even though top-tracks and recommendations aren't - though
    // Spotify has been sparser about tagging genres on individual artists
    // lately, which is why the seed-less fallback below matters.
    const artist = await getArtist(accessToken, opts.artistId);
    let genres = (artist?.genres || []).slice(0, 3);
    if (genres.length === 0) {
      genres = shuffleInPlace([...GENRE_DISCOVERY_SEEDS]).slice(0, 3);
    }

    const addOtherArtists = (tracks: SpotifyTrack[], source: string) => {
      add(
        tracks.filter((t) => !t.artists.some((a) => a.id === opts.artistId)),
        source
      );
    };

    for (const genre of genres) {
      if (collected.length >= BOOST_LIMIT) break;
      // Page through a couple of offsets per genre too - at the new
      // limit=10 cap, one page per genre isn't enough to reliably fill
      // BOOST_LIMIT once seed-artist tracks get filtered out above.
      for (let page = 0; page < 2 && collected.length < BOOST_LIMIT; page++) {
        const tracks = await searchTracksByGenre(accessToken, genre, {
          limit: SEARCH_PAGE_SIZE,
          offset: page * SEARCH_PAGE_SIZE,
        });
        if (tracks.length === 0) break;
        addOtherArtists(tracks, "boost_similar");
        if (tracks.length < SEARCH_PAGE_SIZE) break;
      }
    }
  }

  shuffleInPlace(collected);

  return insertPriorityPoolCandidates(userId, collected);
}
