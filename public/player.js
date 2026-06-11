// Drives the existing Spotify client (desktop app / web player) via our server.
let currentSet = null;
let polling = false;
let scrubbing = false;

const $ = (id) => document.getElementById(id);
let toastTimer;
function toast(m) {
  const t = $("toast");
  t.textContent = m;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}
const status = (m) => { $("status").textContent = m; toast(m); };

// --- Undo (Cmd/Ctrl+Z) — snapshot the set before every edit ---
let undoStack = [];
function snapshot() {
  if (currentSet) {
    undoStack.push(JSON.parse(JSON.stringify(currentSet)));
    if (undoStack.length > 60) undoStack.shift();
  }
}
function undo() {
  if (!undoStack.length) return toast("Nothing to undo.");
  currentSet = undoStack.pop();
  render(currentSet);
  toast("↩︎ Undid last change.");
}
document.addEventListener("keydown", (e) => {
  const z = e.key === "z" || e.key === "Z";
  if ((e.metaKey || e.ctrlKey) && z && !e.shiftKey) {
    e.preventDefault();
    undo();
  }
});
const fmt = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

$("login").onclick = () => (window.location.href = "/login");

$("logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
};

async function refreshAuthAndDevices() {
  const a = await (await fetch("/api/auth")).json();
  if (!a.loggedIn) {
    $("who").textContent = "not connected";
    $("dot").classList.remove("on");
    $("login").style.display = "";
    $("logout").style.display = "none";
    return;
  }
  $("who").textContent = "connected";
  $("dot").classList.add("on");
  $("login").style.display = "none";
  $("logout").style.display = "";
  const d = await (await fetch("/api/devices")).json();
  const sel = $("device");
  sel.innerHTML = "";
  (d.devices || []).forEach((dev) => {
    const o = document.createElement("option");
    o.value = dev.id;
    o.dataset.type = dev.type;
    o.textContent = `${dev.name} (${dev.type})${dev.is_active ? " • active" : ""}`;
    if (dev.is_active) o.selected = true;
    sel.appendChild(o);
  });
  if (!sel.options.length) {
    const o = document.createElement("option");
    o.textContent = "No device — open the Spotify app first";
    sel.appendChild(o);
  }
  loadPlaylists();
}

// Populate the "your playlists" dropdown after connecting.
async function loadPlaylists() {
  const r = await fetch("/api/playlists");
  if (!r.ok) return;
  const list = await r.json();
  const sel = $("playlists");
  sel.innerHTML = `<option value="">— choose a playlist —</option>`;
  list.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name} (${p.count})`;
    sel.appendChild(o);
  });
}
// Selecting a playlist ADDS it to the box — pick several to merge them.
$("playlists").onchange = () => {
  const sel = $("playlists");
  const id = sel.value;
  if (!id) return;
  const url = `https://open.spotify.com/playlist/${id}`;
  const cur = $("lines").value.trim();
  if (!cur.includes(id)) $("lines").value = (cur ? cur + "\n" : "") + url;
  const name = sel.options[sel.selectedIndex].textContent;
  status(`Added “${name}”. Pick more to merge, then Build AI set.`);
  sel.value = ""; // reset so the next pick adds another
};

$("build").onclick = async () => {
  const lines = $("lines").value;
  if (!lines.trim()) return status("Paste a playlist link or some tracks first.");
  status("Reading playlist + analyzing (BPM/key) + ordering…");
  const r = await fetch("/api/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  });
  const data = await r.json();
  if (data.error) return status("Error: " + JSON.stringify(data.error));
  currentSet = data;
  render(data);
  let msg = `Ordered ${data.count} tracks.`;
  if (data.unresolved?.length) msg += ` Couldn't find: ${data.unresolved.join("; ")}.`;
  status(msg + " Press “Play set”.");
};

const deviceId = () => $("device").value;

async function play(uris) {
  const r = await fetch("/api/play", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris, device_id: deviceId() }),
  });
  if (r.status === 204 || r.ok) {
    $("bar").style.display = "block";
    startPolling();
    // Verify audio actually started — catches "device not really playing".
    setTimeout(async () => {
      try {
        const n = await (await fetch("/api/now")).json();
        if (!n.playing)
          status("Playback didn't start — open the Spotify desktop app and pick it under “Play on device”.");
      } catch {}
    }, 1600);
    return true;
  }
  const e = await r.json().catch(() => ({}));
  status("Play failed: " + JSON.stringify(e.error || e));
  return false;
}

