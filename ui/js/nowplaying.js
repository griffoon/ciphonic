// Mini player (tab bar accessory) and the full player sheet: PlayerViews.swift, LyricsView.swift,
// SwipeDeck.swift (CoverDeck) and AsciiCover.swift.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;

  // ---------- cover deck (CoverDeck) ----------
  /// The cover as a card: it follows the pointer with a slight tilt, the neighbour slides in
  /// from the side, and letting go past the threshold switches tracks.
  V.coverDeck = function coverDeck({ size = null, onTap = null, kick = 0.035 } = {}) {
    const GAP = 28, THRESHOLD = 0.28;
    const deck = h("div.deck");
    if (size) deck.style.height = `${size}px`;
    const stage = h("div.deck-stage");
    if (size) { stage.style.width = `${size}px`; stage.style.height = `${size}px`; }
    deck.append(stage);
    let card = null, peek = null, drag = 0, startX = 0, startY = 0, active = false, horizontal = null, lastX = 0, lastT = 0, velocity = 0;

    function makeCard(track, label) {
      const el = h("div.deck-card", V.cover(track?.cover, 600, "deck-cover"));
      if (label) el.append(h("div.deck-label", label));
      return el;
    }
    function render() {
      cancelSettle?.();
      cancelSettle = null;
      drag = 0;
      peek = null;
      stage.replaceChildren();
      card = makeCard(P.current, null);
      if (kick) V.kickBounce(card.firstChild, kick);
      stage.append(card);
      deck.classList.toggle("paused", !P.isPlaying);
    }
    function width() { return stage.offsetWidth || 300; }
    function layout() {
      const w = width();
      const progress = Math.min(Math.abs(drag) / w, 1);
      card.style.transform = `translateX(${drag}px) rotate(${(drag / w) * 7}deg) scale(${1 - 0.06 * progress})`;
      const want = drag < 0 ? P.nextTrack : drag > 0 ? P.previousTrack : null;
      if (want && (!peek || peek._id !== want.id)) {
        peek?.remove();
        peek = makeCard(want, drag < 0 ? "далее" : "назад");
        peek._id = want.id;
        stage.prepend(peek);
      } else if (!want && peek) {
        peek.remove();
        peek = null;
      }
      if (peek) {
        const x = drag < 0 ? drag + w + GAP : drag - w - GAP;
        peek.style.transform = `translateX(${x}px) scale(${0.9 + 0.1 * progress})`;
      }
    }
    let cancelSettle = null;
    /// Springs the card to `target`; only when it has landed does the switch happen and the
    /// deck reset, so a late frame can never drag the old card back out.
    function settle(target, then) {
      cancelSettle?.();
      cancelSettle = V.animateValue(drag, target, target === 0 ? 0.35 : 0.28, (value) => {
        drag = value;
        layout();
      }, () => {
        cancelSettle = null;
        drag = 0;
        peek?.remove();
        peek = null;
        if (card) card.style.transform = "";
        then?.();
      });
    }

    deck.addEventListener("pointerdown", (event) => {
      if (!P.current || cancelSettle) return;
      active = true;
      horizontal = null;
      startX = lastX = event.clientX;
      startY = event.clientY;
      lastT = performance.now();
      deck.setPointerCapture(event.pointerId);
    });
    deck.addEventListener("pointermove", (event) => {
      if (!active) return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      if (horizontal === null && Math.hypot(dx, dy) > 6) horizontal = Math.abs(dx) > Math.abs(dy);
      if (!horizontal) return;
      const now = performance.now();
      velocity = (event.clientX - lastX) / Math.max(1, now - lastT);
      lastX = event.clientX;
      lastT = now;
      // Resist when there is nothing on that side.
      const blocked = (dx < 0 && !P.nextTrack && !P.isWave) || (dx > 0 && !P.previousTrack);
      drag = blocked ? dx * 0.25 : dx;
      layout();
    });
    const release = () => {
      if (!active) return;
      active = false;
      if (horizontal !== true) {
        if (horizontal === null && onTap) onTap();
        return;
      }
      const w = width();
      const flick = velocity * 300;
      if ((drag < -w * THRESHOLD || flick < -w * 0.6) && (P.nextTrack || P.isWave)) {
        settle(-(w + GAP), () => P.next());
      } else if ((drag > w * THRESHOLD || flick > w * 0.6) && P.previousTrack) {
        settle(w + GAP, () => P.goBack());
      } else {
        settle(0);
      }
    };
    deck.addEventListener("pointerup", release);
    deck.addEventListener("pointercancel", release);

    // A real music video sits right on the cover (ClipBadge); only when one exists.
    const badge = h("button.clip-badge", { onclick: (e) => { e.stopPropagation(); if (P.current) V.openClip(P.current); } },
      V.icon("play"), "клип");
    badge.addEventListener("pointerdown", (e) => e.stopPropagation());
    badge.hidden = true;
    deck.append(badge);
    function checkClip() {
      const track = P.current;
      badge.hidden = true;
      if (!track || !V.clipFor) return;
      V.clipFor(track).then((clip) => { if (P.current?.id === track.id) badge.hidden = !clip.found; }).catch(() => {});
    }

    render();
    checkClip();
    const off = V.on("player", () => {
      if (!deck.isConnected) return off();
      const id = P.current?.id;
      if (id !== deck._shown) {
        deck._shown = id;
        checkClip();
        render();
        card.animate([{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "scale(1)" }],
          { duration: V.springs.spring.ms, easing: V.springs.spring.easing });
      }
      deck.classList.toggle("paused", !P.isPlaying);
    });
    deck._shown = P.current?.id;
    return deck;
  };

  // ---------- mini player ----------
  const mini = h("div.mini", { onclick: (e) => { if (!e.target.closest("button, input, .vol")) V.openPlayer(); } });
  const miniCover = h("div.mini-cover");
  const miniTitle = h("div.mini-title");
  const miniArtist = h("div.mini-artist");
  const miniPlay = h("button.mini-btn", { title: "Играть/пауза", onclick: () => P.togglePlay() });
  const miniNext = h("button.mini-btn", { title: "Дальше", onclick: () => P.next() }, V.glyph("next", 14));
  // Volume right in the mini player: the slider, or the mouse wheel anywhere over the bar.
  const miniVolumeBox = V.volumeControl(".mini-vol");
  mini.append(miniCover, h("div.mini-text", miniTitle, miniArtist), V.spectrum(6, "mini-spectrum"), miniVolumeBox, miniPlay, miniNext);
  mini.addEventListener("wheel", (event) => {
    event.preventDefault();
    V.nudgeVolume(event.deltaY < 0 ? 0.05 : -0.05);
  }, { passive: false });

  /// Changes the volume by `delta` and says where it landed.
  V.nudgeVolume = (delta) => {
    P.setVolume(Math.round((P.volume + delta) * 100) / 100);
    V.toast(`> громкость ${Math.round(P.volume * 100)}%`);
  };
  V.mini = mini;
  // Swipe up on the mini player opens the full player, like iOS.
  let miniStartY = null;
  mini.addEventListener("pointerdown", (e) => { miniStartY = e.target.closest("input, .vol") ? null : e.clientY; });
  mini.addEventListener("pointerup", (e) => {
    if (miniStartY !== null && miniStartY - e.clientY > 24) V.openPlayer();
    miniStartY = null;
  });

  function renderMini() {
    const track = P.current;
    if (miniCover._id !== track?.id) {
      miniCover._id = track?.id;
      miniCover.replaceChildren(V.cover(track?.cover, 100));
    }
    V.scramble(miniTitle, track ? V.fullTitle(track) : "Ничего не играет", 0.4);
    miniArtist.textContent = track?.artists || "";
    const glyph = P.isLoading ? h("span.spinner.small") : V.glyph(P.isPlaying ? "pause" : "play", 16);
    miniPlay.replaceChildren(glyph);
  }
  V.on("player", renderMini);
  renderMini();

  // ---------- ASCII cover backdrop (AsciiCover) ----------
  const ASCII_RAMP = [" ", " ", ".", "0", "1"];
  /// The cover redrawn as ` .01` glyphs, computed once per cover and size.
  async function asciiArt(track, columns, rows) {
    const data = await V.coverData(V.coverSize(track?.cover, 200));
    if (!data) return "";
    const image = await V.loadImage(data);
    // Glyph cells are about twice as tall as wide: sample a 2x taller source, crop to fill.
    const pixels = V.pixels(image, columns, rows);
    let lo = 255, hi = 0;
    const gray = new Array(columns * rows);
    for (let i = 0; i < gray.length; i++) {
      const v = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
      gray[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = Math.max(hi - lo, 1);
    let out = "";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const v = (gray[r * columns + c] - lo) / span;
        out += ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(Math.pow(v, 1.3) * ASCII_RAMP.length))];
      }
      out += "\n";
    }
    return out;
  }

  // ---------- terminal scrubber ----------
  function scrubber() {
    let dragging = null;
    const fill = h("div.scrub-fill");
    const marker = h("div.scrub-marker");
    const line = h("div.scrub-line", h("div.scrub-track"), fill, marker);
    const elapsed = h("span"), remaining = h("span");
    const el = h("div.scrubber", line, h("div.scrub-times", elapsed, remaining));
    const pick = (event) => {
      const rect = line.getBoundingClientRect();
      return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * Math.max(P.duration, 1);
    };
    line.addEventListener("pointerdown", (event) => {
      line.setPointerCapture(event.pointerId);
      dragging = pick(event);
      el.classList.add("dragging");
    });
    line.addEventListener("pointermove", (event) => { if (dragging !== null) dragging = pick(event); });
    const end = () => {
      if (dragging === null) return;
      P.seek(dragging);
      dragging = null;
      el.classList.remove("dragging");
    };
    line.addEventListener("pointerup", end);
    line.addEventListener("pointercancel", end);
    el._tick = () => {
      const total = Math.max(P.duration, 1);
      const shown = dragging ?? P.liveElapsed();
      const ratio = Math.min(Math.max(shown / total, 0), 1);
      fill.style.transform = `scaleX(${ratio})`;
      marker.style.left = `${ratio * 100}%`;
      elapsed.textContent = V.time(shown);
      remaining.textContent = `-${V.time(total - shown)}`;
    };
    return el;
  }

  // ---------- lyrics (LyricsView) ----------
  const FOLLOW_RESUME_MS = 3000;
  const INTRO_THRESHOLD = 4;
  const SOFT_EDGE = 4;

  function lyricsView() {
    const scroll = h("div.lyrics-scroll");
    const el = h("div.lyrics", scroll);
    let lines = [], els = [], active = -2, userScrolling = false, resumeTimer = null, cancelFollow = null, intro = null;
    let programmatic = false;

    function setContent(found) {
      lines = [];
      els = [];
      active = -2;
      intro = null;
      scroll.replaceChildren();
      if (found === undefined) { scroll.append(V.loading()); return; }
      if (!found) {
        scroll.append(h("div.lyrics-none", V.icon("quote"), h("div", "Текста нет")));
        return;
      }
      const column = h("div.lyrics-column");
      if (found.kind === "synced") {
        lines = found.lines;
        if (lines[0] && lines[0].time > INTRO_THRESHOLD) {
          intro = breakDots();
          column.append(intro);
        }
        els = lines.map((line) => {
          const isBreak = !line.text.trim();
          const lineEl = isBreak ? breakDots() : h("button.lyric", line.text);
          lineEl.classList.add("lyric-line");
          if (!isBreak) {
            lineEl.addEventListener("click", () => {
              P.seek(line.time);
              userScrolling = false;
              follow(lines.indexOf(line), true);
            });
          }
          lineEl._break = isBreak;
          column.append(lineEl);
          return lineEl;
        });
      } else {
        column.append(h("div.lyrics-plain", found.text));
      }
      if (found.writers?.length) column.append(h("div.lyrics-credit", `Авторы: ${found.writers.join(", ")}`));
      if (found.source && found.source !== "yandex") column.append(h("div.lyrics-credit", `текст: ${found.source}`));
      scroll.append(column);
    }

    function breakDots() {
      return h("div.break-dots", h("i"), h("i"), h("i"));
    }

    function follow(index, force = false) {
      const target = els[index];
      if (!target || (userScrolling && !force)) return;
      const to = target.offsetTop - scroll.clientHeight * 0.28;
      cancelFollow?.();
      programmatic = true;
      cancelFollow = V.animateValue(scroll.scrollTop, Math.max(0, to), 0.6, (v) => { scroll.scrollTop = v; });
      setTimeout(() => { programmatic = false; }, 700);
    }

    scroll.addEventListener("wheel", () => {
      userScrolling = true;
      cancelFollow?.();
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => { userScrolling = false; follow(active, true); }, FOLLOW_RESUME_MS);
    }, { passive: true });

    function progress(start, end, now) {
      if (end <= start) return now >= start ? 1 : 0;
      return Math.min(Math.max((now - start) / (end - start), 0), 1);
    }

    /// The active line fills character by character in reading order; the rest blur by distance.
    function tick() {
      if (!lines.length) return;
      const now = P.liveElapsed();
      let current = -1;
      for (let i = 0; i < lines.length; i++) { if (lines[i].time <= now) current = i; else break; }
      if (intro) {
        intro.classList.toggle("on", current === -1);
        lightDots(intro, progress(0, lines[0].time, now));
      }
      if (current !== active) {
        active = current;
        els.forEach((lineEl, i) => {
          lineEl.classList.toggle("active", i === current);
          lineEl.classList.toggle("past", i < current);
          const distance = Math.abs(i - current);
          lineEl.style.filter = userScrolling ? "" : `blur(${Math.min(distance * 0.9, 3.5)}px)`;
          if (i !== current && !lineEl._break && lineEl._swept) {
            lineEl.textContent = lines[i].text;
            lineEl._swept = false;
          }
        });
        follow(current);
      }
      if (current >= 0) {
        const lineEl = els[current];
        const end = lines[current + 1] ? lines[current + 1].time : lines[current].time + 5;
        const p = progress(lines[current].time, end, now);
        if (lineEl._break) lightDots(lineEl, p);
        else sweep(lineEl, lines[current].text, p);
      }
    }

    function lightDots(dots, p) {
      Array.from(dots.children).forEach((dot, i) => dot.classList.toggle("lit", p > i / 3));
    }

    function sweep(lineEl, text, p) {
      const chars = Array.from(text);
      if (!lineEl._swept) {
        lineEl.replaceChildren(...chars.map((c) => h("span", c)));
        lineEl._swept = true;
      }
      const lit = p * (chars.length + SOFT_EDGE);
      const spans = lineEl.children;
      for (let i = 0; i < spans.length; i++) {
        const amount = Math.min(Math.max((lit - i) / SOFT_EDGE, 0), 1);
        spans[i].style.opacity = String(0.3 + 0.7 * amount);
      }
    }

    el._set = setContent;
    el._tick = tick;
    el._scroll = scroll;
    void programmatic;
    return el;
  }

  // ---------- full player (NowPlayingView) ----------
  let player = null;

  V.openPlayer = () => {
    if (!P.current || player) return;
    player = buildPlayer();
    const from = V.mini.isConnected && V.mini.offsetParent ? V.mini.getBoundingClientRect() : null;
    player.sheet = V.sheet.open(player.root, { cls: "player-sheet", from, onClose: () => { player?.dispose(); player = null; } });
  };

  function buildPlayer() {
    let showLyrics = false;
    let chromeHidden = false;
    let hideTimer = null;
    const disposers = [];

    const backdropArt = h("pre.ascii-art");
    const backdrop = h("div.np-backdrop", backdropArt, h("div.np-fade"));

    const hudLabel = h("span.np-hud-label");
    const hud = h("div.np-hud", hudLabel, h("span.np-hud-space"), V.spectrum(6, "np-spectrum"));

    const deck = V.coverDeck({ kick: 0 });
    const deckWrap = h("div.np-deck", deck);

    const title = h("button.np-title", { onclick: () => P.current?.albumId && V.route.destination("album", { id: P.current.albumId }) });
    const artist = h("button.np-artist", { onclick: openArtist });
    const like = h("button.np-like", { title: "Нравится", onclick: () => P.toggleLike(P.current) });
    const titleRow = h("div.np-title-row", h("div.np-title-text", title, artist), like);

    const smallCover = h("div.np-small-cover");
    const lyrics = lyricsView();
    const lyricsHead = h("div.np-lyrics-head", smallCover);

    const scrub = scrubber();

    const shuffle = h("button.np-side", { title: "Перемешать", onclick: () => P.toggleShuffle() }, V.icon("shuffle"));
    const repeat = h("button.np-side", { title: "Повтор", onclick: () => P.cycleRepeat() });
    const play = h("button.np-play", { title: "Играть/пауза", onclick: () => P.togglePlay() });
    const controls = h("div.np-controls",
      shuffle,
      h("button.ring", { title: "Назад", onclick: () => P.previous() }, V.glyph("previous", 16)),
      play,
      h("button.ring", { title: "Дальше", onclick: () => P.next() }, V.glyph("next", 16)),
      repeat);

    const lyricsBtn = actionItem("quote", "текст", () => toggleLyrics());
    const queueBtn = actionItem("list", "очередь", () => openQueue());
    const eqBtn = actionItem("sliders", "экв.", () => V.openEqualizer());
    const sleepBtn = actionItem("moon", "сон", (event) => V.menu.open(event.currentTarget, sleepMenu()));
    controls.addEventListener("wheel", (event) => {
      event.preventDefault();
      V.nudgeVolume(event.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: false });
    const volumeRow = V.volumeControl(".np-vol");
    const actions = h("div.np-actions", h("div.np-action-row", lyricsBtn, queueBtn, eqBtn, sleepBtn), volumeRow,
      h("div.np-more-hint", V.icon("chevronDown")));

    const chrome = h("div.np-chrome", scrub, controls, actions);
    const page = h("div.np-page", hud, lyricsHead, deckWrap, titleRow, lyrics, chrome);
    const panel = h("div.np-panel");
    const scroll = h("div.np-scroll", page, panel);
    const root = h("div.np", backdrop, scroll);

    function actionItem(icon, label, onclick) {
      return h("button.np-action", { onclick }, V.icon(icon), h("span", label));
    }

    function openArtist() {
      const list = P.current?.artistList || [];
      if (list.length === 1) V.route.destination("artist", { id: list[0].id, name: list[0].name });
      else if (list.length > 1) {
        V.menu.open(artist, [{ header: "Исполнитель" }, ...list.map((a) => ({
          label: a.name, icon: "mic", action: () => V.route.destination("artist", { id: a.id, name: a.name }),
        }))]);
      }
    }

    function sleepMenu() {
      const items = [];
      if (P.sleepTimer) {
        items.push({ header: P.sleepTimer.kind === "end"
          ? "Выключится после трека"
          : `Выключится в ${new Date(P.sleepTimer.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` });
        items.push({ label: "Отменить таймер", icon: "xmark", destructive: true, action: () => P.setSleepTimer(null) });
        items.push("-");
      }
      items.push({ header: "Таймер сна" });
      for (const minutes of [15, 30, 45, 60, 90]) {
        items.push({ label: `${minutes} мин`, action: () => P.setSleepTimer({ kind: "at", at: Date.now() + minutes * 60000 }) });
      }
      items.push({ label: "В конце трека", icon: "clock", action: () => P.setSleepTimer({ kind: "end" }) });
      return items;
    }

    function toggleLyrics() {
      showLyrics = !showLyrics;
      root.classList.toggle("lyrics-on", showLyrics);
      // With lyrics the title sits beside a small cover; without, under the big one.
      if (showLyrics) lyricsHead.append(titleRow);
      else deckWrap.after(titleRow);
      revealChrome();
      // The cover glides between the big deck and the small thumbnail (matchedGeometryEffect).
      const from = (showLyrics ? deckWrap : smallCover).getBoundingClientRect();
      requestAnimationFrame(() => {
        const to = (showLyrics ? smallCover : deckWrap).getBoundingClientRect();
        const target = showLyrics ? smallCover : deckWrap;
        target.animate([
          { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / Math.max(to.width, 1)})`, transformOrigin: "top left" },
          { transform: "none", transformOrigin: "top left" },
        ], { duration: V.springs.soft.ms, easing: V.springs.soft.easing });
      });
      lyrics.animate([{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }],
        { duration: V.springs.soft.ms, easing: V.springs.soft.easing });
      lyricsBtn.classList.toggle("active", showLyrics);
      lyricsBtn.querySelector(".icon").innerHTML = V.icons[showLyrics ? "quoteFill" : "quote"];
      scroll.scrollTop = 0;
    }

    /// With lyrics open the controls step aside after a few quiet seconds; any movement brings them back.
    function revealChrome() {
      clearTimeout(hideTimer);
      if (chromeHidden) {
        chromeHidden = false;
        chrome.classList.remove("hidden");
      }
      if (!showLyrics) return;
      hideTimer = setTimeout(() => {
        if (!showLyrics) return;
        chromeHidden = true;
        chrome.classList.add("hidden");
      }, 4000);
    }
    root.addEventListener("pointermove", revealChrome);
    root.addEventListener("pointerdown", revealChrome);

    function openQueue() {
      const list = h("div.queue");
      const renderQueue = () => {
        list.replaceChildren();
        if (P.current) {
          list.append(V.terminalLabel("сейчас"), V.trackRow(P.current, null, () => {}));
        }
        list.append(V.terminalLabel(`далее | ${P.upNext.length}`));
        list.append(...P.upNext.map((track, offset) => V.trackRow(track, offset + 1, () => P.jump(P.index + 1 + offset))));
      };
      renderQueue();
      const off = V.on("player", () => (list.isConnected ? renderQueue() : off()));
      V.sheet.open(h("div.sheet-page", h("div.sheet-title", "Очередь"), list), { cls: "half" });
    }

    // Track actions under the player (TrackActionsPanel).
    function renderPanel() {
      const track = P.current;
      panel.replaceChildren();
      if (!track) return;
      const row = (label, icon, action, destructive) => h(`button.panel-row${destructive ? ".destructive" : ""}`, { onclick: action },
        V.icon(icon), h("span", label));
      panel.append(
        V.terminalLabel("трек"),
        row("Играть следующим", "playNext", () => { P.playNext(track); V.toast("> следующим"); }),
        row("В конец очереди", "playLast", () => { P.enqueue(track); V.toast("> в очереди"); }),
        row("Похожие треки", "album", () => V.route.destination("similar", { track })),
        row("Волна по треку", "radiowaves", () => P.startWave([`track:${track.id}`], "Волна по треку")),
        row("Добавить в плейлист", "listPlus", () => V.route.destination("addToPlaylist", { track })),
        row("Поделиться", "share", () => V.share(V.trackLink(track))),
        row("Найти клип", "play", () => V.openClip(track)),
        row("Карточка трека", "album", () => V.openShareCard(track)),
        row("О треке", "info", () => V.route.destination("about", { track })),
        V.terminalLabel("перейти"),
        ...(track.artistList || []).map((a) => row(a.name, "mic", () => V.route.destination("artist", { id: a.id, name: a.name }))),
        track.albumId ? row(track.albumTitle || "Альбом", "album", () => V.route.destination("album", { id: track.albumId })) : null,
        h("div.panel-gap"),
        row("Не рекомендовать", "thumbsDown", () => P.dislike(track), true),
      );
    }

    async function renderTrack() {
      const track = P.current;
      if (!track) { V.sheet.close(player?.sheet); return; }
      V.scramble(title, V.fullTitle(track));
      artist.textContent = (track.artists || "").toLowerCase();
      smallCover.replaceChildren(V.cover(track.cover, 200));
      renderPanel();
      lyrics._set(undefined);
      const id = track.id;
      V.invoke("get_lyrics", { trackId: track.id, title: track.title, artist: track.artists, durationMs: track.durationMs || 0 })
        .then((found) => { if (P.current?.id === id) lyrics._set(found); })
        .catch(() => { if (P.current?.id === id) lyrics._set(null); });
      const columns = 46;
      const rows = Math.max(10, Math.round(columns * (backdrop.clientHeight / Math.max(backdrop.clientWidth, 1)) / 2));
      asciiArt(track, columns, rows).then((art) => {
        if (P.current?.id !== id) return;
        backdropArt.textContent = art;
        backdropArt.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: "ease-in-out" });
      }).catch(() => { backdropArt.textContent = ""; });
    }

    function renderState() {
      const track = P.current;
      const label = P.stream ? `> ${V.streamLabel(P.stream).toLowerCase()}` : "> buffering…";
      hudLabel.textContent = label;
      like.innerHTML = V.icons[P.isLiked(track) ? "heartFill" : "heart"];
      like.classList.toggle("liked", P.isLiked(track));
      play.replaceChildren(P.isLoading ? h("span.spinner") : V.glyph(P.isPlaying ? "pause" : "play", 28));
      play.classList.toggle("is-paused", !P.isPlaying);
      shuffle.classList.toggle("active", P.isShuffled);
      shuffle.classList.toggle("gone", P.isWave);
      repeat.innerHTML = V.icons[P.repeatMode === "one" ? "repeatOne" : "repeat"];
      repeat.classList.toggle("active", P.repeatMode !== "off");
      sleepBtn.classList.toggle("active", Boolean(P.sleepTimer));
      sleepBtn.querySelector(".icon").innerHTML = V.icons[P.sleepTimer ? "moonFill" : "moon"];
      if (track?.id !== root._track) {
        root._track = track?.id;
        renderTrack();
      }
    }

    disposers.push(V.on("player", renderState));
    let frame = 0;
    const loop = () => {
      scrub._tick();
      lyrics._tick();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    disposers.push(() => cancelAnimationFrame(frame));
    renderState();

    return {
      root,
      dispose() { disposers.forEach((d) => d()); clearTimeout(hideTimer); },
    };
  }

  /// HUD line like `FLAC | 1411 kbps` (StreamSource.label).
  V.streamLabel = (stream) => {
    if (!stream) return "--";
    const name = stream.codec.replace("-mp4", "").toUpperCase();
    return stream.kbps ? `${name} | ${stream.kbps} kbps` : name;
  };
})(window.V);
