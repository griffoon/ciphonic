// Shared views (Components.swift), the context menu (TrackMenu), navigation stacks and sheets.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;

  // ---------- live audio levels ----------
  V.levels = { bands: [0, 0, 0, 0, 0, 0], beat: 0, playing: false };
  V.listen("levels", (event) => {
    const previousBeat = V.levels.beat;
    V.levels = event.payload;
    V.emit("levels", V.levels);
    if (V.levels.beat !== previousBeat) V.emit("kick", V.levels.kickStrength);
  });

  /// Elements showing `▁▂▃▅` bars; refreshed together ~15 times a second.
  const spectra = new Set();
  V.spectrum = (bars = 6, cls = "") => {
    const el = h(`span.spectrum${cls ? "." + cls : ""}`, V.spectrumText(null, bars, false));
    el._bars = bars;
    spectra.add(el);
    return el;
  };
  setInterval(() => {
    const live = P.isPlaying && V.levels.playing;
    for (const el of spectra) {
      if (!el.isConnected) { spectra.delete(el); continue; }
      el.textContent = V.spectrumText(V.levels.bands, el._bars, live);
    }
  }, 66);

  /// A cover that bumps on each kick (KickBounce).
  V.kickBounce = (el) => {
    V.on("kick", (strength) => {
      if (!el.isConnected || !P.isPlaying) return;
      el.animate(
        [{ transform: `scale(${1 + 0.035 * (0.5 + strength)})` }, { transform: "scale(1)" }],
        { duration: V.springs.bouncy.ms, easing: V.springs.bouncy.easing },
      );
    });
    return el;
  };

  // ---------- covers ----------
  V.cover = (url, px = 200, cls = "") => {
    const box = h(`div.cover${cls ? "." + cls : ""}`, h("span.cover-ph", "01"));
    if (url) {
      const img = h("img", { src: V.coverSize(url, px), alt: "", loading: "lazy", draggable: "false" });
      img.addEventListener("load", () => box.classList.add("loaded"));
      box.append(img);
    }
    return box;
  };

  // ---------- track rows (TrackRow + TrackList) ----------
  function trackRow(track, number, onPlay) {
    const isCurrent = () => P.current?.id === track.id;
    const lead = number !== null
      ? h("div.tr-num", String(number).padStart(2, "0"))
      : V.cover(track.cover, 100, "tr-cover");
    const title = h("div.tr-title", V.fullTitle(track));
    const row = h("div.track-row", {
      tabindex: "0",
      onclick: onPlay,
      oncontextmenu: (event) => { event.preventDefault(); V.menu.open(event, V.trackMenu(track)); },
      onkeydown: (event) => { if (event.key === "Enter") onPlay(); },
    },
      lead,
      h("div.tr-text", title, h("div.tr-artist", (track.artists || "").toLowerCase())),
      h("div.tr-time", track.durationMs ? V.time(track.durationMs / 1000) : ""),
      h("button.tr-more", {
        title: "Ещё",
        onclick: (event) => { event.stopPropagation(); V.menu.open(event.currentTarget, V.trackMenu(track)); },
      }, V.icon("ellipsis")),
    );
    if (track.available === false) row.classList.add("unavailable");
    const mark = () => {
      const on = isCurrent();
      row.classList.toggle("current", on);
      const existing = V.$(".tr-playing", row);
      if (on && !existing) {
        const host = number !== null ? lead : lead;
        host.append(V.spectrum(number !== null ? 2 : 3, "tr-playing"));
      } else if (!on && existing) {
        existing.remove();
      }
    };
    mark();
    row._mark = mark;
    return row;
  }
  V.trackRow = trackRow;

  /// Plays `tracks` starting from the clicked row.
  V.trackList = (tracks, { numbered = false } = {}) => {
    const list = h("div.track-list");
    const rows = tracks.map((track, i) => trackRow(track, numbered ? i + 1 : null, () => P.play(tracks, i)));
    list.append(...rows);
    const off = V.on("player", () => {
      if (!list.isConnected) return off();
      rows.forEach((row) => row._mark());
    });
    return list;
  };

  // ---------- terminal styling ----------
  V.terminalLabel = (text) => h("div.t-label", `// ${text}`);

  V.terminalHeader = (title, caption) => h("div.t-header",
    caption ? h("div.t-caption", `> ${caption}`) : null,
    h("div.t-title", title));

  V.terminalActions = (play, shuffle) => h("div.t-actions",
    h("button.btn-acid", { onclick: play }, V.glyph("play", 13), "СЛУШАТЬ"),
    h("button.btn-outline", { onclick: shuffle }, V.icon("shuffle"), "ВПЕРЕМЕШКУ"));

  /// Cover on the left, type tag and Dela title on the right, actions below (CollectionHeader).
  V.collectionHeader = ({ kind, title, subtitle, cover, play, shuffle }) => h("div.c-header",
    h("div.c-top",
      V.cover(cover, 400, "c-cover"),
      h("div.c-text",
        h("div.c-kind", `> type: ${kind}`),
        h("div.c-title", title),
        subtitle ? h("div.c-sub", subtitle.toLowerCase()) : null)),
    V.terminalActions(play, shuffle));

  V.errorBanner = (message, retry) => h("div.error-banner",
    h("div.eb-title", "Не загрузилось"),
    h("div.eb-text", message),
    retry ? h("button.btn-outline", { onclick: retry }, "Повторить") : null);

  V.loading = () => h("div.loading", h("span.spinner"));

  // ---------- toast ----------
  let toastTimer = null;
  V.toast = (text) => {
    let el = V.$("#toast");
    if (!el) {
      el = h("div.toast", { id: "toast" });
      document.body.append(el);
    }
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 1400);
  };

  // ---------- context menu ----------
  V.menu = {
    /// `at` is a mouse event or an element; items are {label, icon, action, destructive} or "-".
    open(at, items) {
      V.menu.close();
      const layer = h("div.menu-layer", { onmousedown: (e) => { if (e.target === layer) V.menu.close(); } });
      const menu = h("div.menu");
      for (const item of items) {
        if (item === "-") { menu.append(h("div.menu-sep")); continue; }
        if (item.header) { menu.append(h("div.menu-header", item.header)); continue; }
        menu.append(h(`button.menu-item${item.destructive ? ".destructive" : ""}`, {
          onclick: () => { V.menu.close(); item.action(); },
        }, h("span.menu-label", item.label), item.icon ? V.icon(item.icon) : null));
      }
      layer.append(menu);
      document.body.append(layer);
      const rect = at instanceof Event ? { left: at.clientX, top: at.clientY, width: 0, height: 0 } : at.getBoundingClientRect();
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let x = rect.left + (at instanceof Event ? 0 : rect.width - mw);
      let y = rect.top + (at instanceof Event ? 0 : rect.height + 6);
      x = Math.min(Math.max(8, x), innerWidth - mw - 8);
      if (y + mh > innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      menu.style.transformOrigin = `${(at instanceof Event ? at.clientX : rect.left + rect.width) - x}px ${(at instanceof Event ? at.clientY : rect.top) - y}px`;
      requestAnimationFrame(() => layer.classList.add("on"));
      V.menu._layer = layer;
    },
    close() {
      const layer = V.menu._layer;
      if (!layer) return;
      V.menu._layer = null;
      layer.classList.remove("on");
      setTimeout(() => layer.remove(), 180);
    },
  };

  /// Long-press actions shared by every track row and the player (TrackMenu.swift).
  V.trackMenu = (track) => {
    const liked = P.isLiked(track);
    const items = [
      { label: "Играть следующим", icon: "playNext", action: () => { P.playNext(track); V.toast("> следующим"); } },
      { label: "В конец очереди", icon: "playLast", action: () => { P.enqueue(track); V.toast("> в очереди"); } },
      "-",
      { label: "Волна по треку", icon: "radiowaves", action: () => P.startWave([`track:${track.id}`], "Волна по треку") },
      { label: liked ? "Убрать из любимых" : "Нравится", icon: liked ? "heartSlash" : "heart", action: () => P.toggleLike(track) },
      { label: "Не рекомендовать", icon: "thumbsDown", destructive: true, action: () => P.dislike(track) },
      "-",
    ];
    for (const artist of track.artistList || []) {
      items.push({ label: artist.name, icon: "mic", action: () => V.route.destination("artist", { id: artist.id, name: artist.name }) });
    }
    if (track.albumId) {
      items.push({ label: track.albumTitle || "Альбом", icon: "album", action: () => V.route.destination("album", { id: track.albumId }) });
    }
    return items;
  };

  // ---------- navigation stacks (one per tab) ----------
  /// A page with its own scroll and, when pushed, a back button in a top bar.
  V.page = (content, { back = false, title = "" } = {}) => {
    const scroll = h("div.page-scroll", content);
    const page = h("div.page", scroll);
    if (back) {
      page.append(h("div.page-bar",
        h("button.back", { onclick: () => V.nav.pop() }, V.icon("chevronLeft"), "Назад"),
        h("div.page-bar-title", title)));
      scroll.addEventListener("scroll", () => page.classList.toggle("scrolled", scroll.scrollTop > 8));
    }
    return page;
  };

  V.nav = {
    stacks: {},
    tab: "wave",
    host(tab) { return V.$(`.tab[data-tab="${tab}"] .stack`); },
    root(tab, page) {
      this.stacks[tab] = [page];
      this.host(tab).replaceChildren(page);
    },
    push(page, tab = this.tab) {
      const stack = this.stacks[tab];
      const below = stack[stack.length - 1];
      stack.push(page);
      page.classList.add("entering");
      this.host(tab).append(page);
      page.getBoundingClientRect();
      page.classList.remove("entering");
      below?.classList.add("behind");
    },
    pop(tab = this.tab) {
      const stack = this.stacks[tab];
      if (stack.length < 2) return false;
      const page = stack.pop();
      stack[stack.length - 1].classList.remove("behind");
      page.classList.add("entering");
      setTimeout(() => page.remove(), V.springs.sheet.ms);
      return true;
    },
    popToRoot(tab = this.tab) {
      while (this.pop(tab));
    },
  };

  // ---------- sheets ----------
  const sheets = [];
  V.sheet = {
    get top() { return sheets[sheets.length - 1] || null; },

    /// Opens content as a sheet from the bottom. `from` (a DOMRect) zooms it out of that spot,
    /// the way the full player grows out of the mini player.
    open(content, { cls = "", from = null, onClose = null } = {}) {
      const backdrop = h("div.sheet-backdrop", { onclick: () => V.sheet.close(sheet) });
      const grab = h("div.sheet-grab", { onclick: () => V.sheet.close(sheet) }, h("span.sheet-handle"));
      const body = h("div.sheet-body", content);
      const panel = h(`div.sheet-panel${cls ? "." + cls : ""}`, grab, body);
      const sheet = { backdrop, panel, body, onClose, from };
      document.body.append(backdrop, panel);
      sheets.push(sheet);
      document.body.classList.add("has-sheet");
      enableDrag(sheet, grab);

      if (from) {
        const to = panel.getBoundingClientRect();
        const sx = from.width / to.width, sy = from.height / to.height;
        panel.animate([
          { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`, borderRadius: "40px", opacity: 0.4 },
          { transform: "none", borderRadius: "var(--sheet-radius)", opacity: 1 },
        ], { duration: V.springs.sheet.ms, easing: V.springs.sheet.easing, fill: "backwards" });
        body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 80, easing: "ease-out", fill: "backwards" });
      } else {
        panel.animate([{ transform: "translateY(100%)" }, { transform: "none" }],
          { duration: V.springs.sheet.ms, easing: V.springs.sheet.easing });
      }
      requestAnimationFrame(() => backdrop.classList.add("on"));
      return sheet;
    },

    close(sheet = V.sheet.top) {
      if (!sheet || sheet.closing) return;
      sheet.closing = true;
      const index = sheets.indexOf(sheet);
      if (index >= 0) sheets.splice(index, 1);
      if (!sheets.length) document.body.classList.remove("has-sheet");
      sheet.backdrop.classList.remove("on");
      const current = getComputedStyle(sheet.panel).transform;
      const anim = sheet.panel.animate([
        { transform: current === "none" ? "translateY(0)" : current },
        { transform: "translateY(105%)" },
      ], { duration: V.springs.sheet.ms * 0.8, easing: V.springs.sheet.easing, fill: "forwards" });
      anim.onfinish = () => { sheet.panel.remove(); sheet.backdrop.remove(); };
      sheet.onClose?.();
    },

    closeAll() { [...sheets].reverse().forEach((s) => V.sheet.close(s)); },
  };

  /// Pull the sheet down by its grab area; past a third (or a flick) it closes, else springs back.
  function enableDrag(sheet, grab) {
    let startY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false;
    grab.addEventListener("pointerdown", (event) => {
      dragging = true;
      startY = lastY = event.clientY;
      lastT = performance.now();
      grab.setPointerCapture(event.pointerId);
      sheet.panel.style.transition = "none";
    });
    grab.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dy = Math.max(0, event.clientY - startY);
      const now = performance.now();
      velocity = (event.clientY - lastY) / Math.max(1, now - lastT);
      lastY = event.clientY;
      lastT = now;
      sheet.panel.style.transform = `translateY(${dy}px)`;
      if (dy > 4) grab._dragged = true;
    });
    const end = (event) => {
      if (!dragging) return;
      dragging = false;
      const dy = Math.max(0, event.clientY - startY);
      sheet.panel.style.transition = "";
      if (dy > sheet.panel.offsetHeight * 0.3 || velocity > 0.8) {
        V.sheet.close(sheet);
      } else {
        sheet.panel.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
          { duration: V.springs.bouncy.ms, easing: V.springs.bouncy.easing });
        sheet.panel.style.transform = "";
      }
      // A drag is not a click on the grab (which would close).
      if (grab._dragged) {
        grab._dragged = false;
        grab.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true, once: true });
      }
    };
    grab.addEventListener("pointerup", end);
    grab.addEventListener("pointercancel", end);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (V.menu._layer) return V.menu.close();
    if (V.sheet.top) return V.sheet.close();
    V.nav.pop();
  });
  document.addEventListener("mouseup", (event) => {
    // The mouse's back button goes back, like a browser.
    if (event.button === 3) V.nav.pop();
  });
})(window.V);