// Controls target the ACTIVE device (no device_id) — more robust than pinning
// to the dropdown, which can go stale.
async function ctl(path, method) {
  await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
  setTimeout(refreshNow, 300);
}

$("play").onclick = async () => {
  if (!currentSet) return status("Build a set first.");
  if (await play(currentSet.order.map((t) => t.uri)))
    status("Playing the AI-ordered set.");
};

// Improve: reshuffle only the not-yet-played songs into the smoothest BPM/key
// flow from the current song, then re-queue so it actually takes effect.
$("improve").onclick = async () => {
  if (!currentSet?.order?.length) return status("Build a set first.");
  snapshot();
  let fromIndex = 0, cur = null, pos = 0, playing = false;
  try {
    const n = await (await fetch("/api/now")).json();
    playing = !!n.playing;
    if (n.name) {
      const idx = currentSet.order.findIndex((t) => t.uri === n.uri || t.name === n.name);
      if (idx >= 0) { fromIndex = idx; cur = currentSet.order[idx]; pos = n.progress_ms || 0; }
    }
  } catch {}
  const r = await fetch("/api/improve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: currentSet.order, fromIndex }),
  });
  currentSet = await r.json();
  render(currentSet);
  const moved = currentSet.order.length - fromIndex - 1;
  status(`Reshuffled the ${moved} upcoming song${moved === 1 ? "" : "s"} for the smoothest BPM/key flow.`);
  // Re-queue the new order while keeping the current song where it is.
  if (playing && cur) {
    await fetch("/api/play", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: currentSet.order.map((t) => t.uri), offsetUri: cur.uri, position_ms: pos, device_id: deviceId() }),
    });
  }
};

$("pause").onclick = () => ctl("/api/pause", "PUT");
$("resume").onclick = () => ctl("/api/resume", "PUT");
$("next").onclick = () => ctl("/api/next", "POST");
$("prev").onclick = () => ctl("/api/previous", "POST");

// --- Scrubber ---
$("scrub").addEventListener("input", () => {
  scrubbing = true;
  $("t0").textContent = fmt($("scrub").value);
});
$("scrub").addEventListener("change", async () => {
  await fetch("/api/seek", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position_ms: Number($("scrub").value) }),
  });
  scrubbing = false;
  setTimeout(refreshNow, 300);
});

// --- Auto-mix: app-driven volume fade out/in around each transition ---
// LOW_VOL kept well above silence so a song never sounds "stopped".
const BASE_VOL = 90, LOW_VOL = 35, FADE_MS = 6000;
let lastSentVol = null;
function autoMix(n) {
  if (!$("automix").checked) return;
  if (!n.playing || !n.duration_ms) return;
  const remaining = n.duration_ms - n.progress_ms;
  let target = BASE_VOL;
  if (remaining <= FADE_MS) target = LOW_VOL + (BASE_VOL - LOW_VOL) * (remaining / FADE_MS); // fade out
  else if (n.progress_ms <= FADE_MS) target = LOW_VOL + (BASE_VOL - LOW_VOL) * (n.progress_ms / FADE_MS); // fade in
  target = Math.round(target);
  if (lastSentVol === null || Math.abs(target - lastSentVol) >= 4) {
    lastSentVol = target;
    fetch("/api/volume", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume_percent: target }),
    });
  }
}
$("automix").onchange = () => {
  if ($("automix").checked) {
    status("Auto-mix on — the app fades each song out and the next in automatically.");
  } else {
    lastSentVol = null;
    fetch("/api/volume", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume_percent: BASE_VOL }),
    });
  }
};

