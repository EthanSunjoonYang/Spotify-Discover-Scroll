# Discover Scroll

A TikTok/Reels-style swipeable song discovery feed, built on top of a user's
real Spotify listening history. Sign in with Spotify, swipe through tracks
pulled from your top artists, recent plays, and genre picks, and save the
ones you like straight to your real Spotify Liked Songs.

Check it out here: https://spotify-enhancer-six.vercel.app/feed 

## Features

- **Personalized, continuously replenished feed** - pulls a user's top
  artists (across three time ranges), recently played tracks, and genre
  picks from the Spotify Web API into a weighted, artist-interleaved
  candidate pool, refilled automatically as the user scrolls.
- **Fuzzy deduplication** - a regex-based normalization engine collapses
  remastered, live, clean/explicit, and slowed/sped-up/nightcore versions of
  a track down to one canonical key, so the same song never shows up twice
  and already-liked tracks never resurface.
- **In-feed steering** - "More like this" (a genre/vibe shift to other
  artists), "More by [artist]", and "Less like this" (artist suppression)
  let a user tune the feed in real time without leaving the card.
- **Real playback** - full-track playback via the Spotify Web Playback SDK
  for Premium accounts, with an automatic 30-second-preview fallback and an
  explicit "press to play" activation step that respects browser autoplay
  restrictions.
- **Resilient Spotify API client** - a rate-limit circuit breaker prevents a
  transient 429 from cascading into a sustained lockout, and pool refills
  fail loudly instead of silently serving an empty feed.

## Tech stack

Next.js 14 (App Router) - TypeScript - React - NextAuth (Spotify OAuth) -
Supabase (Postgres) - Spotify Web API & Web Playback SDK - deployed on
Vercel.

## Getting started

1. Create a Spotify app at the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and add `http://localhost:3000/api/auth/callback/spotify` as a Redirect
   URI.
2. Create a [Supabase](https://supabase.com) project with `users`,
   `spotify_tokens`, `track_pool`, `track_history`, `suppressed_artists`,
   and `pool_state` tables (see `src/lib/supabase.ts` for the exact columns
   each query expects).
3. Copy `.env.example` to `.env.local` and fill in your Spotify and
   Supabase credentials.
4. Install dependencies and run the dev server:

   ```bash
   npm install
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Deploying

The app is set up to deploy on [Vercel](https://vercel.com) with zero extra
configuration beyond setting the same environment variables from
`.env.example` in the project's Environment Variables settings.
