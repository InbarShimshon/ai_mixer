import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { analyzeAll } from "./lib/analysis.js";
import { orderSet, buildTransitions } from "./lib/harmonic.js";
import { parseInput, resolveTrack, playlistIdFrom, fetchPlaylistTracks } from "./lib/resolve.js";
import { suggestTracks } from "./lib/suggest.js";
import { fillMissing } from "./lib/estimate.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

app.use(express.static("public"));
app.use(express.json());

const TOKEN_FILE = ".tokens.json";
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };
try {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
} catch {}
const saveTokens = () => {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch {}
};

app.get("/login", (req, res) => {
  const p = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${p}`);
});

app.get("/callback", async (req, res) => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: req.query.code,
    redirect_uri: REDIRECT_URI,
  });
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens();
  res.redirect("/");
});

async function ensureToken() {
  if (tokens.access_token && Date.now() < tokens.expires_at - 30000) return;
  if (!tokens.refresh_token) return;
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  const data = await r.json();
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) tokens.refresh_token = data.refresh_token;
  saveTokens();
}

const spotify = (path, opts = {}) =>
  fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

app.get("/api/auth", async (req, res) => {
  await ensureToken();
  res.json({ loggedIn: !!tokens.access_token });
});

// List available playback devices (desktop app, web player, etc.).
app.get("/api/devices", async (req, res) => {
  await ensureToken();
  if (!tokens.access_token) return res.status(401).json({ error: "not logged in" });
  const r = await spotify("/me/player/devices");
  res.json(await r.json());
});

// Build the AI-ordered set from a pasted track list.
// Body: { lines: "Song - Artist\nSong - Artist\n..." }
app.post("/api/order", async (req, res) => {
  try {
    await ensureToken();
    if (!tokens.access_token) return res.status(401).json({ error: "not logged in" });

    const text = req.body.lines || "";
    let items, hint = null;
    const pid = /playlist/.test(text) ? playlistIdFrom(text) : null;
    if (pid) {
      // Read the playlist straight from Spotify's public embed page (no API 403).
      try {
        items = await fetchPlaylistTracks(pid);
      } catch (e) {
        return res.status(502).json({ error: "Couldn't read that playlist: " + e.message });
      }
    } else {
      ({ items, hint } = parseInput(text));
    }
    if (!items.length) return res.status(400).json({ error: hint || "no tracks provided" });

    // Items from Exportify CSV already carry a URI -> use directly.
    // Items without a URI -> resolve via /search.
    const resolved = [];
    for (let i = 0; i < items.length; i += 4) {
      const batch = items.slice(i, i + 4);
      const hits = await Promise.all(
        batch.map((p) =>
          p.uri ? { uri: p.uri, name: p.title || p.uri, artist: p.artist || "" } : resolveTrack(p, tokens.access_token)
        )
      );
      batch.forEach((p, j) => {
        if (hits[j] && hits[j].uri) resolved.push(hits[j]);
        else resolved.push({ uri: null, name: p.title, artist: p.artist, unresolved: true });
      });
    }

    const playable = resolved.filter((t) => t.uri);
    // Analyze (BPM/key), AI-fill anything GetSongBPM missed, then order harmonically.
    const analyzed = await analyzeAll(playable, process.env);
    await fillMissing(analyzed);
    const { order, transitions } = orderSet(analyzed);
    res.json({
      count: order.length,
      unresolved: resolved.filter((t) => t.unresolved).map((t) => `${t.name} ${t.artist}`),
      order,
      transitions,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Start playback of the ordered set on a chosen device.
// Body: { uris: [...], device_id }
app.put("/api/play", async (req, res) => {
  await ensureToken();
  if (!tokens.access_token) return res.status(401).json({ error: "not logged in" });
  const { uris, device_id } = req.body;
  const r = await spotify(`/me/player/play${device_id ? `?device_id=${device_id}` : ""}`, {
    method: "PUT",
    body: JSON.stringify({ uris }),
  });
  res.status(r.status).json(r.status === 204 ? { ok: true } : await r.json().catch(() => ({})));
});

// AI suggestions: propose songs that fit the current set + event vibe,
// then resolve each to a Spotify URI and analyze BPM/key so they're playable.
// Body: { tracks: [{name,artist,bpm,camelot}], context }
app.post("/api/suggest", async (req, res) => {
  try {
    await ensureToken();
    if (!tokens.access_token) return res.status(401).json({ error: "not logged in" });
    const { tracks = [], context = "wedding party" } = req.body;
    const { suggestions, error } = await suggestTracks(tracks, { context });
    if (error === "no_key")
      return res.status(400).json({ error: "Set ANTHROPIC_API_KEY in .env to enable suggestions." });

    // Resolve + analyze each suggestion so it can be added and played.
    const resolved = [];
    for (let i = 0; i < suggestions.length; i += 4) {
      const batch = suggestions.slice(i, i + 4);
      const hits = await Promise.all(batch.map((s) => resolveTrack(s, tokens.access_token)));
      batch.forEach((s, j) => {
        if (hits[j]?.uri) resolved.push({ ...hits[j], reason: s.reason });
      });
    }
    const analyzed = await analyzeAll(resolved, process.env);
    await fillMissing(analyzed);
    res.json({ suggestions: analyzed.map((t, i) => ({ ...t, reason: resolved[i].reason })) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Transport controls. All target the active device (or device_id if given).
const dq = (id) => (id ? `?device_id=${id}` : "");
app.put("/api/pause", async (req, res) => {
  await ensureToken();
  const r = await spotify(`/me/player/pause${dq(req.body.device_id)}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.put("/api/resume", async (req, res) => {
  await ensureToken();
  const r = await spotify(`/me/player/play${dq(req.body.device_id)}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.post("/api/next", async (req, res) => {
  await ensureToken();
  const r = await spotify(`/me/player/next${dq(req.body.device_id)}`, { method: "POST" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.post("/api/previous", async (req, res) => {
  await ensureToken();
  const r = await spotify(`/me/player/previous${dq(req.body.device_id)}`, { method: "POST" });
  res.status(r.status).json({ ok: r.status === 204 });
});

// Set playback volume (used by the auto-mix fade engine).
app.put("/api/volume", async (req, res) => {
  await ensureToken();
  const v = Math.max(0, Math.min(100, Math.round(req.body.volume_percent)));
  const r = await spotify(`/me/player/volume?volume_percent=${v}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});

// Re-order an existing set (tracks already carry bpm/camelot) — used by Smart Add.
app.post("/api/reorder", async (req, res) => {
  const tracks = req.body.tracks || [];
  const { order, transitions } = orderSet(tracks);
  res.json({ count: order.length, order, transitions });
});

// Recompute junction flags for a FIXED order (manual drag / remove — no reordering).
app.post("/api/transitions", (req, res) => {
  const order = req.body.tracks || [];
  res.json({ count: order.length, order, transitions: buildTransitions(order) });
});

// Seek to a position within the current track.
app.put("/api/seek", async (req, res) => {
  await ensureToken();
  const { position_ms } = req.body;
  const r = await spotify(`/me/player/seek?position_ms=${Math.max(0, Math.round(position_ms))}`, {
    method: "PUT",
  });
  res.status(r.status).json({ ok: r.status === 204 });
});

// Current track + position (for now-playing highlight and the scrubber).
app.get("/api/now", async (req, res) => {
  await ensureToken();
  const r = await spotify("/me/player");
  if (r.status === 204) return res.json({ playing: false });
  const d = await r.json().catch(() => ({}));
  res.json({
    playing: d.is_playing,
    name: d.item?.name,
    uri: d.item?.uri,
    progress_ms: d.progress_ms ?? 0,
    duration_ms: d.item?.duration_ms ?? 0,
    device: d.device?.name,
    deviceType: d.device?.type,
  });
});

app.listen(PORT, () => console.log(`\n  ▶  Spotify AI Mixer:  http://127.0.0.1:${PORT}\n`));