// --- Deep mix: transition before a song ends for a continuous DJ blend ---
// IMPORTANT: a manual "next" does NOT trigger Spotify's crossfade — only a
// NATURAL song end does. So instead of skipping, we seek to ~11s before the end
// (past the song's outro), letting native crossfade blend into the next track.
// Requires Spotify desktop Crossfade to be ON.
let deepAdvancedUri = null;
const BLEND_TAIL_MS = 11000; // align with a ~10–12s native crossfade
function deepMix(n) {
  if (!$("deepmix").checked || !n.playing || !n.duration_ms || !n.uri) return;
  if (deepAdvancedUri === n.uri) return;
  const blendStart = n.duration_ms - BLEND_TAIL_MS;
  // Once past ~80% and there's still outro to skip, jump to the blend point.
  if (n.progress_ms >= n.duration_ms * 0.8 && blendStart > n.progress_ms + 1500) {
    deepAdvancedUri = n.uri; // once per track
    fetch("/api/seek", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position_ms: blendStart }),
    });
  }
}

// --- Saved sets ---
async function loadSavedList() {
  const list = await (await fetch("/api/sets")).json();
  const sel = $("savedSets");
  sel.innerHTML = list.length ? "" : "<option>— no saved sets —</option>";
  list.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = `${s.name} (${s.count})`;
    sel.appendChild(o);
  });
}
$("saveSet").onclick = async () => {
  if (!currentSet) return status("Build or load a set first.");
  const name = ($("setName").value || "").trim();
  if (!name) return status("Give the set a name to save it.");
  await fetch("/api/sets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, order: currentSet.order }),
  });
  await loadSavedList();
  $("savedSets").value = name;
  status(`Saved “${name}”.`);
};
$("loadSet").onclick = async () => {
  const name = $("savedSets").value;
  if (!name) return;
  const r = await fetch("/api/sets/" + encodeURIComponent(name));
  if (!r.ok) return status("Couldn't load that set.");
  currentSet = await r.json();
  render(currentSet);
  $("setName").value = name;
  status(`Loaded “${name}” — edit it, then Play or re-Save.`);
};
$("delSet").onclick = async () => {
  const name = $("savedSets").value;
  if (!name) return;
  await fetch("/api/sets/" + encodeURIComponent(name), { method: "DELETE" });
  await loadSavedList();
  status(`Deleted “${name}”.`);
};

// --- Now-playing poll (1s, drives scrubber + auto-mix) ---
function startPolling() {
  if (polling) return;
  polling = true;
  const tick = async () => {
    try { await refreshNow(); } catch (e) { /* never let the loop die */ }
    setTimeout(tick, 1000);
  };
  tick();
}
async function refreshNow() {
  let n;
  try { n = await (await fetch("/api/now")).json(); } catch { return; }
  if (!n) return;
  lastNow = n; lastNowTs = performance.now(); // feed the live mix timeline
  if (n.name) {
    highlightNowPlaying(n.name);
    $("nowName").textContent = (n.playing ? "▶ " : "⏸ ") + n.name;
  }
  if (!scrubbing && n.duration_ms) {
    $("scrub").max = n.duration_ms;
    $("scrub").value = n.progress_ms || 0;
    $("t0").textContent = fmt(n.progress_ms);
    $("t1").textContent = fmt(n.duration_ms);
  }
  // Warn when crossfade can't physically work (web player has no crossfade).
  $("devWarn").textContent =
    n.deviceType && n.deviceType !== "Computer"
      ? ""
      : n.device && /web player/i.test(n.device)
      ? "⚠ Web Player can't crossfade — use the desktop app + Auto-mix"
      : "";
  autoMix(n);
  deepMix(n);
}

