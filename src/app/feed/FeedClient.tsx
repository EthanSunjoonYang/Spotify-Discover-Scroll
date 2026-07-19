"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";

interface Track {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { name: string; images: { url: string }[] };
  preview_url: string | null;
  uri: string;
  duration_ms: number;
  external_urls?: { spotify?: string };
}

interface QueueItem {
  poolRowId: string;
  track: Track;
  source: string;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: any;
  }
}

const PREFETCH_THRESHOLD = 3;
const SWIPE_THRESHOLD_PX = 80;
const WHEEL_THRESHOLD = 12;
const NAV_LOCK_MS = 550;

export default function FeedClient() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);

  // Starts paused (not auto-attempting playback) - browsers block unmuted
  // audio until a genuine user gesture anyway, so rather than fighting that
  // with autoplay hacks, the first card just shows a small "Press to play"
  // hint over the album art (see the isActive && paused block below) and
  // waits for an explicit tap there. That tap is a real click handler, so
  // it satisfies the browser's gesture requirement outright. Subsequent
  // cards keep playing automatically on swipe (goToIndex sets paused back
  // to false), since by then playback has already been unlocked once.
  const [paused, setPaused] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [boostBanner, setBoostBanner] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [boostingId, setBoostingId] = useState<string | null>(null);
  const [boostMode, setBoostMode] = useState<"artist" | "similar" | null>(null);
  const [suppressingId, setSuppressingId] = useState<string | null>(null);
  const [suppressedConfirmedId, setSuppressedConfirmedId] = useState<
    string | null
  >(null);

  // Playback source is derived, not a one-way flag: sdkFailed is set only by
  // a genuine SDK error (bad auth, no Premium, etc.) and sticks for the
  // session; sdkReady/deviceId reflect the SDK's actual current state. This
  // way a slow-to-connect SDK falls back to previews temporarily but hands
  // playback back to the SDK the moment it's ready, instead of getting
  // stuck showing "no preview" forever once a 6s timer fired.
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [sdkFailed, setSdkFailed] = useState(false);
  const usingPreviewFallback = sdkFailed || !sdkReady || !deviceId;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerRef = useRef<any>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const activeIndexRef = useRef(0);
  const actedRef = useRef<Set<string>>(new Set());
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const navLockRef = useRef(false);
  const errorBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boostBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const current = queue[activeIndex];

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const res = await fetch("/api/spotify/token");
    if (!res.ok) {
      if (res.status === 401) setReauthRequired(true);
      return null;
    }
    const data = await res.json();
    return data.access_token || null;
  }, []);

  const loadNextBatch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feed/next");
      if (res.status === 401) {
        setReauthRequired(true);
        return;
      }
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        // Nothing to serve - kick off / wait for a pool build.
        await triggerRefill();
        return;
      }

      setQueue((prev) => [...prev, ...data.tracks]);
    } catch (err: any) {
      setError(err?.message || "Failed to load songs.");
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerRefill = useCallback(async () => {
    setBuilding(true);
    setError(null);
    let needsReauth = false;
    try {
      const res = await fetch("/api/feed/refill", { method: "POST" });
      const data = await res.json();
      if (res.status === 401 && data.error === "reauth_required") {
        needsReauth = true;
        setReauthRequired(true);
        return;
      }
      if (data.error) {
        setError(data.detail || data.error);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to build your feed.");
    } finally {
      setBuilding(false);
      // `finally` runs even after the early `return` above, so this must be
      // guarded - otherwise an empty pool + reauth-required response would
      // loop refill <-> loadNextBatch forever.
      if (!needsReauth) {
        await loadNextBatch();
      }
    }
  }, [loadNextBatch]);

  useEffect(() => {
    loadNextBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-retry pool building if we run out of cards entirely.
  useEffect(() => {
    if (loading || building || queue.length - activeIndex > 0) return;
    if (reauthRequired) return;
    const t = setTimeout(() => {
      triggerRefill();
    }, 4000);
    return () => clearTimeout(t);
  }, [loading, building, queue.length, activeIndex, reauthRequired, triggerRefill]);

  // Prefetch more when running low.
  useEffect(() => {
    const remaining = queue.length - activeIndex;
    if (remaining > 0 && remaining <= PREFETCH_THRESHOLD && !loading) {
      loadNextBatch();
    }
  }, [activeIndex, queue.length, loading, loadNextBatch]);

  // Fire-and-forget: record a track as skipped because the user moved past
  // it without an explicit action - mirrors TikTok/Reels, where not acting
  // on something while swiping past it means "pass."
  const autoSkip = useCallback((idx: number) => {
    const item = queueRef.current[idx];
    if (!item || actedRef.current.has(item.poolRowId)) return;
    actedRef.current.add(item.poolRowId);
    fetch("/api/feed/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "skipped", track: item.track }),
    }).catch(() => {});
  }, []);

  // The one place that changes which card is showing. Always moves exactly
  // one card at a time (callers only ever pass activeIndex +/- 1), which is
  // what makes this a swipe/paginate system instead of continuous scroll.
  const goToIndex = useCallback(
    (idx: number) => {
      const max = queueRef.current.length - 1;
      const clamped = Math.max(0, Math.min(idx, max));
      setActiveIndex((prev) => {
        if (clamped === prev) return prev;
        if (clamped > prev) autoSkip(prev);
        return clamped;
      });
      setPaused(false);
    },
    [autoSkip]
  );

  const handleSkip = useCallback(
    (idx: number) => {
      const item = queueRef.current[idx];
      if (!item) return;
      if (!actedRef.current.has(item.poolRowId)) {
        actedRef.current.add(item.poolRowId);
        fetch("/api/feed/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "skipped", track: item.track }),
        }).catch(() => {});
      }
      goToIndex(idx + 1);
    },
    [goToIndex]
  );

  const showErrorBanner = useCallback((text: string) => {
    setErrorBanner(text);
    if (errorBannerTimer.current) clearTimeout(errorBannerTimer.current);
    errorBannerTimer.current = setTimeout(() => setErrorBanner(null), 6000);
  }, []);

  const handleLike = useCallback(
    async (idx: number) => {
      const item = queueRef.current[idx];
      if (!item || actedRef.current.has(item.poolRowId)) return;
      setSavingId(item.poolRowId);
      try {
        const res = await fetch("/api/feed/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "liked", track: item.track }),
        });
        const data = await res.json();

        if (data.reauthRequired) {
          setReauthRequired(true);
          return;
        }
        if (!data.savedToSpotify) {
          showErrorBanner(
            `Couldn't save "${item.track.name}" to Spotify${
              data.detail ? ` - ${data.detail}` : ""
            }`
          );
          return;
        }

        actedRef.current.add(item.poolRowId);
        setLikedIds((prev) => new Set(prev).add(item.poolRowId));
        goToIndex(idx + 1);
      } catch (err: any) {
        showErrorBanner(err?.message || "Something went wrong saving this song.");
      } finally {
        setSavingId(null);
      }
    },
    [goToIndex, showErrorBanner]
  );

  // Fully regenerates the feed on demand: wipes the server-side candidate
  // pool and rebuilds it, then resets all local queue/progress state so the
  // very next card comes from the fresh pool. track_history (liked/skipped)
  // is untouched server-side, so this can't bring back anything already
  // acted on - only reshuffles/rebuilds what's still undiscovered.
  const handleResetFeed = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/feed/reset", { method: "POST" });
      const data = await res.json();
      if (res.status === 401 && data.error === "reauth_required") {
        setReauthRequired(true);
        return;
      }
      if (data.error) {
        showErrorBanner(data.detail || "Couldn't refresh your feed.");
        return;
      }
      actedRef.current = new Set();
      setLikedIds(new Set());
      setQueue([]);
      setActiveIndex(0);
      await loadNextBatch();
    } catch (err: any) {
      showErrorBanner(err?.message || "Couldn't refresh your feed.");
    } finally {
      setResetting(false);
    }
  }, [loadNextBatch, showErrorBanner]);

  const showBoostBanner = useCallback((text: string) => {
    setBoostBanner(text);
    if (boostBannerTimer.current) clearTimeout(boostBannerTimer.current);
    boostBannerTimer.current = setTimeout(() => setBoostBanner(null), 5000);
  }, []);

  // "More like this" / "More by this artist" - lets the user steer the
  // feed in real time instead of only reacting to what's already queued.
  // Fetches related tracks server-side (see /api/feed/boost), then splices
  // them into the local queue right after the current card - not appended
  // at the end - so the next few swipes actually show the requested
  // content instead of it being stuck behind whatever was already
  // prefetched.
  const handleBoost = useCallback(
    async (idx: number, mode: "artist" | "similar") => {
      const item = queueRef.current[idx];
      if (!item) return;
      const primaryArtist = item.track.artists[0];
      if (!primaryArtist) return;

      setBoostingId(item.poolRowId);
      setBoostMode(mode);
      try {
        const res = await fetch("/api/feed/boost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            trackId: item.track.id,
            artistId: primaryArtist.id,
            artistName: primaryArtist.name,
          }),
        });
        const data = await res.json();

        if (res.status === 401 && data.error === "reauth_required") {
          setReauthRequired(true);
          return;
        }
        if (data.error) {
          showBoostBanner(data.detail || "Couldn't find more songs right now.");
          return;
        }

        const added: QueueItem[] = data.tracks || [];
        if (added.length === 0) {
          showBoostBanner(
            mode === "artist"
              ? `Couldn't find more by ${primaryArtist.name} right now.`
              : "Couldn't find similar songs right now."
          );
          return;
        }

        setQueue((prev) => {
          const upToCurrent = prev.slice(0, idx + 1);
          const rest = prev.slice(idx + 1);
          const existingIds = new Set(prev.map((q) => q.poolRowId));
          const fresh = added.filter((q) => !existingIds.has(q.poolRowId));
          return [...upToCurrent, ...fresh, ...rest];
        });

        showBoostBanner(
          mode === "artist"
            ? `Added ${added.length} more by ${primaryArtist.name}`
            : `Added ${added.length} similar songs`
        );
      } catch (err: any) {
        showBoostBanner(err?.message || "Couldn't find more songs right now.");
      } finally {
        setBoostingId(null);
        setBoostMode(null);
      }
    },
    [showBoostBanner]
  );

  // "Less like this" - the inverse of the boost buttons. Records the
  // current track as skipped and tells the server to stop recommending
  // this artist at all (see /api/feed/suppress + suppressArtist), then
  // scrubs any other already-queued cards by the same artist out of the
  // local queue so the effect is felt immediately, not just on future
  // fetches. Reuses the acted-ref + goToIndex pattern from handleLike so
  // autoSkip doesn't double-record the same track.
  //
  // Two-phase visual feedback: the button first shows "Updating..."
  // (disabled) while the request is in flight, same as before. On success
  // it flips to a solid, filled "confirmed" state (see suppressedConfirmedId
  // + the .confirmed CSS class) instead of the card advancing instantly -
  // advancing immediately made the click feel like it hadn't registered.
  // The brief pause gives that confirmed state a moment to actually be
  // seen before the auto-scroll to the next card happens.
  const handleSuppress = useCallback(
    async (idx: number) => {
      const item = queueRef.current[idx];
      if (!item || actedRef.current.has(item.poolRowId)) return;
      const primaryArtist = item.track.artists[0];
      if (!primaryArtist) return;

      setSuppressingId(item.poolRowId);
      try {
        const res = await fetch("/api/feed/suppress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            track: item.track,
            artistId: primaryArtist.id,
            artistName: primaryArtist.name,
          }),
        });
        const data = await res.json();

        if (res.status === 401 && data.error === "reauth_required") {
          setReauthRequired(true);
          return;
        }
        if (data.error) {
          showBoostBanner(data.detail || "Couldn't update your feed.");
          return;
        }

        actedRef.current.add(item.poolRowId);
        setSuppressedConfirmedId(item.poolRowId);
        showBoostBanner(`Won't show more by ${primaryArtist.name}`);

        // Let the confirmed (filled/checked) button state actually be
        // visible before the card transitions away.
        await new Promise((r) => setTimeout(r, 450));

        setQueue((prev) => {
          const upToCurrent = prev.slice(0, idx + 1);
          const rest = prev
            .slice(idx + 1)
            .filter((q) => q.track.artists[0]?.id !== primaryArtist.id);
          return [...upToCurrent, ...rest];
        });

        goToIndex(idx + 1);
      } catch (err: any) {
        showBoostBanner(err?.message || "Couldn't update your feed.");
      } finally {
        setSuppressingId(null);
        setSuppressedConfirmedId(null);
      }
    },
    [goToIndex, showBoostBanner]
  );

  const togglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  // Wheel (trackpad/mouse) navigation: a single physical gesture fires many
  // small wheel events in quick succession. Act on the first one that
  // crosses the threshold, then lock out further events for NAV_LOCK_MS so
  // the rest of that same gesture can't advance more than one card.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (navLockRef.current) return;
      if (Math.abs(e.deltaY) < WHEEL_THRESHOLD) return;
      navLockRef.current = true;
      setTimeout(() => {
        navLockRef.current = false;
      }, NAV_LOCK_MS);
      goToIndex(activeIndexRef.current + (e.deltaY > 0 ? 1 : -1));
    },
    [goToIndex]
  );

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }, []);

  const onTouchEnd = useCallback(
    (idx: number) => (e: React.TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;

      if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) handleSkip(idx);
        else handleLike(idx);
        return;
      }
      if (Math.abs(dy) > SWIPE_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
        goToIndex(idx + (dy < 0 ? 1 : -1));
      }
    },
    [handleSkip, handleLike, goToIndex]
  );

  // Web Playback SDK setup. sdkFailed is the only thing that permanently
  // commits to preview-only playback; a plain "hasn't connected yet" state
  // just means we play previews *for now* and hand off the moment it's
  // ready (see usingPreviewFallback above).
  useEffect(() => {
    let cancelled = false;

    const markFailed = () => setSdkFailed(true);

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      if (cancelled) return;
      const player = new window.Spotify!.Player({
        name: "Discover Scroll",
        getOAuthToken: async (cb: (token: string) => void) => {
          const token = await fetchToken();
          if (token) cb(token);
          else markFailed();
        },
        volume: 0.8,
      });

      player.addListener("ready", ({ device_id }: { device_id: string }) => {
        if (cancelled) return;
        setDeviceId(device_id);
        setSdkReady(true);
      });

      player.addListener("not_ready", () => {
        if (cancelled) return;
        setSdkReady(false);
      });

      player.addListener("initialization_error", markFailed);
      player.addListener("authentication_error", markFailed);
      player.addListener("account_error", markFailed); // e.g. non-Premium
      player.addListener("playback_error", () => {});

      player.connect();
      playerRef.current = player;
    };

    return () => {
      cancelled = true;
      playerRef.current?.disconnect?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sdkFailed) {
      setInfoBanner(
        "Full playback needs Spotify Premium - playing 30s previews instead."
      );
    }
  }, [sdkFailed]);

  // The actual "start playing the current card" routine, split out of the
  // driving effect below purely for readability.
  const startPlayback = useCallback(() => {
    if (!current) return;

    if (usingPreviewFallback) {
      if (audioRef.current) {
        audioRef.current.src = current.track.preview_url || "";
        if (current.track.preview_url) {
          audioRef.current.play().catch(() => {});
        }
      }
      return;
    }

    audioRef.current?.pause();
    (async () => {
      const token = await fetchToken();
      if (!token) return;
      await fetch(
        `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ uris: [current.track.uri] }),
        }
      ).catch(() => setSdkFailed(true));
    })();
  }, [current, usingPreviewFallback, deviceId, fetchToken]);

  // Drive playback whenever the active card, pause state, or playback
  // source (SDK vs. preview) changes. Since `paused` now starts true (see
  // above) and only flips to false via an explicit tap on the album art
  // (see togglePause in the JSX below) or a swipe to the next card, every
  // call to startPlayback() here traces back to a real user gesture -
  // browsers won't block it.
  useEffect(() => {
    if (!current) return;

    if (paused) {
      audioRef.current?.pause();
      playerRef.current?.pause?.();
      return;
    }

    startPlayback();
  }, [current, paused, startPlayback]);

  if (reauthRequired) {
    return (
      <main className="feed-status">
        <h2>Reconnect Spotify</h2>
        <p style={{ color: "#b3b3b3", maxWidth: 360 }}>
          Your Spotify permissions need to be refreshed (this happens after
          the app adds new capabilities, like saving songs). Sign out and
          sign back in to fix it.
        </p>
        <button
          className="spotify-btn"
          onClick={() => signOut({ callbackUrl: "/" })}
        >
          Sign out
        </button>
      </main>
    );
  }

  if (queue.length === 0 && (loading || building)) {
    // Deliberately a single, fixed message rather than switching text based
    // on `building` vs `loading` - a refill cycle flips through
    // loading -> building -> loading again (fetch pool -> rebuild pool ->
    // re-fetch the now-populated pool) before the queue is ready, and
    // swapping the headline each time that happens read as an annoying
    // flicker rather than progress.
    return (
      <main className="feed-status">
        <h2>Building your feed…</h2>
        <p style={{ color: "#b3b3b3" }}>
          Top artists, recently played, and a bit of genre discovery - this
          can take a few seconds.
        </p>
      </main>
    );
  }

  if (queue.length === 0 && error) {
    return (
      <main className="feed-status">
        <h2>Couldn&apos;t build your feed</h2>
        <pre className="diag">{error}</pre>
        <button className="spotify-btn" onClick={triggerRefill}>
          Retry now
        </button>
        <button
          className="ghost-btn signout"
          onClick={() => signOut({ callbackUrl: "/" })}
        >
          Sign out
        </button>
      </main>
    );
  }

  if (queue.length === 0) {
    return (
      <main className="feed-status">
        <h2>Still no songs found</h2>
        <p style={{ color: "#b3b3b3" }}>Building more of your feed…</p>
        <button className="spotify-btn" onClick={triggerRefill}>
          Retry now
        </button>
      </main>
    );
  }

  return (
    <div className="feed-shell">
      <audio ref={audioRef} />

      <button
        className="signout"
        onClick={() => signOut({ callbackUrl: "/" })}
      >
        Sign out
      </button>

      <button
        className="refresh-feed"
        onClick={handleResetFeed}
        disabled={resetting}
      >
        {resetting ? "Refreshing…" : "↻ Refresh Feed"}
      </button>

      {infoBanner && <div className="banner">{infoBanner}</div>}
      {boostBanner && <div className="banner">{boostBanner}</div>}
      {errorBanner && <div className="banner error">{errorBanner}</div>}

      <div className="feed-viewport" onWheel={onWheel}>
        <div
          className="feed-track"
          style={{ transform: `translateY(-${activeIndex * 100}dvh)` }}
        >
          {queue.map((item, idx) => {
            const art = item.track.album.images?.[0]?.url;
            const isActive = idx === activeIndex;
            const isLiked = likedIds.has(item.poolRowId);
            const isSaving = savingId === item.poolRowId;
            const noPreview = usingPreviewFallback && !item.track.preview_url;
            const isBoosting = boostingId === item.poolRowId;
            const isSuppressing = suppressingId === item.poolRowId;
            const isSuppressConfirmed = suppressedConfirmedId === item.poolRowId;
            const primaryArtistName = item.track.artists[0]?.name || "this artist";

            return (
              <div
                key={item.poolRowId}
                className="feed-card"
                onTouchStart={onTouchStart}
                onTouchEnd={onTouchEnd(idx)}
              >
                {art && (
                  <div
                    className="feed-card-bg"
                    style={{ backgroundImage: `url(${art})` }}
                  />
                )}
                <div className="feed-card-content">
                  {art && (
                    <div
                      className="feed-art-wrap"
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePause();
                      }}
                    >
                      <Image
                        src={art}
                        alt={item.track.album.name}
                        width={320}
                        height={320}
                        unoptimized
                        className="feed-art"
                      />
                      {isActive && paused && (
                        <div className="paused-indicator">Press to play</div>
                      )}
                    </div>
                  )}
                  <h2>{item.track.name}</h2>
                  <p className="artist">
                    {item.track.artists.map((a) => a.name).join(", ")}
                  </p>
                  {isActive && noPreview && (
                    <p style={{ color: "#e22134", fontSize: 13, marginTop: -12, marginBottom: 20 }}>
                      No preview available for this track - swipe to continue.
                    </p>
                  )}
                  <div className="feed-actions">
                    <button
                      className="action-btn skip"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSkip(idx);
                      }}
                    >
                      ✕ Skip
                    </button>
                    <button
                      className={`action-btn like${isSaving ? " saving" : ""}`}
                      disabled={isSaving}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLike(idx);
                      }}
                    >
                      {isSaving ? "Saving…" : isLiked ? "♥ Liked" : "♥ Like"}
                    </button>
                    <a
                      className="action-btn open"
                      href={
                        item.track.external_urls?.spotify ||
                        `https://open.spotify.com/track/${item.track.id}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open in Spotify
                    </a>
                  </div>
                  <div className="feed-secondary-actions">
                    <button
                      className="boost-btn more-btn"
                      disabled={isBoosting}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBoost(idx, "similar");
                      }}
                    >
                      {isBoosting && boostMode === "similar"
                        ? "Finding similar…"
                        : "More like this"}
                    </button>
                    <button
                      className="boost-btn more-btn"
                      disabled={isBoosting}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBoost(idx, "artist");
                      }}
                    >
                      {isBoosting && boostMode === "artist"
                        ? "Finding more…"
                        : `More by ${primaryArtistName}`}
                    </button>
                    <button
                      className={`boost-btn less-btn${
                        isSuppressConfirmed ? " confirmed" : ""
                      }`}
                      disabled={isSuppressing}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSuppress(idx);
                      }}
                    >
                      {isSuppressConfirmed
                        ? "✓ Won't recommend"
                        : isSuppressing
                        ? "Updating…"
                        : "Less like this"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
