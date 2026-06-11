// Harmonic-mixing brain.
// Orders tracks so adjacent songs are key-compatible (Camelot wheel),
// tempo flows smoothly (BPM ramp), and energy follows an arc.
//
// Each input track: { id, name, artist, bpm, camelot, energy }
//   camelot: e.g. "8A" / "8B" (key in Camelot notation). null if unknown.
//   energy:  0..1. null if unknown -> BPM is used as a proxy.

// --- Camelot wheel compatibility -------------------------------------------
// Compatible moves from a given key: same key, +/-1 on the wheel (same letter),
// and the relative major/minor (toggle letter, same number).
function parseCamelot(c) {
  if (!c) return null;
  const m = /^(\d{1,2})([AB])$/.exec(c.trim().toUpperCase());
  if (!m) return null;
  return { num: parseInt(m[1], 10), letter: m[2] };
}

// Returns a 0..1 score for how harmonically smooth A -> B is.
export function keyScore(a, b) {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 0.5; // unknown key -> neutral, don't over-penalize
  if (ka.num === kb.num && ka.letter === kb.letter) return 1.0;      // same key
  if (ka.num === kb.num && ka.letter !== kb.letter) return 0.9;      // relative maj/minor
  const diff = Math.min(
    Math.abs(ka.num - kb.num),
    12 - Math.abs(ka.num - kb.num)
  );
  if (ka.letter === kb.letter && diff === 1) return 0.85;            // adjacent on wheel
  if (ka.letter === kb.letter && diff === 2) return 0.55;            // energy boost / 2 steps
  return 0.15;                                                        // clash
}

// Tempo smoothness: full score within ~3 BPM, decaying after.
export function bpmScore(a, b) {
  if (!a || !b) return 0.5;
  const d = Math.abs(a - b);
  if (d <= 3) return 1.0;
  if (d <= 6) return 0.8;
  if (d <= 10) return 0.55;
  if (d <= 16) return 0.3;
  return 0.1;
}

// Transition score between two tracks (higher = smoother mix).
export function transitionScore(a, b) {
  return 0.55 * keyScore(a.camelot, b.camelot) + 0.45 * bpmScore(a.bpm, b.bpm);
}

function energyOf(t) {
  if (typeof t.energy === "number") return t.energy;
  // Fallback proxy: normalize BPM into a rough 0..1 energy band.
  if (typeof t.bpm === "number") return Math.max(0, Math.min(1, (t.bpm - 70) / 90));
  return 0.5;
}

// --- Set ordering ----------------------------------------------------------
// Greedy nearest-neighbour walk that also nudges toward a build->peak->cooldown
// energy arc. Good enough for a set; returns ordered tracks + per-junction notes.
export function orderSet(tracks, opts = {}) {
  if (tracks.length <= 1) return { order: tracks.slice(), transitions: [] };
  const arc = opts.arc !== false; // energy arc on by default

  // Start from the lowest-energy track for a natural build.
  const remaining = tracks.slice();
  remaining.sort((a, b) => energyOf(a) - energyOf(b));
  const order = [remaining.shift()];

  const n = tracks.length;
  while (remaining.length) {
    const last = order[order.length - 1];
    const progress = order.length / n; // 0..1 through the set
    // Wedding arc: warm-up -> sustained dance-floor peak (~0.8 of the set)
    // -> gentle wind-down (stays danceable, not a hard drop).
    const target = arc
      ? (progress < 0.8 ? 0.4 + progress * 0.75 : 1.0 - (progress - 0.8) * 1.2)
      : energyOf(last);

    let bestIdx = 0;
    let bestScore = -Infinity;
    remaining.forEach((cand, i) => {
      const mix = transitionScore(last, cand);
      const arcFit = arc ? 1 - Math.abs(energyOf(cand) - target) : 0;
      const score = mix + 0.4 * arcFit;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    order.push(remaining.splice(bestIdx, 1)[0]);
  }

  return { order, transitions: buildTransitions(order) };
}

// Build a set AROUND anchor (kept) songs: order the anchors as the backbone, then
// insert each pool song at its smoothest slot — so pool songs naturally land as
// BRIDGES between kept songs whose transition is rough, smoothing the whole flow.
export function buildAround(anchors, pool) {
  let seq = anchors.length ? orderSet(anchors).order : [];
  for (const t of pool) {
    const spots = bestInsertions(seq, t);
    seq.splice(spots.length ? spots[0].pos : seq.length, 0, t);
  }
  return { order: seq, transitions: buildTransitions(seq) };
}

// Order a pool of tracks starting from `anchor`, always picking the next track
// with the smoothest transition (BPM + key) from the last placed one. Used by
// "Improve" to reshuffle only the not-yet-played songs into the best flow.
export function orderFrom(anchor, pool) {
  const remaining = pool.slice();
  const out = [];
  let last = anchor || remaining.shift();
  if (!anchor && last) out.push(last);
  while (remaining.length) {
    let bi = 0, bs = -Infinity;
    remaining.forEach((c, i) => {
      const s = transitionScore(last, c);
      if (s > bs) { bs = s; bi = i; }
    });
    last = remaining.splice(bi, 1)[0];
    out.push(last);
  }
  return out;
}

// Rank every insertion slot for `track` within `others` by how smooth it is.
// Returns [{ pos, score, flag }] sorted best-first. pos is the index in `others`
// where the track would be inserted (0 = very start, others.length = very end).
export function bestInsertions(others, track) {
  const res = [];
  for (let p = 0; p <= others.length; p++) {
    const prev = others[p - 1];
    const next = others[p];
    let s;
    if (prev && next) s = (transitionScore(prev, track) + transitionScore(track, next)) / 2;
    else if (prev) s = transitionScore(prev, track);
    else if (next) s = transitionScore(track, next);
    else s = 1;
    res.push({ pos: p, score: Math.round(s * 100) / 100, flag: s >= 0.8 ? "smooth" : s >= 0.55 ? "ok" : "risky" });
  }
  return res.sort((a, b) => b.score - a.score);
}

// Per-junction flags for a FIXED order (used by manual drag/remove — does not reorder).
export function buildTransitions(order) {
  const transitions = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const s = transitionScore(a, b);
    // If we lack the data to judge a junction, call it "unknown" — not "risky".
    const known = (a.bpm || a.camelot) && (b.bpm || b.camelot);
    transitions.push({
      from: a.name,
      to: b.name,
      score: Math.round(s * 100) / 100,
      bpmDelta: a.bpm && b.bpm ? Math.round((b.bpm - a.bpm) * 10) / 10 : null,
      keyMove: `${a.camelot || "?"} -> ${b.camelot || "?"}`,
      flag: !known ? "unknown" : s >= 0.8 ? "smooth" : s >= 0.55 ? "ok" : "risky",
      crossfadeSec: s >= 0.8 ? 8 : s >= 0.55 ? 5 : 3,
    });
  }
  return transitions;
}
