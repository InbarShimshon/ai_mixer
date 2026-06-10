# 🎧 Spotify AI Mixer

Connect Spotify, play a playlist, and let an AI **harmonic-mixing** engine reorder the
tracks so they flow — compatible keys (Camelot wheel), smooth BPM ramp, and an
energy build → peak → cooldown arc. Spotify's native crossfade handles the overlap.

> Tempo and key data powered by [GetSongBPM](https://getsongbpm.com).

## What it can and can't do
- ✅ Connect + play full tracks (Spotify **Premium** required by the Web Playback SDK)
- ✅ AI-ordered set with per-transition "smooth / ok / risky" flags + suggested crossfade length
- ✅ BPM + musical key from a 3rd-party API (GetSongBPM)
- ⚠️ "Flow over" = Spotify's **native crossfade** (one overlapping stream, up to 12s).
  True two-deck beatmatching is **not possible on Spotify streams** — it needs local
  audio files + a DJ engine (Mixxx). That's the future upgrade path.

## Setup
1. `npm install`
2. Create a Spotify app at https://developer.spotify.com/dashboard
   - Redirect URI: `http://127.0.0.1:8888/callback`
3. Get a free GetSongBPM API key: https://getsongbpm.com/api
4. `cp .env.example .env` and fill in the three values.
5. In your Spotify desktop/mobile client: **Settings → Crossfade songs → ~8–12s**.
6. `npm start` → open http://127.0.0.1:8888
7. Connect Spotify → Build AI set → Play set.

## How the ordering works (`lib/harmonic.js`)
- `keyScore` — Camelot compatibility: same key (1.0), relative maj/min (0.9),
  ±1 on wheel (0.85), clash (0.15).
- `bpmScore` — full score within 3 BPM, decaying after.
- `orderSet` — greedy nearest-neighbour walk that also tracks an energy arc.

Tune the weights in `transitionScore` and the arc shape in `orderSet`.

## Upgrade path to true beatmatching
Swap the playback layer for local files analyzed with `librosa`/`essentia` and mixed
through Mixxx (scriptable) or a Web Audio two-deck engine. The `harmonic.js` brain
stays exactly the same — only the audio source/transport changes.