// --- General song search ---
async function runSearch() {
  const q = $("searchq").value.trim();
  if (!q) return;
  $("searchStatus").textContent = "Searching…";
  const r = await fetch("/api/search?q=" + encodeURIComponent(q));
  if (!r.ok) return ($("searchStatus").textContent = "Search failed (are you connected?).");
  const { results } = await r.json();
  renderSearch(results);
  $("searchStatus").textContent = results.length ? `${results.length} results — ➕ adds to your set at its best spot.` : "No matches.";
}
$("searchBtn").onclick = runSearch;
$("searchq").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

function renderSearch(results) {
  const rows = [`<tr><th></th><th>Track</th><th>Artist</th><th>Album</th></tr>`];
  results.forEach((t, i) => {
    rows.push(
      `<tr data-i="${i}">
        <td><button class="addbtn btn-ghost btn-sm">➕</button></td>
        <td>${t.name}</td><td class="muted">${t.artist}</td><td class="muted">${t.album || ""}</td>
      </tr>`
    );
  });
  $("searchResults").innerHTML = rows.join("");
  $("searchResults").querySelectorAll("tr[data-i]").forEach((row) => {
    const t = results[Number(row.dataset.i)];
    row.querySelector(".addbtn").onclick = async () => {
      row.querySelector(".addbtn").disabled = true;
      snapshot();
      const r = await fetch("/api/addtrack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: currentSet?.order || [], add: t }),
      });
      if (!r.ok) { $("searchStatus").textContent = "Couldn't add that one."; return; }
      currentSet = await r.json();
      render(currentSet);
      status(`Added “${t.name}” to the set at its best spot.`);
    };
  });
}

// --- AI suggestions ---
$("suggest").onclick = async () => {
  if (!currentSet) return ($("suggestStatus").textContent = "Build a set first.");
  $("suggestStatus").textContent = "Asking the AI for songs that fit…";
  const r = await fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tracks: currentSet.order.map((t) => ({ name: t.name, artist: t.artist, bpm: t.bpm, camelot: t.camelot })),
      context: $("context").value || "wedding party",
    }),
  });
  const data = await r.json();
  if (data.error) return ($("suggestStatus").textContent = "Error: " + data.error);
  renderSuggestions(data.suggestions || []);
  $("suggestStatus").textContent = `${data.suggestions.length} suggestions — ➕ inserts each at its best spot.`;
};

function renderSuggestions(list) {
  const have = new Set(currentSet.order.map((t) => t.uri));
  const rows = [`<tr><th></th><th>Suggested track</th><th>Artist</th><th>BPM</th><th>Key</th><th>Why</th></tr>`];
  list.forEach((t, i) => {
    rows.push(
      `<tr data-i="${i}">
        <td><button class="addbtn secondary" ${have.has(t.uri) ? "disabled" : ""}>➕</button></td>
        <td>${t.name}</td><td class="muted">${t.artist}</td>
        <td>${t.bpm ?? "?"}</td><td>${t.camelot ?? "?"}</td><td class="muted">${t.reason || ""}</td>
      </tr>`
    );
  });
  $("suggestions").innerHTML = rows.join("");
  $("suggestions").querySelectorAll("tr[data-i]").forEach((row) => {
    const t = list[Number(row.dataset.i)];
    row.querySelector(".addbtn").onclick = async () => {
      if (currentSet.order.some((x) => x.uri === t.uri)) return;
      snapshot();
      // Smart add: re-order the whole set with the new track so it lands in its
      // best harmonic spot instead of a risky append at the end.
      const tracks = [...currentSet.order, t];
      const reordered = await (
        await fetch("/api/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks }),
        })
      ).json();
      currentSet = reordered;
      render(currentSet);
      row.querySelector(".addbtn").disabled = true;
      status(`Added “${t.name}” at its best spot. Press “Play set” for the new order.`);
    };
  });
}

// Apply a new manual order: refresh junction flags for the fixed order, re-render.
async function applyOrder(newOrder) {
  snapshot(); // for Cmd/Ctrl+Z
  const r = await fetch("/api/transitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: newOrder }),
  });
  currentSet = await r.json();
  render(currentSet);
}

