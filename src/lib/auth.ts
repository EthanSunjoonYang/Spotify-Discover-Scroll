import type { NextAuthOptions } from "next-auth";
import SpotifyProvider from "next-auth/providers/spotify";
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from "./spotify";
import { upsertSpotifyTokens, upsertUser } from "./supabase";

// IMPORTANT: keep this scope list as the single source of truth for what the
// app is allowed to do. If you add a new scope here, EVERY signed-in user
// must sign out and sign back in before it takes effect for them - Spotify
// refresh tokens do not retroactively gain scopes. This was the root cause
// of the Like button returning 403 even after the request body was fixed:
// the stored refresh token predated `user-library-modify` being added here.
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-top-read",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify",
  "streaming",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const NEXTAUTH_SECRET =
  process.env.NEXTAUTH_SECRET ||
  process.env.AUTH_SECRET ||
  "discover-scroll-fallback-secret-do-not-use-for-real-security-3f9a1c";

export const authOptions: NextAuthOptions = {
  secret: NEXTAUTH_SECRET,
  providers: [
    SpotifyProvider({
      clientId: SPOTIFY_CLIENT_ID,
      clientSecret: SPOTIFY_CLIENT_SECRET,
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        params: {
          scope: SCOPES,
          // Force Spotify's account picker/consent screen every time so the
          // user can deliberately switch accounts, and so re-authorizing
          // after a scope change is unambiguous (a fresh, visible consent
          // rather than a silent redirect that may reuse a stale session).
          show_dialog: "true",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, account }) {
      if (!account || account.provider !== "spotify" || !user.id) return true;

      await upsertUser({
        id: user.id,
        display_name: user.name,
        email: user.email,
        image_url: user.image,
      });

      // Unconditional overwrite - see note above. Never gate this on
      // "does a row already exist" - a fresh sign-in's tokens are always the
      // most current truth about what scopes were actually granted.
      if (account.access_token && account.refresh_token) {
        await upsertSpotifyTokens(user.id, {
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_at: new Date(
            (account.expires_at ? account.expires_at * 1000 : Date.now() + 3600_000)
          ).toISOString(),
          scope: (account.scope as string) || SCOPES,
        });
      }

      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.sub = (profile as any)?.id || token.sub;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
