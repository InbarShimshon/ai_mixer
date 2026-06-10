// 3rd-party analysis provider: looks up BPM + key (Camelot) per track.
//
// Default: GetSongBPM (https://getsongbpm.com/api) — free with an API key,
// requires a visible backlink on your site per their terms.
// Swap PROVIDER or implement another lookup() to change sources.

const MUSICAL_TO_CAMELOT = {
  // key(0-11, pitch class) + mode(0 minor /1 major) -> Camelot
  // Provided as a helper if you later get key as note+mode instead of Camelot.
};

// Map an open-key / musical key string from GetSongBPM to Camelot.
// GetSongBPM returns e.g. "key_of": "G", "mode": "minor".
const NOTE_INDEX = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
// Camelot numbers indexed by pitch class for major (B ring) and minor (A ring).
const MAJOR_CAMELOT = { 0: 8, 1: 3, 2: 10, 3: 5, 4: 12, 5: 7, 6: 2, 7: 9, 8: 4, 9: 11, 10: 6, 11: 1 };
const MINOR_CAMELOT = { 0: 5, 1: 12, 2: 7, 3: 2, 4: 9, 5: 4, 6: 11, 7: 6, 8: 1, 9: 8, 10: 3, 11: 10 };

export function toCamelot(keyOf, mode) {
  if (!keyOf) return null;
  const pc = NOTE_INDEX[keyOf.trim()];
  if (pc === undefined) return null;
  const isMajor = (mode || "").toLowerCase().startsWith("maj");
  const num = (isMajor ? MAJOR_CAMELOT : MINOR_CAMELOT)[pc];
  return num ? `${num}${isMajor ? "B" : "A"}` : null;
}

// Look up one track. Returns { bpm, camelot, energy } with nulls when unknown.
export async function lookup({ name, artist }, env) {
  const key = env.GETSONGBPM_API_KEY;
  if (!key) return { bpm: null, camelot: null, energy: null, source: "none" };
  try {
    const q = encodeURIComponent(`song:${name} artist:${artist}`);
    const url = `https://api.getsong.co/search/?api_key=${key}&type=both&lookup=${q}`;
    const res = await fetch(url);
    if (!res.ok) return { bpm: null, camelot: null, energy: null, source: "error" };
    const data = await res.json();
    const hit = Array.isArray(data.search) ? data.search[0] : null;
    if (!hit) return { bpm: null, camelot: null, energy: null, source: "miss" };
    return {
      bpm: hit.tempo ? Number(hit.tempo) : null,
      camelot: toCamelot(hit.key_of, hit.mode),
      energy: null, // GetSongBPM has no energy; harmonic.js falls back to BPM proxy
      source: "getsongbpm",
    };
  } catch {
    return { bpm: null, camelot: null, energy: null, source: "error" };
  }
}

// Analyze a list with light concurrency control.
export async function analyzeAll(tracks, env) {
  const out = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < tracks.length; i += CONCURRENCY) {
    const batch = tracks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((t) => lookup(t, env)));
    batch.forEach((t, j) => out.push({ ...t, ...results[j] }));
  }
  return out;
}
