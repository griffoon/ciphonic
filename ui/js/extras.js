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

  /// The clip: a real video when Yandex links one, otherwise a YouTube search to try.
  V.openClip = async (track) => {
    V.toast("> ищу клип…");
    try {
      const clip = await V.invoke("find_clip", { trackId: track.id, artist: track.artists, title: V.fullTitle(track) });
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

  // ---------- idle mode ----------
  /// «Режим покоя»: the visualizer fills the screen, the controls shrink to three thin glyphs,
  /// the clock moves to the bottom. Click shows the close button for a moment; Esc leaves.
  V.openIdle = async () => {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    const canvas = h("canvas.viz.on");
    const viz = window.Visualizer ? window.Visualizer.create(canvas) : null;
    viz?.setEffect(V.store.get("visualizerEffect", 1));
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
      h("div.idle-center", artist, title, h("div.idle-controls",
        h("button.idle-btn", { onclick: () => P.previous() }, V.glyph("previous", 16)),
        playBtn,
        h("button.idle-btn", { onclick: () => P.next() }, V.glyph("next", 16)))),
      h("div.idle-clock", time, date),
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
      setTimeout(() => { viz?.dispose(); layer.remove(); }, 400);
    }

    render();
    tick();
    document.body.append(layer);
    requestAnimationFrame(() => layer.classList.add("on"));
    flashClose();
    appWindow?.setFullscreen(true).catch(V.logError);
  };
})(window.V);
