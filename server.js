import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import { analyzeAll } from "./lib/analysis.js";
import { orderSet, buildTransitions, bestInsertions } from "./lib/harmonic.js";
import { parseInput, resolveTrack, playlistIdFrom, fetchPlaylistTracks } from "./lib/resolve.js";
import { suggestTracks } from "./lib/suggest.js";
import { fillMissing } from "./lib/estimate.js";

dotenv.config();
const app = express();
app.set("trust proxy", 1); // behind Render's TLS proxy
app.disable("x-powered-by");
const PORT = process.env.PORT || 8888;
// On Render/any host, set REDIRECT_URI to "https://<your-app>/callback".
const REDIRECT_URI = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const SECURE = REDIRECT_URI.startsWith("https");
const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

// Security headers on every response.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (SECURE) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});

app.use(express.json({ limit: "256kb" }));

// Simple per-session rate limiter for cost-incurring endpoints.
const rl = {};
const rateLimit = (max, windowMs) => (req, res, next) => {
  const now = Date.now();
  rl[req.sid] = (rl[req.sid] || []).filter((t) => now - t < windowMs);
  if (rl[req.sid].length >= max) return res.status(429).json({ error: "Too many requests — slow down a moment." });
  rl[req.sid].push(now);
  next();
};

// --- Per-user sessions (cookie sid -> { tokens, sets }), persisted to disk ---
const USERS_FILE = ".users.json";
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch {}
const persist = () => { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); } catch {} };

app.use((req, res, next) => {
  const jar = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0])
  );
  let sid = jar.mix_sid;
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) {
    sid = crypto.randomBytes(32).toString("hex");
    res.setHeader(
      "Set-Cookie",
      `mix_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${SECURE ? "; Secure" : ""}`
    );
  }
  req.sid = sid;
  users[sid] ||= { tokens: { access_token: null, refresh_token: null, expires_at: 0 }, sets: {} };
  req.user = users[sid];
  next();
});

app.use(express.static("public"));

const basicAuth = Buffer.from(
  `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
).toString("base64");

// --- OAuth (per session) ---
app.get("/login", (req, res) => {
  const p = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: req.sid.slice(0, 16),
  });
  res.redirect(`https://accounts.spotify.com/authorize?${p}`);
});

app.get("/callback", async (req, res) => {
  // Verify OAuth state ties this callback to the same browser session (anti-CSRF).
  if (!req.query.code || req.query.state !== req.sid.slice(0, 16)) {
    return res.status(403).send("Login verification failed. Please try connecting again.");
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = await r.json();
  req.user.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  persist();
  res.redirect("/");
});

async function ensureToken(user) {
  const t = user.tokens;
  if (t.access_token && Date.now() < t.expires_at - 30000) return;
  if (!t.refresh_token) return;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const data = await r.json();
  if (data.access_token) {
    t.access_token = data.access_token;
    t.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    if (data.refresh_token) t.refresh_token = data.refresh_token;
    persist();
  }
}

const spotify = (user, path, opts = {}) =>
  fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${user.tokens.access_token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });

// Resolve the caller's token, or null if not logged in.
async function authed(req, res) {
  await ensureToken(req.user);
  if (!req.user.tokens.access_token) {
    res.status(401).json({ error: "not logged in" });
    return null;
  }
  return req.user;
}

app.get("/api/auth", async (req, res) => {
  await ensureToken(req.user);
  res.json({ loggedIn: !!req.user.tokens.access_token });
});

app.get("/api/devices", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const r = await spotify(user, "/me/player/devices");
  res.json(await r.json());
});

// List the user's playlists (listing is allowed; track contents come from the embed).
app.get("/api/playlists", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const items = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const r = await spotify(user, url);
    const p = await r.json();
    if (p.error) break;
    for (const pl of p.items || []) if (pl) items.push({ id: pl.id, name: pl.name, count: pl.tracks?.total ?? 0 });
    url = p.next ? p.next.replace("https://api.spotify.com/v1", "") : null;
  }
  res.json(items);
});

