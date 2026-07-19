// Fuzzy duplicate / version detection for tracks.
//
// Goal: "Bohemian Rhapsody", "Bohemian Rhapsody - Remastered 2011",
// "Bohemian Rhapsody (Live)", and "Bohemian Rhapsody (feat. Someone) - Radio Edit"
// should all collapse to the same key so we never show the user multiple versions
// of a song they already have, and never re-show a song they already liked just
// because Spotify returned a slightly different edition of it.

const VERSION_QUALIFIERS = [
  "remaster(ed)?( \\d{2,4})?",
  "re-?master(ed)?( \\d{2,4})?",
  "deluxe( edition| version)?",
  "live( at [^)]+)?( version)?",
  "acoustic( version)?",
  "clean( version)?",
  "explicit( version)?",
  "radio edit",
  "single( version)?",
  "album version",
  "mono( version)?",
  "stereo( version)?",
  "anniversary( edition)?",
  "bonus track",
  "extended( version| mix)?",
  "instrumental",
  "karaoke( version)?",
  "demo( version)?",
  "\\d{4} remaster(ed)?",
  "original( mix| version)?",
  // Algorithmic/bootleg remix tags - these are frequently uploaded as
  // separate tracks (sometimes under a "remix channel" artist credit) but
  // are the same underlying song and should be treated as duplicates.
  "(super |ultra |mega )?slowed( down| \\+? ?reverb| and reverb)?",
  "(\\+? ?)?reverb",
  "sped ?up( version)?",
  "nightcore",
  "chopped( (and|&) screwed)?",
  "screwed",
  "8d( audio)?",
  "bass boosted",
  "tiktok( remix| version)?",
  "phonk( remix)?",
];

const QUALIFIER_RE = new RegExp(
  `\\s*[-([]?\\s*(?:${VERSION_QUALIFIERS.join("|")})\\s*[)\\]]?\\s*`,
  "gi"
);

const FEATURE_RE = /\s*[-([]?\s*(feat\.?|featuring|ft\.?|with)\s+[^)\]-]+[)\]]?\s*/gi;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/&/g, "and")
    .replace(FEATURE_RE, " ")
    .replace(QUALIFIER_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface MinimalTrack {
  name: string;
  artists: { name: string }[];
}

/**
 * Produces a stable key representing "this song, any version, by its primary
 * artist". Used to dedupe candidate pools against each other and against the
 * user's real Liked Songs / history, independent of remaster / live / clean
 * tags or which collaborating artist Spotify lists first.
 */
export function trackContentKey(track: MinimalTrack): string {
  const title = normalize(track.name || "");
  const primaryArtist = normalize(track.artists?.[0]?.name || "");
  return `${primaryArtist}::${title}`;
}

/**
 * Title-only fallback key (no artist component). Needed because bootleg
 * remix uploads - slowed/sped-up/nightcore/etc. - are frequently credited
 * with the remix "channel" as the PRIMARY artist and the original artist
 * only as a secondary/featured credit, or vice versa. trackContentKey()
 * alone misses these since it keys off artists[0], which can differ between
 * the original and the remix even though it's clearly the same underlying
 * song. Callers should combine this with isDistinctiveTitleKey() to avoid
 * over-matching on short/generic titles shared by genuinely different songs.
 */
export function trackTitleKey(track: MinimalTrack): string {
  return normalize(track.name || "");
}

/** Extracts the title portion from a key produced by trackContentKey(). */
export function titleKeyFromContentKey(key: string): string {
  const idx = key.indexOf("::");
  return idx === -1 ? key : key.slice(idx + 2);
}

/**
 * Guards title-only matching from false-positiving on short/common titles
 * (e.g. "Home", "Intro") that many unrelated songs share.
 */
export function isDistinctiveTitleKey(titleKey: string): boolean {
  const words = titleKey.trim().split(" ").filter(Boolean);
  return titleKey.length >= 8 || words.length >= 2;
}
