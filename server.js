import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import { analyzeAll } from "./lib/analysis.js";
import { orderSet, buildTransitions, bestInsertions, orderFrom } from "./lib/harmonic.js";
import { parseInput, resolveTrack, playlistIdFrom, fetchPlaylistTracks } from "./lib/resolve.js";
import { suggestTracks } from "./lib/suggest.js";
import { fillMissing } from "./lib/estimate.js";
import { loadUsers, saveUsers } from "./lib/store.js";

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
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-top-read",
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

// --- Per-user sessions (cookie sid -> { tokens, sets }), durable via lib/store ---
// Load asynchronously so a slow/cold DB can NEVER block the server from starting
// (a blocked startup makes Render's deploy hang forever). The server binds the
// port immediately; users hydrate a moment later.
const users = {};
loadUsers()
  .then((u) => Object.assign(users, u))
  .catch((e) => console.error("loadUsers failed (continuing with empty):", e.message));
const persist = () => saveUsers(users);

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

// --- Optional shared-password gate (set APP_PASSWORD to enable) ---
const GATE_HTML = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>AI Mixer</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#0e1119,#0b0d13);color:#eef1f7;font-family:system-ui,sans-serif}
.box{width:320px;max-width:88vw;background:#141823;border:1px solid #262c3b;border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center}
.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(140deg,#7c8bff,#4b58d6);display:grid;place-items:center;margin:0 auto 14px;font-size:19px}
h1{font-size:17px;margin:0 0 4px}p{color:#939db3;font-size:13px;margin:0 0 18px}
input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid #262c3b;background:#0e1119;color:#eef1f7;font-size:14px;margin-bottom:10px;box-sizing:border-box}
button{width:100%;padding:11px;border:0;border-radius:10px;background:linear-gradient(180deg,#7986ff,#5a67e6);color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.err{color:#f4636b;font-size:12px;height:16px;margin-top:8px}</style></head>
<body><form class=box onsubmit="return go(event)"><div class=logo>◧</div><h1>AI Mixer</h1><p>Enter the access password to continue.</p>
<input id=pw type=password placeholder="Password" autofocus><button type=submit>Unlock</button><div class=err id=err></div></form>
<script>async function go(e){e.preventDefault();const r=await fetch('/gate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});if(r.ok){location.href='/'}else{document.getElementById('err').textContent='Wrong password'}return false}</script>
</body></html>`;

app.post("/gate", (req, res) => {
  if (!process.env.APP_PASSWORD) return res.json({ ok: true });
  if (req.body.password === process.env.APP_PASSWORD) {
    req.user.gate = true;
    persist();
    return res.json({ ok: true });
  }
  res.status(403).json({ error: "wrong password" });
});

app.use((req, res, next) => {
  if (!process.env.APP_PASSWORD || req.user.gate || req.path === "/gate") return next();
  // Guests reach a shared set via QR without the host password.
  if (req.path.startsWith("/join") || req.path.startsWith("/api/share")) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "locked" });
  res.set("Content-Type", "text/html").send(GATE_HTML);
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
    show_dialog: "true", // force re-consent so scope changes always take effect
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

// Disconnect Spotify: clear this session's tokens.
app.post("/api/logout", (req, res) => {
  req.user.tokens = { access_token: null, refresh_token: null, expires_at: 0 };
  persist();
  res.json({ ok: true });
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
    // Merge EVERY playlist URL found (one per line) plus any plain song lines.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const playlistLines = lines.filter((l) => /playlist/.test(l) && playlistIdFrom(l));
    const songText = lines.filter((l) => !(/playlist/.test(l) && playlistIdFrom(l))).join("\n");

    let items = [];
    let hint = null;
    const failed = [];
    for (const line of playlistLines) {
      try { items.push(...(await fetchPlaylistTracks(playlistIdFrom(line)))); }
      catch { failed.push(line); }
    }
    if (songText.trim()) {
      const parsed = parseInput(songText);
      items.push(...parsed.items);
      hint = parsed.hint;
    }
    // Dedupe across merged playlists (by uri, else title+artist).
    const seen = new Set();
    items = items.filter((t) => {
      const k = (t.uri || `${t.title}|${t.artist}`).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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
  const { uris, device_id, offsetUri, position_ms } = req.body;
  if (!Array.isArray(uris) || uris.length > 200) return res.status(400).json({ error: "bad uris" });
  const body = { uris };
  if (offsetUri) body.offset = { uri: offsetUri }; // start at this track…
  if (typeof position_ms === "number") body.position_ms = Math.max(0, Math.round(position_ms)); // …at this point
  const r = await spotify(user, `/me/player/play${device_id ? `?device_id=${encodeURIComponent(device_id)}` : ""}`, {
    method: "PUT",
    body: JSON.stringify(body),
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

// "Improve": keep everything up to & including the current song, then reshuffle
// the not-yet-played songs into the smoothest BPM/key flow from the current one.
app.post("/api/improve", (req, res) => {
  const tracks = req.body.tracks || [];
  let i = Number.isInteger(req.body.fromIndex) ? req.body.fromIndex : 0;
  i = Math.max(0, Math.min(i, tracks.length - 1));
  const keep = tracks.slice(0, i + 1);
  const anchor = tracks[i];
  const pool = tracks.slice(i + 1);
  const order = [...keep, ...(anchor ? orderFrom(anchor, pool) : pool)];
  res.json({ count: order.length, order, transitions: buildTransitions(order) });
});

// General catalog search — find any track to add.
app.get("/api/search", rateLimit(60, 60000), async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const q = (req.query.q || "").slice(0, 200).trim();
  if (!q) return res.json({ results: [] });
  const r = await spotify(user, `/search?type=track&limit=8&q=${encodeURIComponent(q)}`);
  const d = await r.json();
  const results = (d.tracks?.items || []).map((t) => ({
    uri: t.uri,
    id: t.id,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(", "),
    album: t.album?.name,
  }));
  res.json({ results });
});

// Add one track to a set: analyze it (BPM/key, AI-fill) then place it harmonically.
app.post("/api/addtrack", rateLimit(40, 60000), async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const { tracks = [], add } = req.body;
  if (!add?.uri) return res.status(400).json({ error: "no track" });
  const analyzed = await analyzeAll([{ uri: add.uri, name: add.name, artist: add.artist }], process.env);
  await fillMissing(analyzed);
  const { order, transitions } = orderSet([...tracks, analyzed[0]]);
  res.json({ count: order.length, order, transitions });
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

// Build a party set from the host's TASTE (liked + top tracks + chosen playlists),
// then season with AI crowd-pleasers per the "adventurous" dial, and order it.
app.post("/api/taste-set", rateLimit(8, 60000), async (req, res) => {
  try {
    const user = await authed(req, res);
    if (!user) return;
    const adventurous = Math.max(0, Math.min(100, Number(req.body.adventurous) || 30));
    const context = (req.body.context || "wedding party").slice(0, 80);
    const extra = Array.isArray(req.body.extraPlaylists) ? req.body.extraPlaylists.slice(0, 5) : [];
    // "Must-keep" songs (already analyzed in the current set) are seeded first and
    // never dropped, then we build the rest around them per the dial.
    const keep = Array.isArray(req.body.keep) ? req.body.keep.filter((t) => t?.uri).slice(0, 60) : [];

    const pool = [];
    keep.forEach((t) => pool.push({ uri: t.uri, name: t.name, artist: t.artist || "", bpm: t.bpm, camelot: t.camelot, energy: t.energy, duration_ms: t.duration_ms, keep: true }));
    const push = (t) => {
      if (t?.uri) pool.push({ uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), duration_ms: t.duration_ms });
    };
    // Top tracks = strongest taste signal
    let r = await spotify(user, "/me/top/tracks?limit=50&time_range=medium_term");
    let d = await r.json();
    if (d.error?.status === 403) return res.status(403).json({ error: "reconnect" });
    (d.items || []).forEach(push);
    // Liked / saved songs
    r = await spotify(user, "/me/tracks?limit=50");
    d = await r.json();
    (d.items || []).forEach((it) => push(it.track));
    // Any playlists the host pasted/picked
    for (const url of extra) {
      const pid = playlistIdFrom(url);
      if (pid) { try { (await fetchPlaylistTracks(pid)).forEach((t) => pool.push(t)); } catch {} }
    }

    const seen = new Set();
    let tracks = pool.filter((t) => t.uri && !seen.has(t.uri) && seen.add(t.uri));
    if (!tracks.length) return res.status(400).json({ error: "No taste found — like some songs / play more on Spotify first." });
    tracks = tracks.slice(0, 80);

    // Preserve analysis on tracks that already carry it (kept songs); analyze the rest.
    const known = tracks.filter((t) => t.bpm || t.camelot);
    const fresh = tracks.filter((t) => !(t.bpm || t.camelot));
    let analyzedFresh = await analyzeAll(fresh, process.env);
    await fillMissing(analyzedFresh);
    let analyzed = [...known, ...analyzedFresh];

    // Season with crowd-pleasers per the dial (0 = pure taste, 100 = max additions).
    let addedCount = 0;
    if (adventurous > 0) {
      const count = Math.max(1, Math.round((adventurous / 100) * 12));
      const { suggestions } = await suggestTracks(analyzed, {
        context: `${context}. Add crowd-pleasers that fit this host's taste and lift the party.`,
        count,
      });
      const adds = [];
      for (let i = 0; i < (suggestions || []).length; i += 4) {
        const batch = suggestions.slice(i, i + 4);
        const hits = await Promise.all(batch.map((s) => resolveTrack(s, user.tokens.access_token)));
        hits.forEach((h) => { if (h?.uri && !seen.has(h.uri)) { seen.add(h.uri); adds.push(h); } });
      }
      let addAnalyzed = await analyzeAll(adds, process.env);
      await fillMissing(addAnalyzed);
      addedCount = addAnalyzed.length;
      analyzed = analyzed.concat(addAnalyzed);
    }

    const { order, transitions } = orderSet(analyzed);
    res.json({ count: order.length, addedCount, order, transitions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Shareable sets + guest "add a song" (QR jukebox) ---
const shareStore = () => (users.__shares ||= {});

app.post("/api/share", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const order = req.body.order || [];
  if (!order.length) return res.status(400).json({ error: "empty set" });
  const id = crypto.randomBytes(5).toString("hex");
  shareStore()[id] = { sid: req.sid, name: (req.body.name || "Party set").slice(0, 80), order, createdAt: Date.now() };
  persist();
  res.json({ id });
});

app.get("/api/share/:id", (req, res) => {
  const s = shareStore()[req.params.id];
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ name: s.name, order: s.order });
});

// Guest search uses the HOST's token (guests don't need their own Spotify).
app.get("/api/share/:id/search", async (req, res) => {
  const s = shareStore()[req.params.id];
  if (!s) return res.status(404).json({ error: "not found" });
  const host = users[s.sid];
  if (!host?.tokens?.access_token) return res.status(400).json({ error: "host offline" });
  await ensureToken(host);
  const q = (req.query.q || "").slice(0, 200).trim();
  if (!q) return res.json({ results: [] });
  const r = await spotify(host, `/search?type=track&limit=6&q=${encodeURIComponent(q)}`);
  const d = await r.json();
  res.json({ results: (d.tracks?.items || []).map((t) => ({ uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(", ") })) });
});

// Guest adds a song — analyzed and SMART-INSERTED at its best harmonic spot so it
// doesn't ruin the flow.
app.post("/api/share/:id/add", rateLimit(40, 60000), async (req, res) => {
  const s = shareStore()[req.params.id];
  if (!s) return res.status(404).json({ error: "not found" });
  const host = users[s.sid];
  if (!host?.tokens?.access_token) return res.status(400).json({ error: "host offline" });
  await ensureToken(host);
  const { uri, name, artist } = req.body;
  if (!uri) return res.status(400).json({ error: "no track" });
  if (s.order.some((t) => t.uri === uri)) return res.json({ ok: true, already: true });
  const [a] = await analyzeAll([{ uri, name, artist }], process.env);
  await fillMissing([a]);
  const spots = bestInsertions(s.order, a);
  const pos = spots[0]?.pos ?? s.order.length;
  s.order.splice(pos, 0, { ...a, guest: true });
  persist();
  res.json({ ok: true, name: a.name });
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
// Add a track to Spotify's up-next queue (no interruption) — used by auto-extend.
app.post("/api/queue", async (req, res) => {
  const user = await authed(req, res);
  if (!user) return;
  const { uri } = req.body;
  if (!uri) return res.status(400).json({ error: "no uri" });
  const r = await spotify(user, `/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: "POST" });
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

// Guest jukebox page (reached via QR) — id read from the path by join.html.
app.get("/join/:id", (req, res) => res.sendFile("join.html", { root: "public" }));

app.listen(PORT, () => console.log(`\n  ▶  AI Mixer:  ${REDIRECT_URI.replace("/callback", "") || "http://127.0.0.1:" + PORT}\n`));