let dragFrom = null;
let dragFlags = null;

function render({ order, transitions }) {
  $("spots").innerHTML = "";
  $("emptyState").style.display = order.length ? "none" : "";
  $("mixCard").style.display = order.length ? "block" : "none"; // live mix view always visible with a set
  const rows = [`<tr><th></th><th>#</th><th>Track</th><th>Artist</th><th>BPM</th><th>Key</th><th>→ next</th><th></th><th></th></tr>`];
  order.forEach((t, i) => {
    const tr = transitions[i];
    const flag = tr ? `<span class="badge click ${tr.flag}" title="See the BPM/beat alignment & best transition point">${tr.flag} ⟶</span>` : "—";
    rows.push(
      `<tr draggable="true" data-idx="${i}" data-name="${(t.name || "").replace(/"/g, "")}">
        <td class="handle" title="Drag to reorder">⠿</td>
        <td class="muted">${i + 1}</td>
        <td class="jump" title="Click to play from here">${t.name}</td>
        <td class="muted">${t.artist}</td>
        <td>${t.bpm ?? "?"}</td><td>${t.camelot ?? "?"}</td><td>${flag}</td>
        <td class="target" title="Suggest smooth spots for this song">🎯</td>
        <td class="rm" title="Remove">✕</td>
      </tr>`
    );
  });
  $("out").innerHTML = rows.join("");

  $("out").querySelectorAll("tr[data-idx]").forEach((row) => {
    const i = Number(row.dataset.idx);
    row.querySelector(".jump").onclick = async () => {
      const uris = currentSet.order.slice(i).map((t) => t.uri);
      if (await play(uris)) status(`Jumped to “${currentSet.order[i].name}”.`);
    };
    row.querySelector(".rm").onclick = async () => {
      const removed = currentSet.order[i].name;
      await applyOrder(currentSet.order.filter((_, k) => k !== i));
      status(`Removed “${removed}”.`);
    };
    row.querySelector(".target").onclick = () => suggestSpots(i);
    const fl = row.querySelector(".badge.click");
    if (fl) fl.onclick = () => showMixView(i);

    // --- Drag with live "is this a smooth spot?" feedback ---
    row.addEventListener("dragstart", async () => {
      dragFrom = i;
      dragFlags = null;
      row.classList.add("dragging");
      // Precompute the drop quality for every position (one call per drag).
      const r = await fetch("/api/bestspots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: currentSet.order, index: i }),
      });
      const { spots } = await r.json();
      dragFlags = {};
      spots.forEach((s) => (dragFlags[s.pos] = s.flag));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (dragFrom === null || !dragFlags) return;
      const othersPos = i > dragFrom ? i - 1 : i; // insertion index in the list-minus-dragged
      const flag = dragFlags[othersPos] || "unknown";
      clearDropMarks();
      row.classList.add("drop-" + flag);
      status(`Drop here → ${flag === "smooth" ? "✅ smooth" : flag === "ok" ? "🟡 ok" : flag === "risky" ? "🔴 risky" : "⚪ unknown"} transition`);
    });
    row.addEventListener("dragend", () => { row.classList.remove("dragging"); clearDropMarks(); });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      clearDropMarks();
      if (dragFrom === null || dragFrom === i) return;
      const arr = currentSet.order.slice();
      const [moved] = arr.splice(dragFrom, 1);
      arr.splice(i, 0, moved);
      const from = dragFrom; dragFrom = null; dragFlags = null;
      await applyOrder(arr);
      status(`Moved “${moved.name}” to position ${i + 1}.`);
    });
  });
}

