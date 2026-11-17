// History, similar tracks, «О треке», add to playlist, sharing, clips, dialogs and the idle mode
// (HistoryView.swift, SimilarTracksView, TrackAboutView, AddToPlaylistView, IdleView.swift).
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const KIND_TITLES = { album: "альбом", playlist: "плейлист", artist: "артист", wave: "волна" };

  // ---------- dialogs (the iOS alerts with a field or a destructive button) ----------
  function dialog({ title, message, field, okLabel, destructive }) {
    return new Promise((resolve) => {
      const input = field !== undefined ? h("input.dialog-input", { value: field, spellcheck: "false" }) : null;
      const close = (value) => {
        layer.classList.remove("on");
        setTimeout(() => layer.remove(), 200);
        resolve(value);
      };
      const ok = h(`button.alert-ok${destructive ? ".destructive" : ""}`, { onclick: () => close(input ? input.value.trim() || null : true) }, okLabel);
      const layer = h("div.alert-layer", h("div.alert.glass",
        h("div.alert-title", title),
        message ? h("div.alert-text", message) : null,
        input,
        h("div.alert-buttons", h("button.alert-ok.cancel", { onclick: () => close(null) }, "Отмена"), ok)));
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok.click();
        if (e.key === "Escape") close(null);
      });
      document.body.append(layer);
      requestAnimationFrame(() => {
        layer.classList.add("on");
        input?.focus();
        input?.select();
      });
    });
  }
  V.prompt = (title, value = "", okLabel = "Сохранить") => dialog({ title, field: value, okLabel });
  V.confirm = (title, message, okLabel) => dialog({ title, message, okLabel, destructive: true });
  V.ask = (title, message, okLabel) => dialog({ title, message, okLabel });

  // ---------- sharing and clips ----------
  V.trackLink = (track) => (track.albumId
    ? `https://music.yandex.ru/album/${track.albumId}/track/${track.id}`
    : `https://music.yandex.ru/track/${track.id}`);

  V.share = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      V.toast("> ссылка скопирована");
    } catch (_) {
      V.toast("> не получилось скопировать");
    }
  };

  /// The clip for a track (a real video, or a YouTube search), asked once per track.
  const clips = new Map();
  V.clipFor = (track) => {
    if (!clips.has(track.id)) {
      clips.set(track.id, V.invoke("find_clip", { trackId: track.id, artist: track.artists, title: V.fullTitle(track) })
        .catch((error) => { clips.delete(track.id); throw error; }));
    }
    return clips.get(track.id);
  };

  /// The clip: a real video when Yandex links one, otherwise a YouTube search to try.
  V.openClip = async (track) => {
    V.toast("> ищу клип…");
    try {
      const clip = await V.clipFor(track);
      await V.invoke("open_url", { url: clip.url });
      V.toast(clip.found ? "> клип открыт" : "> клипа нет, открыл поиск");
    } catch (error) {
      V.emit("error", String(error));
    }
  };

  // ---------- recent contexts ----------
  /// Opens what was played from: a page for albums, playlists and artists, playback for waves.
  V.openContext = (context, push = true) => {
    const go = push ? V.route.push : V.route.destination;
    if (context.kind === "album") go("album", { id: context.targetId, title: context.title });
    else if (context.kind === "artist") go("artist", { id: context.targetId, title: context.title });
    else if (context.kind === "playlist") go("playlist", { id: context.targetId, title: context.title, cover: context.cover, trackCount: 0 });
    else if (context.kind === "wave") P.startWave(context.seeds, context.title);
  };

  V.recentCard = (context) => h("button.recent-card", { onclick: () => V.openContext(context) },
    context.cover
      ? V.cover(context.cover, 300, context.kind === "artist" ? "round" : "")
      : h("div.recent-wave", V.icon("radiowaves")),
    h("div.ac-title", context.title),
    h("div.ac-sub", `> ${KIND_TITLES[context.kind] || context.kind}`));

  /// Up to `limit` distinct contexts from the newest history.
  V.recentContexts = (days, limit = 12) => {
    const seen = new Set();
    const out = [];
    for (const day of days) {
      for (const group of day.groups) {
        const context = group.context;
        if (!context || seen.has(context.id)) continue;
        seen.add(context.id);
        out.push(context);
        if (out.length >= limit) return out;
      }
    }
    return out;
  };

  /// `2026-11-03` → `сегодня` / `вчера` / `3 ноября`.
  function dayTitle(raw) {
    if (!raw) return "";
    const date = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(date.getTime())) return raw;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today - date) / 86400000);
    if (days === 0) return "сегодня";
    if (days === 1) return "вчера";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  // ---------- pages ----------
  const loaderPage = (load, render) => {
    const box = h("div.loader-box", V.loading());
    const run = async () => {
      box.replaceChildren(V.loading());
      try {
        box.replaceChildren(render(await load()));
      } catch (error) {
        box.replaceChildren(V.errorBanner(String(error), run));
      }
    };
    run();
    return box;
  };

  V.pages.history = () => loaderPage(() => V.invoke("history"), (days) => {
    const content = h("div.content", V.terminalHeader("История", "music-history"));
    if (!days.length) content.append(h("div.feed-empty", "> история пуста"));
    for (const day of days) {
      content.append(V.terminalLabel(dayTitle(day.date)));
      for (const group of day.groups) {
        if (group.context) {
          content.append(h("button.history-context", { onclick: () => V.openContext(group.context) },
            `// ${KIND_TITLES[group.context.kind] || group.context.kind}: ${group.context.title.toLowerCase()}`));
        }
        if (group.tracks.length) content.append(V.trackList(group.tracks));
      }
    }
    return content;
  });

  V.pages.similar = ({ track }) => loaderPage(() => V.invoke("similar_tracks", { trackId: track.id }), (tracks) => h("div.content",
    V.terminalHeader("Похожие", `на: ${V.fullTitle(track).toLowerCase()} — ${track.artists.toLowerCase()}`),
    V.terminalActions(() => P.play(tracks), () => P.play([...tracks].sort(() => Math.random() - 0.5))),
    tracks.length ? V.trackList(tracks) : h("div.feed-empty", "> похожих не нашлось")));

  V.pages.about = ({ track }) => {
    const credits = h("div", h("div.feed-empty", "> загружаю…"));
    V.invoke("credits", { trackId: track.id }).then((list) => {
      credits.replaceChildren(...(list.length
        ? list.map((c) => aboutRow(c.title.toLowerCase(), c.value))
        : [h("div.feed-empty", "> Яндекс не указал авторов")]));
    }).catch(() => credits.replaceChildren(h("div.feed-empty", "> Яндекс не указал авторов")));
    return h("div.content",
      h("div.about-head", V.cover(track.cover, 300, "about-cover"),
        h("div", h("div.about-title", V.fullTitle(track)), h("div.about-artist", track.artists.toLowerCase()))),
      V.terminalLabel("релиз"),
      track.albumId ? h("button.about-link", { onclick: () => V.route.destination("album", { id: track.albumId }) },
        aboutRow("альбом", track.albumTitle || "—")) : null,
      track.durationMs ? aboutRow("длительность", V.time(track.durationMs / 1000)) : null,
      aboutRow("id", track.id),
      V.terminalLabel("авторы"),
      credits);
  };

  function aboutRow(label, value) {
    return h("div.about-row", h("div.about-label", label), h("div.about-value", value));
  }

  V.pages.addToPlaylist = ({ track }) => loaderPage(() => V.invoke("playlists"), (playlists) => {
    const own = playlists.filter((p) => p.id.startsWith(`${V.session?.uid}:`));
    return h("div.content",
      V.terminalHeader("В плейлист", V.fullTitle(track).toLowerCase()),
      h("button.playlist-row.new-row", { onclick: async () => {
        const title = await V.prompt("Новый плейлист", "", "Создать");
        if (!title) return;
        try {
          const created = await V.invoke("create_playlist", { title, public: false });
          await V.invoke("add_to_playlist", { id: created.id, trackId: track.id, albumId: track.albumId ?? null });
          V.sheet.close();
          V.toast(`> добавлено в «${created.title}»`);
          V.libraryLoad?.();
        } catch (error) {
          V.emit("error", String(error));
        }
      } }, h("div.new-plus", V.icon("plus")), h("span", "новый плейлист")),
      ...own.map((playlist) => h("button.playlist-row", { onclick: async (event) => {
        const row = event.currentTarget;
        row.disabled = true;
        row.append(h("span.spinner.small"));
        try {
          await V.invoke("add_to_playlist", { id: playlist.id, trackId: track.id, albumId: track.albumId ?? null });
          V.sheet.close();
          V.toast(`> добавлено в «${playlist.title}»`);
        } catch (error) {
          row.disabled = false;
          row.lastChild.remove();
          V.emit("error", String(error));
        }
      } }, V.cover(playlist.cover, 100), h("span", playlist.title), h("span.dim", `${playlist.trackCount} трк`))));
  });

  // ---------- share card (ShareCard.swift) ----------
  const BLOCKS = Array.from(" ▁▂▃▄▅▆▇█");
  const POSTER_W = 1080, POSTER_H = 1350, PAD = 64;

  /// The spectrum at the moment of sharing as 32 block characters; a calm line when silent.
  function frozenBars() {
    const bands = V.levels.bands || [];
    const live = bands.some((b) => b > 0.02) && P.isPlaying;
    return Array.from({ length: 32 }, (_, i) => {
      if (!live) return BLOCKS[1];
      const x = (i / 31) * (bands.length - 1);
      const a = bands[Math.floor(x)] || 0, b = bands[Math.ceil(x)] || 0;
      const v = a + (b - a) * (x - Math.floor(x)) + (Math.random() - 0.5) * 0.12;
      return BLOCKS[Math.min(8, Math.max(1, Math.round(v * 8)))];
    }).join("");
  }

  /// Fits text to `width` by shrinking the font, at most `lines` lines; returns the lines.
  function fitText(ctx, text, family, size, minSize, width, lines) {
    for (let s = size; s >= minSize; s -= 2) {
      ctx.font = `${s}px ${family}`;
      const words = text.split(" ");
      const out = [];
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width <= width) line = next;
        else { out.push(line); line = word; }
      }
      out.push(line);
      if (out.length <= lines && out.every((l) => ctx.measureText(l).width <= width)) return { lines: out, size: s };
    }
    return { lines: [text], size: minSize };
  }

  async function renderPoster(track) {
    await document.fonts.load('84px "Unbounded"');
    const canvas = document.createElement("canvas");
    canvas.width = POSTER_W;
    canvas.height = POSTER_H;
    const ctx = canvas.getContext("2d");
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--acid").trim() || "#c6ff00";
    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, POSTER_W, POSTER_H);
    ctx.textBaseline = "top";

    ctx.fillStyle = accent;
    ctx.font = "bold 30px ui-monospace, Consolas, monospace";
    ctx.fillText("> c1ph0n1c | now playing", PAD, PAD);

    const side = 600, x = (POSTER_W - side) / 2, y = PAD + 30 + 44;
    try {
      const data = await V.coverData(V.coverSize(track.cover, 1000));
      if (data) {
        const image = await V.loadImage(data);
        ctx.drawImage(image, x, y, side, side);
      }
    } catch (_) {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(x, y, side, side);
    }
    ctx.strokeStyle = "rgba(255,255,255,.2)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, side, side);

    let ty = y + side + 56;
    ctx.fillStyle = "#fff";
    const artist = fitText(ctx, track.artists, '"Unbounded"', 84, 40, POSTER_W - PAD * 2, 2);
    ctx.font = `${artist.size}px "Unbounded"`;
    for (const line of artist.lines) { ctx.fillText(line, PAD, ty); ty += artist.size * 1.12; }

    ctx.fillStyle = "rgba(255,255,255,.7)";
    const title = fitText(ctx, V.fullTitle(track).toLowerCase(), "ui-monospace, Consolas, monospace", 38, 24, POSTER_W - PAD * 2, 2);
    ctx.font = `500 ${title.size}px ui-monospace, Consolas, monospace`;
    ty += 10;
    for (const line of title.lines) { ctx.fillText(line, PAD, ty); ty += title.size * 1.25; }

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.font = "40px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(frozenBars(), PAD, POSTER_H - PAD);
    ctx.globalAlpha = 1;
    return canvas;
  }

  V.openShareCard = async (track) => {
    const preview = h("div.card-preview", V.loading());
    const copyBtn = h("button.btn-acid", { disabled: true }, V.icon("share"), "СКОПИРОВАТЬ");
    const saveBtn = h("button.btn-outline", { disabled: true }, V.icon("listPlus"), "СОХРАНИТЬ");
    V.sheet.open(h("div.sheet-page.share-card",
      h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Готово"),
      preview,
      h("div.t-actions", copyBtn, saveBtn)));
    const canvas = await renderPoster(track);
    const url = canvas.toDataURL("image/png");
    preview.replaceChildren(h("img", { src: url, alt: "" }));
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    copyBtn.onclick = () => canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        V.toast("> карточка скопирована");
      } catch (_) {
        V.toast("> не получилось скопировать");
      }
    }, "image/png");
    saveBtn.onclick = () => {
      const name = `c1ph0n1c-${(track.artists + " " + track.title).replace(/[\\/:*?"<>|]+/g, "").slice(0, 60)}.png`;
      h("a", { href: url, download: name }).click();
    };
  };

  // ---------- idle mode ----------
  /// «Режим покоя»: the visualizer fills the screen, the controls shrink to three thin glyphs,
  /// the clock moves to the bottom. Click shows the close button for a moment; Esc leaves.
  V.openIdle = async () => {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    const canvas = h("canvas.viz.on");
    const viz = window.Visualizer ? window.Visualizer.create(canvas) : null;
    viz?.setEffect(V.vizEffect());
    viz?.setCalm(V.calm());
    viz?.setCover(V.coverImage || null);
    viz?.setAccent(V.accentRGB);
    viz?.setPlaying(P.isPlaying);

    const artist = h("div.idle-artist");
    const title = h("div.idle-title");
    const playBtn = h("button.idle-btn", { onclick: () => P.togglePlay() });
    const time = h("div.idle-time");
    const date = h("div.idle-date");
    const closeBtn = h("button.idle-close.glass", { title: "Закрыть", onclick: () => close() }, V.icon("xmark"));
    const layer = h("div.idle", canvas,
      // Scrims under the text and the clock so they read over the brightest glyphs.
      h("div.idle-scrim"),
      h("div.idle-center", h("div.idle-card", artist, title), h("div.idle-controls",
        h("button.idle-btn", { onclick: () => P.previous() }, V.glyph("previous", 16)),
        playBtn,
        h("button.idle-btn", { onclick: () => P.next() }, V.glyph("next", 16))),
        V.volumeControl(".idle-volume")),
      h("div.idle-clock", h("div.idle-clock-card", time, date)),
      closeBtn);

    function render() {
      const track = P.current;
      artist.textContent = track?.artistList?.[0]?.name || track?.artists || "волна";
      title.textContent = track ? V.fullTitle(track).toLowerCase() : "";
      playBtn.replaceChildren(V.glyph(P.isPlaying ? "pause" : "play", 22));
      viz?.setPlaying(P.isPlaying);
    }
    async function tick() {
      const now = new Date();
      time.textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      let line = now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
      try {
        const battery = await navigator.getBattery?.();
        if (battery && !battery.charging) line += ` | ${Math.round(battery.level * 100)}%`;
      } catch (_) { /* no battery info on this machine */ }
      date.textContent = line;
    }
    let closeTimer = null;
    function flashClose() {
      closeBtn.classList.add("on");
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => closeBtn.classList.remove("on"), 3000);
    }
    const offPlayer = V.on("player", render);
    const offLevels = V.on("levels", (l) => viz?.setLevels(l));
    const offTrack = V.on("track", () => setTimeout(() => viz?.setCover(V.coverImage || null), 600));
    const clock = setInterval(tick, 15000);
    const onKey = (e) => { if (e.key === "Escape") { e.stopImmediatePropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    layer.addEventListener("pointerdown", (e) => { if (!e.target.closest("button")) flashClose(); });

    function close() {
      offPlayer(); offLevels(); offTrack();
      clearInterval(clock);
      document.removeEventListener("keydown", onKey, true);
      appWindow?.setFullscreen(false).catch(V.logError);
      layer.classList.remove("on");
      document.body.classList.remove("has-idle");
      setTimeout(() => { viz?.dispose(); layer.remove(); }, 400);
    }

    render();
    tick();
    document.body.append(layer);
    document.body.classList.add("has-idle");
    requestAnimationFrame(() => layer.classList.add("on"));
    flashClose();
    appWindow?.setFullscreen(true).catch(V.logError);
  };
})(window.V);
