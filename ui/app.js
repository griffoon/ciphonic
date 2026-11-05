const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (selector) => document.querySelector(selector);

function showSession(session) {
  document.body.classList.toggle("signed-in", Boolean(session));
  if (session) {
    $("#who-name").textContent = session.displayName || session.login || `uid ${session.uid}`;
    loadCollection();
  }
  $("#login").disabled = false;
}

function formatDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Builds rows with textContent only: titles and artists come from the network.
function renderRows(container, items, emptyText, onClick) {
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "row";
    if (item.cover) {
      const img = document.createElement("img");
      img.src = item.cover;
      img.alt = "";
      row.append(img);
    } else {
      const blank = document.createElement("div");
      blank.className = "noimg";
      row.append(blank);
    }
    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = item.title;
    text.append(title);
    if (item.artists !== undefined) {
      const artists = document.createElement("div");
      artists.className = "a";
      artists.textContent = item.artists;
      text.append(artists);
    }
    row.append(text);
    const meta = document.createElement("div");
    meta.className = "d";
    if (item.durationMs !== undefined) meta.textContent = formatDuration(item.durationMs);
    if (item.trackCount !== undefined) meta.textContent = `${item.trackCount} трк`;
    row.append(meta);
    if (onClick) row.addEventListener("click", () => onClick(item));
    return row;
  }));
}

async function loadCollection() {
  try {
    renderRows($("#liked"), await invoke("liked_tracks"), "пусто", inspectTrack);
  } catch (error) {
    renderRows($("#liked"), [], String(error));
  }
  try {
    renderRows($("#playlists"), await invoke("playlists"), "нет плейлистов");
  } catch (error) {
    renderRows($("#playlists"), [], String(error));
  }
}

// Until the player exists, a click checks that the track resolves to a playable stream.
async function inspectTrack(track) {
  $("#now-title").textContent = `${track.artists} — ${track.title}`;
  $("#now-stream").textContent = "// ищу поток…";
  document.querySelector('nav a[data-screen="now"]').click();
  try {
    const s = await invoke("resolve_stream", { trackId: track.id, quality: "lossless" });
    const codec = s.codec.replace("-mp4", "").toUpperCase();
    const rate = s.kbps ? ` | ${s.kbps} kbps` : "";
    $("#now-stream").textContent = `// ${codec}${rate} | ${s.local ? "расшифровано" : "по ссылке"}`;
  } catch (error) {
    $("#now-stream").textContent = `// ошибка: ${error}`;
  }
}

$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#query").value.trim();
  if (!text) return;
  renderRows($("#results"), [], "ищу…");
  try {
    renderRows($("#results"), await invoke("search", { text }), "ничего не нашлось", inspectTrack);
  } catch (error) {
    renderRows($("#results"), [], String(error));
  }
});

function showLoginError(message) {
  $("#login-error").textContent = message || "";
  $("#login").disabled = false;
}

$("#login").addEventListener("click", async () => {
  $("#login").disabled = true;
  $("#login-error").textContent = "";
  try {
    await invoke("start_login");
  } catch (error) {
    showLoginError(String(error));
  }
});

$("#token-ok").addEventListener("click", async () => {
  const token = $("#token").value.trim();
  if (!token) return;
  $("#login-error").textContent = "";
  try {
    const session = await invoke("login_with_token", { token });
    $("#token").value = "";
    showSession(session);
  } catch (error) {
    showLoginError(String(error));
  }
});

$("#logout").addEventListener("click", () => invoke("logout"));

const links = document.querySelectorAll("nav a");
links.forEach((a) => a.addEventListener("click", () => {
  links.forEach((x) => x.classList.toggle("on", x === a));
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === a.dataset.screen));
}));

listen("session-changed", (event) => showSession(event.payload));
listen("login-error", (event) => showLoginError(event.payload));

invoke("current_session")
  .then((session) => showSession(session))
  .catch((error) => showLoginError(String(error)));