// Build the AI-ordered set from a pasted playlist URL or track list.
app.post("/api/order", rateLimit(20, 60000), async (req, res) => {
  try {
    const user = await authed(req, res);
    if (!user) return;
    const text = (req.body.lines || "").slice(0, 20000);
    let items, hint = null;
    const pid = /playlist/.test(text) ? playlistIdFrom(text) : null;
    if (pid) {
      try { items = await fetchPlaylistTracks(pid); }
      catch (e) { return res.status(502).json({ error: "Couldn't read that playlist: " + e.message }); }
    } else {
      ({ items, hint } = parseInput(text));
    }
    if (!items.length) return res.status(400).json({ error: hint || "no tracks provided" });
    if (items.length > 150) items = items.slice(0, 150); // bound cost/time

    const resolved = [];
    for (let i = 0; i < items.length; i += 4) {
      const batch = items.slice(i, i + 4);
      const hits = await Promise.all(
        batch.map((p) =>
          p.uri ? { uri: p.uri, name: p.title || p.uri, artist: p.artist || "" } : resolveTrack(p, user.tokens.access_token)
        )
      );
      batch.forEach((p, j) => {
        if (hits[j] && hits[j].uri) resolved.push(hits[j]);
        else resolved.push({ uri: null, name: p.title, artist: p.artist, unresolved: true });
      });
    }

    const playable = resolved.filter((t) => t.uri);
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

app.put("/api/play", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const { uris, device_id } = req.body;
  if (!Array.isArray(uris) || uris.length > 200) return res.status(400).json({ error: "bad uris" });
  const r = await spotify(user, `/me/player/play${device_id ? `?device_id=${encodeURIComponent(device_id)}` : ""}`, {
    method: "PUT",
    body: JSON.stringify({ uris }),
  });
  res.status(r.status).json(r.status === 204 ? { ok: true } : await r.json().catch(() => ({})));
});

app.put("/api/volume", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const v = Math.max(0, Math.min(100, Math.round(req.body.volume_percent)));
  const r = await spotify(user, `/me/player/volume?volume_percent=${v}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});

app.post("/api/reorder", (req, res) => {
  const { order, transitions } = orderSet(req.body.tracks || []);
  res.json({ count: order.length, order, transitions });
});

app.post("/api/transitions", (req, res) => {
  const order = req.body.tracks || [];
  res.json({ count: order.length, order, transitions: buildTransitions(order) });
});

app.post("/api/bestspots", (req, res) => {
  const { tracks = [], index } = req.body;
  const track = tracks[index];
  if (!track) return res.status(400).json({ error: "bad index" });
  const others = tracks.filter((_, k) => k !== index);
  res.json({ spots: bestInsertions(others, track), others }); // all positions (client slices for chips)
});

// --- Saved sets (per user) ---
app.get("/api/sets", (req, res) => {
  res.json(Object.values(req.user.sets).map((s) => ({ name: s.name, count: s.order.length, savedAt: s.savedAt })));
});
app.post("/api/sets", (req, res) => {
  const { name, order } = req.body;
  if (!name || !Array.isArray(order)) return res.status(400).json({ error: "name + order required" });
  req.user.sets[name] = { name, order, savedAt: new Date().toISOString() };
  persist();
  res.json({ ok: true });
});
app.get("/api/sets/:name", (req, res) => {
  const s = req.user.sets[req.params.name];
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ count: s.order.length, order: s.order, transitions: buildTransitions(s.order) });
});
app.delete("/api/sets/:name", (req, res) => {
  delete req.user.sets[req.params.name];
  persist();
  res.json({ ok: true });
});

// AI suggestions.
app.post("/api/suggest", rateLimit(12, 60000), async (req, res) => {
  try {
    const user = await authed(req, res);
    if (!user) return;
    const { tracks = [], context = "wedding party" } = req.body;
    const { suggestions, error } = await suggestTracks(tracks, { context });
    if (error === "no_key")
      return res.status(400).json({ error: "Set ANTHROPIC_API_KEY on the server to enable suggestions." });

    const resolved = [];
    for (let i = 0; i < suggestions.length; i += 4) {
      const batch = suggestions.slice(i, i + 4);
      const hits = await Promise.all(batch.map((s) => resolveTrack(s, user.tokens.access_token)));
      batch.forEach((s, j) => { if (hits[j]?.uri) resolved.push({ ...hits[j], reason: s.reason }); });
    }
    const analyzed = await analyzeAll(resolved, process.env);
    await fillMissing(analyzed);
    res.json({ suggestions: analyzed.map((t, i) => ({ ...t, reason: resolved[i].reason })) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Transport controls (act on the user's active device) ---
const dq = (id) => (id ? `?device_id=${encodeURIComponent(id)}` : "");
app.put("/api/pause", async (req, res) => {
  const user = await authed(req, res); if (!user) return;
  const r = await spotify(user, `/me/player/pause${dq(req.body.device_id)}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.put("/api/resume", async (req, res) => {
  const user = await authed(req, res); if (!user) return;
  const r = await spotify(user, `/me/player/play${dq(req.body.device_id)}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.post("/api/next", async (req, res) => {
  const user = await authed(req, res); if (!user) return;
  const r = await spotify(user, `/me/player/next${dq(req.body.device_id)}`, { method: "POST" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.post("/api/previous", async (req, res) => {
  const user = await authed(req, res); if (!user) return;
  const r = await spotify(user, `/me/player/previous${dq(req.body.device_id)}`, { method: "POST" });
  res.status(r.status).json({ ok: r.status === 204 });
});
app.put("/api/seek", async (req, res) => {
  const user = await authed(req, res); if (!user) return;
  const r = await spotify(user, `/me/player/seek?position_ms=${Math.max(0, Math.round(req.body.position_ms))}`, { method: "PUT" });
  res.status(r.status).json({ ok: r.status === 204 });
});

app.get("/api/now", async (req, res) => {
  await ensureToken(req.user);
  if (!req.user.tokens.access_token) return res.json({ playing: false });
  const r = await spotify(req.user, "/me/player");
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

app.listen(PORT, () => console.log(`\n  ▶  AI Mixer:  ${REDIRECT_URI.replace("/callback", "") || "http://127.0.0.1:" + PORT}\n`));
