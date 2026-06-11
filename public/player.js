// Drives the existing Spotify client (desktop app / web player) via our server.
let currentSet = null;
let polling = false;
let scrubbing = false;

const $ = (id) => document.getElementById(id);
const status = (m) => ($("status").textContent = m);
const fmt = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

$("login").onclick = () => (window.location.href = "/login");

async function refreshAuthAndDevices() {
  const a = await (await fetch("/api/auth")).json();
  if (!a.loggedIn) return ($("who").textContent = "○ not connected");
  $("who").textContent = "● connected";
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
}

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
    $("controls").style.display = "flex";
    $("scrubrow").style.display = "flex";
    startPolling();
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
const BASE_VOL = 80, LOW_VOL = 12, FADE_MS = 7000;
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

// --- Now-playing poll (1s, drives scrubber + auto-mix) ---
function startPolling() {
  if (polling) return;
  polling = true;
  const tick = async () => {
    await refreshNow();
    setTimeout(tick, 1000);
  };
  tick();
}
async function refreshNow() {
  let n;
  try { n = await (await fetch("/api/now")).json(); } catch { return; }
  if (n.name) {
    highlightNowPlaying(n.name);
    $("nowName").textContent = "▶ " + n.name;
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
  const r = await fetch("/api/transitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: newOrder }),
  });
  currentSet = await r.json();
  render(currentSet);
}

let dragFrom = null;

function render({ order, transitions }) {
  const rows = [`<tr><th></th><th>#</th><th>Track</th><th>Artist</th><th>BPM</th><th>Key</th><th>→ next</th><th></th></tr>`];
  order.forEach((t, i) => {
    const tr = transitions[i];
    const flag = tr ? `<span class="${tr.flag}">${tr.flag}</span>` : "—";
    rows.push(
      `<tr draggable="true" data-idx="${i}" data-name="${(t.name || "").replace(/"/g, "")}">
        <td class="handle" title="Drag to reorder" style="cursor:grab">⠿</td>
        <td>${i + 1}</td>
        <td class="jump" title="Click to play from here" style="cursor:pointer">${t.name}</td>
        <td class="muted">${t.artist}</td>
        <td>${t.bpm ?? "?"}</td><td>${t.camelot ?? "?"}</td><td>${flag}</td>
        <td class="rm" title="Remove" style="cursor:pointer;color:#f85149">✕</td>
      </tr>`
    );
  });
  $("out").innerHTML = rows.join("");

  $("out").querySelectorAll("tr[data-idx]").forEach((row) => {
    const i = Number(row.dataset.idx);
    // Click the track name -> play from here.
    row.querySelector(".jump").onclick = async () => {
      const uris = currentSet.order.slice(i).map((t) => t.uri);
      if (await play(uris)) status(`Jumped to “${currentSet.order[i].name}”.`);
    };
    // Remove this song.
    row.querySelector(".rm").onclick = async () => {
      const removed = currentSet.order[i].name;
      const next = currentSet.order.filter((_, k) => k !== i);
      await applyOrder(next);
      status(`Removed “${removed}”.`);
    };
    // Drag to reorder.
    row.addEventListener("dragstart", () => (dragFrom = i));
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      const to = i;
      if (dragFrom === null || dragFrom === to) return;
      const arr = currentSet.order.slice();
      const [moved] = arr.splice(dragFrom, 1);
      arr.splice(to, 0, moved);
      dragFrom = null;
      await applyOrder(arr);
      status(`Moved “${moved.name}” to position ${to + 1}.`);
    });
  });
}

function highlightNowPlaying(name) {
  document.querySelectorAll("#out tr").forEach((tr) => {
    tr.classList.toggle("now", tr.dataset.name && name && tr.dataset.name === name);
  });
}

refreshAuthAndDevices();
