# Compliant Architecture for a Public / Commercial Version

The current app is fine as a **private, personal, password-gated tool**, but Spotify's
Developer Terms forbid DJ/mixing apps and the embed-scraping workaround. To go
public/commercial you must **drop Spotify as the audio engine** and use a source where
mixing is licensed. The good news: **the AI brain is provider-agnostic and carries over
unchanged** — only the *source* + *playback* layers change.

## What carries over (no rewrite)
- `lib/harmonic.js` — Camelot/BPM/energy ordering, best-spot, `orderFrom`
- `lib/suggest.js` — Claude AI suggestions
- `lib/estimate.js` — AI BPM/key fill (only needed when real analysis is missing)
- The ordering UI, transition planner, and live mix timeline
- Node/Express + Postgres (sessions, saved sets, accounts)

## What changes
| Layer | Today (Spotify) | Compliant version |
|---|---|---|
| Source | Spotify playlist (embed scrape) | **Local files the user owns** *or* **DJ-licensed streaming** |
| Analysis | GetSongBPM + AI estimate | **Real audio analysis** (true BPM, beat grid, key, waveform) |
| Playback | Spotify Connect (1 stream, no overlap) | **Web Audio two-deck engine** (true simultaneous crossfade) |
| Mixing | Spotify native crossfade only | **Real beatmatch, key-lock, EQ, crossfader** |

---

## Path A — Local files (recommended for indie; fully compliant, fully capable)

Legally equivalent to Mixxx / djay with local files: the user plays **music they own**,
your app is just the tool. Don't let users share/stream files to each other.

```
USER'S OWN FILES (mp3/flac/wav)
        │ upload / pick folder
        ▼
ANALYSIS  (real audio → real data)
  • BPM + beat grid (downbeats): aubio / essentia.js / web-audio-beat-detector
  • Key → Camelot: essentia / libKeyFinder (WASM)
  • Waveform peaks (for display) + energy/loudness
        │  feeds the SAME harmonic.js brain
        ▼
HARMONIC ORDERING + AI  (unchanged: ordering, suggestions, planner)
        │
        ▼
TWO-DECK WEB AUDIO ENGINE  (true mixing)
  Deck A ─►Gain─┐
                ├─► crossfader ─► 3-band EQ ─► master ─► 🔊
  Deck B ─►Gain─┘
  • both decks play AT ONCE → real overlapping crossfade
  • time-stretch (key-lock) to beatmatch BPM
  • beat-grid sync → auto-align downbeats
  • real waveforms w/ beat markers (your timeline, now with real audio)
```

**Stack**
- Web Audio API graph (raw, or **Tone.js**)
- **wavesurfer.js** — real waveform display + beat markers
- **soundtouch-js** or **Rubber Band (WASM)** — tempo change without pitch (key-lock beatmatch)
- **essentia.js** (WASM) in-browser, or a Python (`librosa`/`essentia`/`aubio`) analysis service server-side; cache results (BPM/key/beatgrid/peaks) in Postgres
- Reuse the current Node/Express + Postgres backend

**Legal**: a local-file player/mixer is fine (like VLC/Mixxx). Add Terms + Privacy. Keep
playback single-user; never redistribute or stream users' files.

---

## Path B — DJ-licensed streaming (catalog without owning files; needs a partnership)

These services license streaming **specifically for DJ use** via official SDKs:

| Service | Notes | Accessibility |
|---|---|---|
| **Beatport LINK / Beatsource LINK** | Streaming *made for DJs*; integrated in rekordbox/Serato/Traktor. Beatport = electronic; Beatsource = open-format/Top-40. | **Most reachable** for indie — apply to their integration program |
| **Tidal** | DJ extension program (powers djay/rekordbox). | B2B partnership |
| **Apple Music (MusicKit)** | djay integrates it; needs Apple Developer + a DJ agreement. Raw-audio beatmatch access is gated to partners. | Medium; partnership-dependent |

Trade-off: a legal catalog, but you're bound by partnership approval and whatever the SDK
allows (some don't expose raw audio for true beatmatching unless you're a partner).

---

## Recommendation
1. **Build Path A (local files) first** — it's fully compliant, fully capable, and turns this
   into a *real* browser DJ app (think Mixxx) with your AI ordering as the differentiator.
2. Add **Beatport/Beatsource LINK** later if you want a streaming catalog and go commercial.
3. **Drop Spotify** from the public product. (At most, keep a Spotify connector for
   *planning only* — read a library to order a set — but the safest public posture is no Spotify.)

## Migration steps from today
1. Replace `lib/resolve.js` (Spotify) + Spotify playback with: file upload → analysis → Web Audio decks.
2. Keep `harmonic.js`, `suggest.js`, `estimate.js`, ordering/planner/timeline UI.
3. The live mix timeline becomes **real** (driven by actual decks + waveforms).
4. Drop Spotify OAuth; add plain user accounts (keep the session + Postgres layer).
5. Add Terms of Service + Privacy Policy before any public launch.
