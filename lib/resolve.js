// Turns whatever the user pastes into a list of tracks.
// Handles three input shapes:
//   1) Exportify CSV  -> uses the Track URI + names directly (no search, exact)
//   2) "Song - Artist" lines -> resolved via /search
//   3) A playlist URL -> can't expand (Spotify blocks it); returns a hint
//
// Each output item: { uri|null, title, artist }  (uri null => needs search)

function isPlaylistUrl(s) {
  return /open\.spotify\.com\/playlist\/|spotify:playlist:/.test(s);
}

export function playlistIdFrom(s) {
  const m = /playlist[/:]([A-Za-z0-9]+)/.exec(s);
  return m ? m[1] : null;
}

// Read a playlist's tracks from Spotify's PUBLIC embed page (no API, no auth) —
// this sidesteps the dev-mode 403 on /playlists/{id}/tracks. Returns
// [{ uri, title, artist }]. Throws if the page shape changes.
export async function fetchPlaylistTracks(playlistId) {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`embed fetch failed: ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error("could not find playlist data on embed page");
  const data = JSON.parse(m[1]);
  // Find the first trackList array anywhere in the tree.
  let list = null;
  const walk = (o) => {
    if (list || !o || typeof o !== "object") return;
    if (Array.isArray(o.trackList)) { list = o.trackList; return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(data);
  if (!list) throw new Error("no trackList in playlist data");
  return list.map((t) => ({
    uri: t.uri,
    title: t.title,
    artist: (t.subtitle || "").replace(/ /g, " ").trim(),
    duration_ms: t.duration || null,
  }));
}

// Pull a track id from a URI or open.spotify.com/track link.
function trackUriFrom(s) {
  let m = /spotify:track:([A-Za-z0-9]+)/.exec(s);
  if (m) return `spotify:track:${m[1]}`;
  m = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(s);
  if (m) return `spotify:track:${m[1]}`;
  return null;
}

// Minimal CSV row splitter that respects quoted fields.
function csvRow(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === "," && !q) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// Parse one plain line into { title, artist }.
export function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  let parts;
  if (s.includes("\t")) parts = s.split("\t");
  else if (/\s[-–—]\s/.test(s)) parts = s.split(/\s[-–—]\s/);
  else if (/\sby\s/i.test(s)) parts = s.split(/\sby\s/i);
  else return { title: s, artist: "" };
  return { title: (parts[0] || "").trim(), artist: (parts[1] || "").trim() };
}

// Main entry: returns { items, hint }.
export function parseInput(text) {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!rawLines.length) return { items: [], hint: null };

  // Pasted a playlist URL (and nothing else useful)?
  if (rawLines.every((l) => isPlaylistUrl(l))) {
    return {
      items: [],
      hint:
        "That's a playlist link — Spotify blocks new apps from reading a playlist's tracks. " +
        "Open exportify.net, export this playlist, and paste the CSV (or the song list) here.",
    };
  }

  // Exportify CSV? Header row contains "Track URI" and "Track Name".
  const header = rawLines[0].toLowerCase();
  const isCsv = header.includes("track uri") && header.includes("track name");
  if (isCsv) {
    const cols = csvRow(rawLines[0]).map((c) => c.trim().toLowerCase());
    const uriIdx = cols.indexOf("track uri");
    const nameIdx = cols.indexOf("track name");
    const artistIdx = cols.findIndex((c) => c.startsWith("artist name"));
    const items = [];
    for (let i = 1; i < rawLines.length; i++) {
      const f = csvRow(rawLines[i]);
      const uri = trackUriFrom(f[uriIdx] || "");
      const title = (f[nameIdx] || "").trim();
      const artist = (f[artistIdx] || "").trim();
      if (title || uri) items.push({ uri, title, artist });
    }
    return { items, hint: null };
  }

  // Otherwise: plain lines. A line may itself be a track URI/link.
  const items = rawLines
    .filter((l) => !isPlaylistUrl(l))
    .map((l) => {
      const uri = trackUriFrom(l);
      if (uri) return { uri, title: "", artist: "" };
      return { uri: null, ...parseLine(l) };
    })
    .filter(Boolean);
  return { items, hint: null };
}

// Search Spotify for a "Song - Artist". Returns { uri, id, name, artist } or null.
export async function resolveTrack({ title, artist }, accessToken) {
  const q = artist ? `track:${title} artist:${artist}` : title;
  const url = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const data = await r.json();
  const hit = data.tracks?.items?.[0];
  if (!hit) return null;
  return {
    uri: hit.uri,
    id: hit.id,
    name: hit.name,
    artist: (hit.artists || []).map((a) => a.name).join(", "),
    duration_ms: hit.duration_ms || null,
  };
}
