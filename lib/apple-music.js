// ─────────────────────────────────────────────────────────────────────────
// Apple Music provider — STUB / NOT YET ACTIVE
// ─────────────────────────────────────────────────────────────────────────
// Documented for whenever an Apple Developer Program membership ($99/yr) is in
// place. The harmonic brain (lib/harmonic.js), analysis (lib/analysis.js +
// lib/estimate.js), and AI suggestions (lib/suggest.js) are provider-agnostic —
// only "where tracks come from" and "how they play" are Apple-specific.
//
// WHAT YOU NEED (one-time, from https://developer.apple.com):
//   1. Apple Developer Program membership ($99/yr).
//   2. Create a "Media Identifier" + a MusicKit private key → download the .p8.
//      You end up with: TEAM_ID, KEY_ID, and the private key (.p8 contents).
//   3. Set env vars: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (the .p8 text).
//
// DEVELOPER TOKEN (server-side JWT, ES256, signed with the .p8, ≤180 days):
//   import jwt from "jsonwebtoken"; // add dependency when activating
//   export function developerToken() {
//     return jwt.sign({}, process.env.APPLE_PRIVATE_KEY, {
//       algorithm: "ES256",
//       expiresIn: "180d",
//       issuer: process.env.APPLE_TEAM_ID,
//       header: { alg: "ES256", kid: process.env.APPLE_KEY_ID },
//     });
//   }
//
// USER AUTH + PLAYBACK (browser, via MusicKit JS — add to public/index.html):
//   <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components></script>
//   await MusicKit.configure({ developerToken, app: { name: "AI Mixer", build: "1" } });
//   const music = MusicKit.getInstance();
//   await music.authorize();                       // prompts Apple Music login → Music-User-Token
//   await music.setQueue({ songs: [appleTrackId, ...] });
//   await music.play();                            // full playback IN-BROWSER for subscribers
//   // music.player.seekToTime(s), .pause(), .play(), .skipToNextItem(), volume = 0..1
//
// READING DATA (Apple Music API — needs Authorization: Bearer <developerToken>
// and Music-User-Token: <userToken> for library calls):
//   GET https://api.music.apple.com/v1/me/library/playlists           (user's playlists — WORKS, unlike Spotify dev-mode)
//   GET https://api.music.apple.com/v1/me/library/playlists/{id}/tracks
//   GET https://api.music.apple.com/v1/catalog/{storefront}/search?types=songs&term=...
//   Each song has id + attributes (name, artistName, durationInMillis). No BPM/key —
//   so we still enrich via GetSongBPM (lib/analysis.js) + AI fill (lib/estimate.js).
//
// FREE FALLBACK (no Apple Developer account, NO full playback): the iTunes Search
// API — https://itunes.apple.com/search?term=...&entity=song — returns catalog
// metadata + 30-second preview URLs only. Not usable for a real DJ set.
//
// ── Activation checklist ────────────────────────────────────────────────────
//   [ ] Join Apple Developer Program, create MusicKit key, set the 3 env vars
//   [ ] npm i jsonwebtoken ; implement developerToken() above
//   [ ] Add GET /api/apple/token (returns developerToken) to server.js
//   [ ] Add MusicKit JS + a "Connect Apple Music" button to the frontend
//   [ ] Implement fetchPlaylistTracks()/search() below against the Apple Music API
//   [ ] Route playback to MusicKit JS instead of the Spotify Connect endpoints
// ─────────────────────────────────────────────────────────────────────────

export const APPLE_MUSIC_ENABLED = false;

export async function fetchPlaylistTracks(/* playlistId, userToken */) {
  throw new Error("Apple Music not configured — see lib/apple-music.js setup notes.");
}

export async function search(/* query, userToken */) {
  throw new Error("Apple Music not configured — see lib/apple-music.js setup notes.");
}
