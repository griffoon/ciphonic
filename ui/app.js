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
    if (onClick) row.addEventListener("click", () => onClick(item, items));
    return row;
  }));
}

async function loadCollection() {
  try {
    renderRows($("#liked"), await invoke("liked_tracks"), "пусто", playFrom);
  } catch (error) {
    renderRows($("#liked"), [], String(error));
  }
  try {
    renderRows($("#playlists"), await invoke("playlists"), "нет плейлистов");
  } catch (error) {
    renderRows($("#playlists"), [], String(error));
  }
}

// Playback queue: a list the user clicked into, or My Wave's rolling queue.
// play-audio reports are sent at start (played 0) and at the end, as the iOS app does.
const WAVE_FROM = "radio-mobile-user-onyourwave";
const COLLECTION_FROM = "mobile-own_collection-default";
const queueState = { items: [], index: -1, wave: false, current: null, playId: "", startedAt: 0, ended: false };
let waveLoading = false;

const newPlayId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const logError = (error) => console.warn("[volna]", String(error));

function reportListen(track, played, position) {
  invoke("report_listen", {
    trackId: track.id,
    albumId: track.albumId ?? null,
    durationMs: track.durationMs || 0,
    from: queueState.wave ? WAVE_FROM : COLLECTION_FROM,
    playId: queueState.playId,
    played,
    position,
  }).catch(logError);
}

function sendWaveEvent(kind, track, played) {
  if (!queueState.wave) return;
  invoke("wave_feedback", {
    kind,
    trackId: track.id,
    albumId: track.albumId ?? null,
    played,
  }).catch(logError);
}

async function playAt(index) {
  const track = queueState.items[index];
  if (!track) return;
  queueState.index = index;
  queueState.current = track;
  queueState.playId = newPlayId();
  queueState.startedAt = Date.now();
  queueState.ended = false;

  $("#now-title").textContent = `${track.artists} — ${track.title}`;
  $("#now-stream").textContent = "// загрузка…";
  document.querySelector('nav a[data-screen="now"]').click();
  loadLyrics(track);
  try {
    const s = await invoke("play_track", { trackId: track.id, quality: "lossless" });
    const codec = s.codec.replace("-mp4", "").toUpperCase();
    const rate = s.kbps ? ` | ${s.kbps} kbps` : "";
    $("#now-stream").textContent = `// ${codec}${rate} | ${s.local ? "расшифровано" : "по ссылке"}`;
    reportListen(track, 0, 0);
    sendWaveEvent("trackStarted", track, 0);
    if (queueState.wave && index >= queueState.items.length - 2) loadMoreWave();
  } catch (error) {
    $("#now-stream").textContent = `// ошибка: ${error}`;
  }
}

// A list click plays from there; the rest of the list becomes the queue.
function playFrom(item, items) {
  const list = [...items];
  queueState.items = list;
  queueState.wave = false;
  return playAt(list.indexOf(item));
}

// Reports the track as finished or skipped, then clears it as current.
async function finishCurrent(kind, played) {
  const track = queueState.current;
  if (!track) return;
  queueState.current = null;
  const seconds = Math.max(0, played || 0);
  reportListen(track, seconds, seconds);
  sendWaveEvent(kind, track, seconds);
}

async function nextTrack() {
  if (queueState.index + 1 < queueState.items.length) return playAt(queueState.index + 1);
  if (queueState.wave) {
    await loadMoreWave();
    if (queueState.index + 1 < queueState.items.length) return playAt(queueState.index + 1);
  }
  invoke("set_playing", { playing: false }).catch(logError);
}

async function loadMoreWave() {
  if (waveLoading || !queueState.wave) return;
  waveLoading = true;
  try {
    const more = await invoke("wave_more");
    const known = new Set(queueState.items.map((t) => t.id));
    queueState.items.push(...more.filter((t) => !known.has(t.id)));
    renderWaveList();
  } catch (error) {
    $("#wave-status").textContent = `// ${error}`;
  } finally {
    waveLoading = false;
  }
}

function renderWaveList() {
  renderRows($("#wave-list"), queueState.items, "волна пуста", (item) => {
    queueState.wave = true;
    return playAt(queueState.items.indexOf(item));
  });
}

async function startWave() {
  $("#wave-start").disabled = true;
  $("#wave-status").textContent = "// запускаю волну…";
  try {
    const tracks = await invoke("wave_start");
    queueState.items = tracks;
    queueState.wave = true;
    renderWaveList();
    $("#wave-status").textContent = "// волна учится на каждом треке: пропуски и лайки тоже";
    await playAt(0);
  } catch (error) {
    $("#wave-status").textContent = `// ${error}`;
  } finally {
    $("#wave-start").disabled = false;
  }
}

