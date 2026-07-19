import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getValidAccessToken, getPoolState } from "@/lib/supabase";
import { refillPool } from "@/lib/pool";

const COOLDOWN_MS = 15_000;
// Applied instead of COOLDOWN_MS when the last refill attempt failed with a
// Spotify rate-limit error. Retrying every 15s after a 429 just keeps
// re-triggering the ban (this is what previously turned a transient 429
// into a sustained lockout severe enough to also block Spotify sign-in
// itself) - back off much harder so the ban window actually gets a chance
// to clear.
const RATE_LIMIT_COOLDOWN_MS = 3 * 60 * 1000;

function isRateLimitError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /429|too many requests/i.test(message);
}

export async function POST() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const state = await getPoolState(userId);
  if (state?.refilling) {
    return NextResponse.json({ status: "already_refilling" });
  }
  if (state?.last_refilled_at) {
    const cooldown = isRateLimitError(state?.last_error)
      ? RATE_LIMIT_COOLDOWN_MS
      : COOLDOWN_MS;
    const elapsed = Date.now() - new Date(state.last_refilled_at).getTime();
    if (elapsed < cooldown) {
      return NextResponse.json({ status: "cooldown" });
    }
  }

  const tokens = await getValidAccessToken(userId);
  if (!tokens) {
    return NextResponse.json(
      { error: "reauth_required", detail: "No Spotify tokens on file." },
      { status: 401 }
    );
  }

  try {
    const result = await refillPool(userId, tokens.access_token);
    return NextResponse.json({ status: "ok", ...result });
  } catch (err: any) {
    return NextResponse.json(
      { error: "refill_failed", detail: err?.message || String(err) },
      { status: 500 }
    );
  }
}
