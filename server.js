import express from "express";
import dotenv from "dotenv";
import { analyzeAll } from "./lib/analysis.js";
import { orderSet } from "./lib/harmonic.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
  "playlist-read-private",
].join(" ");

app.use(express.static("public"));
app.use(express.json());

// In-memory token store (single-user local app). Fine for localhost.
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };

// 1) Kick off Spotify OAuth.
app.get("/login", (req, res) => {
  const p = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${p}`);
});

// 2) Exchange the code for tokens.
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await r.json();
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
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
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await r.json();
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;
}

// The browser player needs the current access token.
app.get("/token", async (req, res) => {
  await ensureToken();
  res.json({ access_token: tokens.access_token });
});

// 3) Build the AI-ordered set from a playlist id.
app.get("/api/order/:playlistId", async (req, res) => {
  try {
    await ensureToken();
    if (!tokens.access_token) return res.status(401).json({ error: "not logged in" });

    // Fetch playlist tracks (handles pagination).
    let url = `https://api.spotify.com/v1/playlists/${req.params.playlistId}/tracks?limit=100`;
    const items = [];
    while (url) {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const page = await r.json();
      if (page.error) return res.status(400).json(page.error);
      for (const it of page.items) {
        const t = it.track;
        if (!t) continue;
        items.push({
          id: t.id,
          uri: t.uri,
          name: t.name,
          artist: (t.artists || []).map((a) => a.name).join(", "),
        });
      }
      url = page.next;
    }

    // Analyze (BPM/key) then order harmonically.
    const analyzed = await analyzeAll(items, process.env);
    const { order, transitions } = orderSet(analyzed);
    res.json({ count: order.length, order, transitions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () =>
  console.log(`\n  ▶  Spotify AI Mixer running:  http://127.0.0.1:${PORT}\n`)
);