// --- Live mix timeline (GarageBand-style: current clip + next crossing over) ---
let lastNow = null, lastNowTs = 0;
function roundRect(ctx, x, y, w, h, r, fill) {
  if (w < 1) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function pseudoWave(ctx, x0, x1, yMid, color, seedStr, alpha) {
  let seed = 7;
  for (const ch of seedStr || "x") seed = (seed * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  for (let x = x0; x < x1; x += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const h = 4 + (seed % 100) / 100 * 24;
    ctx.fillRect(x, yMid - h / 2, 2, h);
  }
  ctx.globalAlpha = 1;
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

function drawMixTimeline(n) {
  const c = $("mixtimeline");
  if (!c) return;
  if (!n || !n.duration_ms || !currentSet?.order?.length) { $("mixCard").style.display = "none"; return; }
  $("mixCard").style.display = "block";
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  const i = currentSet.order.findIndex((t) => t.uri === n.uri || t.name === n.name);
  const cur = i >= 0 ? currentSet.order[i] : { name: n.name, bpm: null };
  const next = i >= 0 ? currentSet.order[i + 1] : null;
  const durA = n.duration_ms;
  const blend = cur.bpm ? Math.min(durA * 0.4, (4 * 60 / cur.bpm) * 16 * 1000) : 12000;
  const tA = Math.max(0, durA - blend);
  const total = durA + blend;
  const pad = 12, w = W - 2 * pad;
  const X = (ms) => pad + (ms / total) * w;
  const ayMid = 50, byMid = 100, laneH = 38;

  // Lane A (current)
  roundRect(ctx, X(0), ayMid - laneH / 2, X(durA) - X(0), laneH, 8, "rgba(109,124,255,.16)");
  pseudoWave(ctx, X(0) + 3, X(durA) - 3, ayMid, "#5866d6", cur.name, 0.5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(X(0), ayMid - laneH / 2, Math.max(0, X(n.progress_ms) - X(0)), laneH);
  ctx.clip();
  pseudoWave(ctx, X(0) + 3, X(durA) - 3, ayMid, "#9aa6ff", cur.name, 1);
  ctx.restore();

  // Lane B (next) — starts at the transition point, overlapping A's tail
  if (next) {
    roundRect(ctx, X(tA), byMid - laneH / 2, X(total) - X(tA), laneH, 8, "rgba(167,139,250,.16)");
    pseudoWave(ctx, X(tA) + 3, X(total) - 3, byMid, "#a78bfa", next.name, 0.75);
  }

  // Crossfade region (overlap) — gradient + the classic crossfade "X"
  const cx0 = X(tA), cx1 = X(durA);
  const g = ctx.createLinearGradient(cx0, 0, cx1, 0);
  g.addColorStop(0, "rgba(167,139,250,0)");
  g.addColorStop(1, "rgba(167,139,250,.22)");
  ctx.fillStyle = g;
  ctx.fillRect(cx0, 14, cx1 - cx0, H - 28);
  if (next) {
    ctx.strokeStyle = "rgba(255,255,255,.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx0, ayMid - laneH / 2); ctx.lineTo(cx1, ayMid + laneH / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx0, byMid + laneH / 2); ctx.lineTo(cx1, byMid - laneH / 2); ctx.stroke();
    ctx.fillStyle = "#cdd4ee";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText("crossfade", (cx0 + cx1) / 2 - 26, 12);
  }

  // Labels
  ctx.fillStyle = "#eef1f7";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(trunc(cur.name || n.name, 46), X(0) + 6, ayMid - laneH / 2 - 5);
  if (next) ctx.fillText("→ " + trunc(next.name, 46), X(tA) + 6, byMid + laneH / 2 + 15);

  // Playhead
  const px = X(n.progress_ms);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 6); ctx.lineTo(px, H - 6); ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.moveTo(px - 4, 6); ctx.lineTo(px + 4, 6); ctx.lineTo(px, 12); ctx.closePath(); ctx.fill();

  // Hint when it's a static preview (not playing).
  if (!n.playing) {
    ctx.fillStyle = "rgba(153,162,184,.9)";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText("preview — press ▶ Play set to watch it move & cross over", pad + 4, H - 6);
  }
}

// Always show the 2-song mix view when a set exists: animate the real playhead
// while playing, otherwise show a static preview of the first two songs.
function animateTimeline() {
  try {
    let n = null;
    if (lastNow && lastNow.duration_ms && lastNow.name) {
      n = { ...lastNow };
      if (lastNow.playing) n.progress_ms = Math.min(lastNow.duration_ms, lastNow.progress_ms + (performance.now() - lastNowTs));
    } else if (currentSet?.order?.length) {
      const a = currentSet.order[0];
      n = { name: a.name, uri: a.uri, duration_ms: a.duration_ms || 210000, progress_ms: 0, playing: false };
    }
    if (n) drawMixTimeline(n);
  } catch (e) { /* never let the loop die */ }
  requestAnimationFrame(animateTimeline);
}
requestAnimationFrame(animateTimeline);

// --- Transition planner: BPM/beat alignment + best transition point ---
function showMixView(i) {
  const a = currentSet.order[i], b = currentSet.order[i + 1];
  if (!b) return;
  const mv = $("mixview");
  const ba = a.bpm, bb = b.bpm;

  let bpmHtml;
  if (ba && bb) {
    const d = bb - ba;
    const shift = -(d / ba) * 100; // % B must change to match A
    const ad = Math.abs(d);
    const v = ad <= 2 ? ["tight", "smooth"] : ad <= 5 ? ["close", "smooth"] : ad <= 10 ? ["workable", "ok"] : ["far apart", "risky"];
    bpmHtml = `Tempo: <b>${a.name}</b> ${ba} BPM → <b>${b.name}</b> ${bb} BPM (${d >= 0 ? "+" : ""}${d} BPM). ` +
      `Beat-match by nudging the incoming track <b>${shift >= 0 ? "+" : ""}${shift.toFixed(1)}%</b>. <span class="badge ${v[1]}">${v[0]}</span>`;
  } else {
    bpmHtml = `Tempo: one track has no BPM yet — rebuild the set to AI-fill it.`;
  }

  const keyHtml = `Key: <b>${a.camelot || "?"}</b> → <b>${b.camelot || "?"}</b> (Camelot — adjacent numbers or same number swap = harmonic).`;

  let planHtml = "";
  let transitionMs = null;
  if (ba && a.duration_ms) {
    const barSec = (4 * 60) / ba;          // 1 bar = 4 beats
    const phrase = 16;                       // mix over a 16-bar phrase
    const blendSec = barSec * phrase;
    const durSec = a.duration_ms / 1000;
    let start = durSec - blendSec;
    if (start < durSec * 0.5) start = durSec * 0.75;
    transitionMs = Math.round(start * 1000);
    planHtml = `Suggested transition: start the blend at <b>${fmt(start * 1000)}</b> — the last <b>${phrase} bars</b> (~${blendSec.toFixed(0)}s) of “${a.name}”. Bring “${b.name}” in on its first downbeat. (1 bar ≈ ${barSec.toFixed(2)}s.)`;
  } else if (ba) {
    planHtml = `Suggested transition: blend over the last 16 bars (~${((4 * 60 / ba) * 16).toFixed(0)}s). Exact timestamp needs the track length — rebuild from a playlist to capture it.`;
  }

  mv.innerHTML =
    `<div class="mvhead">🎚 Transition planner</div>` +
    `<div class="mvrow">${bpmHtml}</div>` +
    `<div class="mvrow muted">${keyHtml}</div>` +
    `<div class="mvrow">${planHtml}</div>` +
    `<canvas id="beatgrid" width="900" height="84"></canvas>` +
    `<div class="mvrow muted" style="font-size:12px">Top row = “${a.name}” beats · bottom = “${b.name}” beats, aligned at the blend start. Ticks lining up = beat-matched; drifting apart = the tempo gap you'd correct.</div>` +
    `<div class="row tight" style="margin-top:10px">` +
    (transitionMs != null && a.uri ? `<button class="btn-primary btn-sm" id="mvjump">▶ Hear this transition</button>` : "") +
    `<button class="btn-ghost btn-sm" id="mvclose">Close</button></div>`;
  mv.style.display = "block";
  $("mvclose").onclick = () => (mv.style.display = "none");
  if ($("mvjump")) {
    $("mvjump").onclick = async () => {
      // Play the current song from the transition point; the next song is queued
      // right after, so you hear the actual blend (with native crossfade on).
      const uris = currentSet.order.slice(i).map((t) => t.uri);
      const r = await fetch("/api/play", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris, offsetUri: a.uri, position_ms: transitionMs, device_id: deviceId() }),
      });
      if (r.status === 204 || r.ok) {
        $("bar").style.display = "block";
        startPolling();
        status(`Jumped to the transition point of “${a.name}”.`);
      } else {
        status("Couldn't seek — open the Spotify desktop app and pick it as the device.");
      }
    };
  }
  drawBeatGrid(ba, bb);
  mv.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function drawBeatGrid(ba, bb) {
  const c = $("beatgrid");
  if (!c) return;
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!ba || !bb) {
    ctx.fillStyle = "#939db3"; ctx.font = "13px Inter, sans-serif";
    ctx.fillText("Beat grid needs BPM for both tracks.", 16, H / 2);
    return;
  }
  const winSec = 8, px = W / winSec;
  const drawRow = (bpm, y, color, label) => {
    const beat = 60 / bpm, bar = beat * 4;
    ctx.fillStyle = "#939db3"; ctx.font = "11px Inter, sans-serif";
    ctx.fillText(label, 6, y - 22);
    for (let t = 0, n = 0; t <= winSec + 1e-6; t += beat, n++) {
      const x = t * px;
      const downbeat = n % 4 === 0;
      ctx.strokeStyle = color;
      ctx.lineWidth = downbeat ? 3 : 1.5;
      ctx.globalAlpha = downbeat ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  drawRow(ba, 30, "#6d7cff", "A · " + ba + " BPM");
  drawRow(bb, 64, "#a78bfa", "B · " + bb + " BPM");
}

function clearDropMarks() {
  document.querySelectorAll("#out tr").forEach((r) =>
    r.classList.remove("drop-smooth", "drop-ok", "drop-risky", "drop-unknown")
  );
}

// Ask the server for the smoothest spots to move track `i` to, show as chips.
async function suggestSpots(i) {
  const song = currentSet.order[i].name;
  toast(`Finding the best spots for “${song}”…`);
  let data;
  try {
    const r = await fetch("/api/bestspots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: currentSet.order, index: i }),
    });
    data = await r.json();
  } catch { return toast("Couldn't load best spots."); }
  const { spots, others } = data;
  if (!spots?.length) return toast("No spots found.");
  const top = spots.slice(0, 5);
  const chips = [`<span class="chip head">Best spots for “${song}” — click one to move it:</span>`];
  top.forEach((s) => {
    const where = s.pos === 0 ? "at the very start" : `after “${others[s.pos - 1].name}”`;
    chips.push(`<span class="chip" data-pos="${s.pos}"><span class="badge ${s.flag}">${s.flag}</span> ${where}</span>`);
  });
  $("spots").innerHTML = chips.join("");
  // The chips render at the top of the set — bring them into view so the click is visible.
  $("spots").scrollIntoView({ behavior: "smooth", block: "center" });
  $("spots").querySelectorAll(".chip[data-pos]").forEach((chip) => {
    chip.onclick = async () => {
      const pos = Number(chip.dataset.pos);
      const arr = others.slice();
      arr.splice(pos, 0, currentSet.order[i]);
      await applyOrder(arr);
      status(`Moved “${song}” to a ${chip.querySelector(".badge").textContent} spot.`);
    };
  });
}

function highlightNowPlaying(name) {
  document.querySelectorAll("#out tr").forEach((tr) => {
    tr.classList.toggle("now", tr.dataset.name && name && tr.dataset.name === name);
  });
}

refreshAuthAndDevices();
loadSavedList();
