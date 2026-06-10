// Browser side: Web Playback SDK device + drives the AI-ordered queue.
let deviceId = null;
let player = null;
let currentSet = null; // { order, transitions }

const $ = (id) => document.getElementById(id);
const status = (m) => ($("status").textContent = m);

function playlistId(v) {
  const m = /playlist\/([a-zA-Z0-9]+)/.exec(v);
  return m ? m[1] : v.trim();
}

async function getToken() {
  const r = await fetch("/token");
  const { access_token } = await r.json();
  return access_token;
}

$("login").onclick = () => (window.location.href = "/login");

// Spotify SDK calls this global when ready.
window.onSpotifyWebPlaybackSDKReady = async () => {
  const token = await getToken();
  if (!token) {
    status("Connect Spotify first.");
    return;
  }
  player = new Spotify.Player({
    name: "AI Mixer",
    getOAuthToken: (cb) => getToken().then(cb),
    volume: 0.8,
  });
  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    $("who").textContent = "● player ready";
  });
  player.addListener("not_ready", () => ($("who").textContent = "○ offline"));
  player.addListener("player_state_changed", onStateChange);
  player.connect();
};

$("build").onclick = async () => {
  const id = playlistId($("playlist").value);
  status("Analyzing tracks (BPM/key) and ordering…");
  const r = await fetch(`/api/order/${id}`);
  const data = await r.json();
  if (data.error) {
    status("Error: " + JSON.stringify(data.error));
    return;
  }
  currentSet = data;
  render(data);
  status(`Ordered ${data.count} tracks. Press “Play set”.`);
};

$("play").onclick = async () => {
  if (!currentSet || !deviceId) {
    status("Build a set and make sure the player is ready.");
    return;
  }
  const uris = currentSet.order.map((t) => t.uri);
  const token = await getToken();
  // Start playback of the whole ordered set on our SDK device.
  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris }),
  });
  status("Playing the AI-ordered set. (Crossfade handles the overlap.)");
};

function onStateChange(state) {
  if (!state || !currentSet) return;
  const name = state.track_window.current_track?.name;
  highlightNowPlaying(name);
}

function render({ order, transitions }) {
  const rows = [
    `<tr><th>#</th><th>Track</th><th>Artist</th><th>BPM</th><th>Key</th><th>→ next</th></tr>`,
  ];
  order.forEach((t, i) => {
    const tr = transitions[i];
    const flag = tr ? `<span class="${tr.flag}">${tr.flag} · xf ${tr.crossfadeSec}s</span>` : "—";
    rows.push(
      `<tr data-name="${(t.name || "").replace(/"/g, "")}">
        <td>${i + 1}</td>
        <td>${t.name}</td>
        <td class="muted">${t.artist}</td>
        <td>${t.bpm ?? "?"}</td>
        <td>${t.camelot ?? "?"}</td>
        <td>${flag}</td>
      </tr>`
    );
  });
  $("out").innerHTML = rows.join("");
}

function highlightNowPlaying(name) {
  document.querySelectorAll("#out tr").forEach((tr) => {
    tr.classList.toggle("now", tr.dataset.name && name && tr.dataset.name === name);
  });
}