$("#wave-start").addEventListener("click", startWave);

$("#next").addEventListener("click", async () => {
  await finishCurrent("skip", lastStatus?.position ?? 0);
  await nextTrack();
});

$("#like").addEventListener("click", () => {
  const track = queueState.current;
  if (track && queueState.wave) sendWaveEvent("like", track, 0);
});

$("#dislike").addEventListener("click", () => {
  const track = queueState.current;
  if (track && queueState.wave) sendWaveEvent("dislike", track, 0);
});

// Called once when the decoder runs out of audio for the current track.
async function onTrackEnded() {
  queueState.ended = true;
  await finishCurrent("trackFinished", lastStatus?.duration ?? 0);
  await nextTrack();
}

// Lyrics: synced lines light up with the playhead; plain text is shown whole.
let lyricsTrackId = null;
let lyricsLines = [];
let lyricsEls = [];
let lyricsActive = -1;

async function loadLyrics(track) {
  lyricsTrackId = track.id;
  lyricsLines = [];
  lyricsEls = [];
  lyricsActive = -1;
  const box = $("#lyrics");
  const meta = $("#lyrics-meta");
  box.replaceChildren();
  meta.textContent = "// ищу текст…";
  try {
    const found = await invoke("get_lyrics", {
      trackId: track.id,
      title: track.title,
      artist: track.artists,
      durationMs: track.durationMs || 0,
    });
    if (lyricsTrackId !== track.id) return; // another track started meanwhile
    if (!found) {
      meta.textContent = "// текст не найден";
      return;
    }
    meta.textContent = `// текст: ${found.source}${found.writers?.length ? ` | ${found.writers.join(", ")}` : ""}`;
    if (found.kind === "synced") {
      lyricsLines = found.lines;
      lyricsEls = found.lines.map((line) => {
        const p = document.createElement("p");
        p.textContent = line.text || " ";
        box.append(p);
        return p;
      });
    } else {
      const p = document.createElement("p");
      p.textContent = found.text;
      p.classList.add("on");
      box.append(p);
    }
  } catch (error) {
    meta.textContent = `// текст: ${error}`;
  }
}

function updateLyrics(position) {
  if (!lyricsLines.length) return;
  let active = -1;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= position + 0.15) active = i;
    else break;
  }
  if (active === lyricsActive) return;
  lyricsActive = active;
  lyricsEls.forEach((el, i) => {
    el.classList.toggle("on", i === active);
    el.classList.toggle("past", i < active);
  });
  if (active >= 0) lyricsEls[active].scrollIntoView({ block: "center" });
}

function formatSeconds(total) {
  const whole = Math.max(0, Math.floor(total || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

let lastStatus = null;

function renderPlayer(status) {
  lastStatus = status;
  const ratio = status.duration > 0 ? Math.min(1, status.position / status.duration) : 0;
  $("#bar-fill").style.width = `${(ratio * 100).toFixed(2)}%`;
  $("#bar-time").textContent = `${formatSeconds(status.position)} / ${formatSeconds(status.duration)}`;
  $("#toggle").textContent = status.playing ? "пауза" : "играть";
  updateLyrics(status.position);
}

$("#toggle").addEventListener("click", () => {
  if (!lastStatus) return;
  invoke("set_playing", { playing: !lastStatus.playing });
});

$("#bar").addEventListener("click", (event) => {
  if (!lastStatus || !(lastStatus.duration > 0)) return;
  const ratio = event.offsetX / event.currentTarget.clientWidth;
  invoke("seek", { seconds: ratio * lastStatus.duration });
});

setInterval(async () => {
  if (!document.body.classList.contains("signed-in")) return;
  try {
    const status = await invoke("playback_status");
    renderPlayer(status);
    // Ignore the old track's end flag until the new load has taken effect.
    const settled = Date.now() - queueState.startedAt > 1500;
    if (status.ended && settled && !queueState.ended && queueState.current) onTrackEnded();
  } catch (_) {
    // The player may not have a track yet; the next tick tries again.
  }
}, 250);

$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#query").value.trim();
  if (!text) return;
  renderRows($("#results"), [], "ищу…");
  try {
    renderRows($("#results"), await invoke("search", { text }), "ничего не нашлось", playFrom);
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
