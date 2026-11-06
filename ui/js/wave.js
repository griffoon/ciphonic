// Home: the music-reactive visualizer behind a terminal HUD and one acid play button (WaveView.swift).
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const MY_WAVE = "Моя волна";

  V.buildWave = function buildWave() {
    let characters = [];
    let lastWave = null;
    let showLog = false;

    const canvas = h("canvas.viz", { id: "viz" });
    V.viz = window.Visualizer ? window.Visualizer.create(canvas) : null;
    V.viz?.setEffect(V.vizEffect());
    V.viz?.setCalm(V.calm());
    V.on("calm", (on) => V.viz?.setCalm(on));
    const scrim = h("div.wave-scrim");

    // ---- toolbar: My Wave lives top-left, settings top-right ----
    const myWaveBtn = h("button.glass-pill.my-wave", {
      onclick: () => { P.startWave(); flash("> моя волна"); },
    }, V.icon("waveform"), h("span", "моя волна"));
    const settingsBtn = h("button.glass-round", { title: "Настройки", onclick: () => V.openSettings() }, V.icon("gear"));
    const tuneBtn = h("button.glass-round", { title: "Настроить волну", onclick: () => V.openWaveSettings() }, V.icon("sliders"));
    const idleBtn = h("button.glass-round", { title: "Режим покоя", onclick: () => V.openIdle() }, V.icon("expand"));
    const devicesBtn = h("button.glass-round", { title: "Устройства", onclick: () => V.route.destination("devices", {}) }, V.icon("speakerDevice"));
    const toolbar = h("div.wave-toolbar", h("div.wave-toolbar-left", myWaveBtn, tuneBtn), h("div.wave-toolbar-right", V.volumeControl(".glass.wave-vol"), idleBtn, devicesBtn, settingsBtn));
    // «на пк: трек» when another device plays and this one doesn't.
    const elsewhere = h("button.capsule-device", { onclick: () => V.route.destination("devices", {}) });
    function renderElsewhere() {
      const active = V.ynisonActive?.();
      const other = V.ynisonCurrent?.();
      const show = !P.isPlaying && active && other && !V.ynison.paused;
      elsewhere.hidden = !show;
      if (show) elsewhere.replaceChildren(V.icon("speakers"), `на ${active.title.toLowerCase()}: ${other.title.toLowerCase()}`);
      devicesBtn.replaceChildren(V.icon(V.ynison?.devices?.length ? "speakers" : "speakerDevice"));
    }
    V.on("ynison", renderElsewhere);
    V.on("player", renderElsewhere);
    // The screen's name where the Dynamic Island is on the phone.

    // ---- HUD ----
    const hudTag = h("div");
    const hudStream = h("div");
    const hudLog = h("div.hud-log");
    const readout = h("div.hud-readout");
    const hud = h("button.hud", { onclick: () => { showLog = !showLog; renderHud(); } }, hudTag, hudStream, hudLog, readout);

    // ---- center ----
    const headline = h("button.wave-headline", { onclick: openArtist });
    const deckHost = h("div.wave-deck");
    const deck = V.coverDeck({ size: 280, onTap: () => V.openPlayer() });
    deckHost.append(deck);
    const dislikeBtn = h("button.round-btn", { title: "Не рекомендовать", onclick: () => {
      const track = P.current;
      if (!track) return;
      P.dislike(track);
      flash(`> dislike: ${track.title.toLowerCase()}`);
    } }, V.icon("heartSlash"));
    const pill = scrubPill();
    const likeBtn = h("button.round-btn", { title: "Нравится", onclick: () => P.toggleLike(P.current) });
    const moreBtn = h("button.round-btn", { title: "Ещё", onclick: (e) => P.current && V.menu.open(e.currentTarget, V.trackMenu(P.current)) }, V.icon("ellipsis"));
    const trackBar = h("div.track-bar", dislikeBtn, pill.el, likeBtn, moreBtn);

    const prevBtn = h("button.ring.big", { title: "Предыдущий трек", onclick: () => P.goBack() }, V.glyph("previous", 16));
    const playBtn = h("button.play-pulse", { onclick: () => (P.current ? P.togglePlay() : P.startWave()) });
    const nextBtn = h("button.ring.big", { title: "Следующий трек", onclick: () => P.next() }, V.glyph("next", 16));
    const transport = h("div.transport", prevBtn, playBtn, nextBtn);
    // On the Wave screen the mini player is away: the wheel over the controls sets the volume.
    transport.addEventListener("wheel", (event) => {
      event.preventDefault();
      V.nudgeVolume(event.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: false });
    transport.title = "Колесо мыши — громкость";

    const continueBtn = h("button.capsule-acid", { onclick: () => lastWave && P.startWave(lastWave.seeds, lastWave.name || MY_WAVE) });
    const chips = h("div.chips");

    const center = h("div.wave-center", headline, deckHost, trackBar, transport, elsewhere, continueBtn, chips);
    elsewhere.hidden = true;
    const toast = h("div.wave-toast");

    // The hero fills the screen; the feed starts below its bottom edge and shows once you scroll.
    const feed = V.buildFeed();
    const hint = h("button.scroll-hint", { onclick: () => scrollTo(scroller.clientHeight - 80) },
      h("span", "подборки"), V.icon("chevronDown"));
    const hero = h("div.wave-hero", hud, center, hint);
    const feedHost = h("div.feed-host", feed.el);
    const scroller = h("div.wave-scroll", hero, feedHost);
    const page = h("div.page.wave-page", canvas, scrim, scroller, toolbar, toast);

    let cancelScroll = null;
    function scrollTo(y) {
      cancelScroll?.();
      cancelScroll = V.animateValue(scroller.scrollTop, y, 0.5, (v) => { scroller.scrollTop = v; });
    }
    /// Clicking the open Wave tab goes back to the top, like tapping the status bar.
    V.waveScrollTop = () => scrollTo(0);

    V.waveHeroFocused = true;
    scroller.addEventListener("scroll", () => {
      const y = scroller.scrollTop;
      // At the very top the mini player steps aside; as soon as you scroll it comes back.
      const focused = y <= 12;
      if (focused !== V.waveHeroFocused) {
        V.waveHeroFocused = focused;
        feedHost.classList.toggle("shown", !focused);
        V.emit("hero", focused);
      }
      // The visualizer only renders while the hero is on screen.
      canvas.classList.toggle("offscreen", y > scroller.clientHeight * 0.85);
      scrim.style.opacity = String(Math.max(0, 1 - y / scroller.clientHeight));
    }, { passive: true });

    // ---- behaviour ----
    let toastTimer = null;
    function flash(message) {
      toast.textContent = message;
      toast.classList.add("on");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("on"), 1400);
    }

    function openArtist() {
      const artist = P.current?.artistList?.[0];
      if (artist) V.route.destination("artist", { id: artist.id, name: artist.name });
    }

    const hasTrack = () => Boolean(P.current);
    const isMyWave = () => P.isWave && P.source.title === MY_WAVE;

    function renderHud() {
      hudTag.textContent = P.waveTag || "sess#---- | idle";
      hudStream.replaceChildren(`${P.stream ? V.streamLabel(P.stream) : "--"} | `, h("span.acid", P.isPlaying ? "buf 0.5s" : "paused"));
      const lines = showLog ? P.reportLog : P.reportLog.slice(-1);
      hudLog.replaceChildren(...(lines.length ? lines : [null]).map((line) => line === null
        ? h("div.dim", "> tx: —")
        : h(`div.${line.endsWith("ok") ? "acid" : "bad"}`, `> tx: ${line}`)));
      readout.hidden = !showLog;
      hud.classList.toggle("open", showLog);
    }

    const bar = (value) => {
      const filled = Math.round(Math.min(Math.max(value, 0), 1) * 12);
      return "█".repeat(filled) + "-".repeat(12 - filled);
    };
    setInterval(() => {
      if (!showLog || !readout.isConnected) return;
      const l = V.levels;
      readout.replaceChildren(
        h("div", `> fft: ${l.playing ? "live" : "idle"} | 2048 | 60 Hz`),
        h("div", `> бас ${bar(l.bass)} ${l.bassHit > 0.3 ? "◆" : "◇"}`),
        h("div", `> мид ${bar(l.mid)} ${l.midHit > 0.3 ? "◆" : "◇"}`),
        h("div", `> хай ${bar(l.high)} ${l.highHit > 0.3 ? "◆" : "◇"}`));
    }, 150);

    function renderCenter() {
      const track = P.current;
      const title = P.isWave && track ? P.source.title : MY_WAVE;
      // "Моя волна" until something plays, then the artist, the way Yandex does it.
      const text = track?.artistList?.[0]?.name || track?.artists || title;
      if (headline._text !== text) {
        headline._text = text;
        headline.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-in-out" });
        headline.textContent = text;
        headline.classList.toggle("long", text.length > 18);
      }
      page.classList.toggle("has-track", hasTrack());
      likeBtn.replaceChildren(V.icon(P.isLiked(track) ? "heartFill" : "heart"));
      likeBtn.classList.toggle("liked", P.isLiked(track));
      pill.render();
      playBtn.replaceChildren(P.isLoading ? h("span.spinner.dark") : V.glyph(hasTrack() && P.isPlaying ? "pause" : "play", 30));
      playBtn.classList.toggle("playing", hasTrack() && P.isPlaying);
      prevBtn.disabled = !P.previousTrack;
      myWaveBtn.classList.toggle("on", isMyWave());
      myWaveBtn.querySelector(".icon").innerHTML = V.icons[isMyWave() ? "waveform" : "radiowaves"];
      continueBtn.hidden = hasTrack() || !lastWave;
      if (lastWave) {
        continueBtn.replaceChildren(V.icon("turnForward"), `продолжить: ${(lastWave.name || "прошлая волна").toLowerCase()}`);
      }
      renderChips();
      V.viz?.setPlaying(P.isPlaying);
    }

    function renderChips() {
      // The character picks only matter while My Wave itself plays.
      const show = hasTrack() && isMyWave() && characters.length;
      chips.hidden = !show;
      if (!show) return;
      const all = new Set(characters.map((c) => c.seed).filter(Boolean));
      const chosen = P.characterSeeds.filter((s) => all.has(s));
      chips.replaceChildren(...characters.map((option) => {
        const selected = option.seed ? chosen.includes(option.seed) : chosen.length === 0;
        return h(`button.chip${selected ? ".on" : ""}`, { onclick: () => pick(option) }, option.name.toLowerCase());
      }));
    }

    function pick(option) {
      const all = new Set(characters.map((c) => c.seed).filter(Boolean));
      const seeds = P.characterSeeds.filter((s) => !all.has(s));
      if (!option.unspecified && option.seed) seeds.push(option.seed);
      P.setCharacterSeeds(seeds);
      flash(`> seed: ${option.name.toLowerCase()}`);
      renderChips();
      if (P.isWave && P.current) P.startWave();
    }

    // Fit the cover to the height between the toolbar and the tab bar: the iOS rule (a third of
    // the screen, 160…280), but never more than what is left after the other rows.
    const OTHER_ROWS = 84 + 56 + 50 + 96 + 32 + 14 * 5 + 150;
    function resize() {
      const available = page.clientHeight;
      const room = available - OTHER_ROWS;
      const size = Math.max(120, Math.min(available * 0.34, 280, room));
      deck.style.height = `${size}px`;
      deck.firstChild.style.width = `${size}px`;
      deck.firstChild.style.height = `${size}px`;
      headline.style.fontSize = available < 640 ? "42px" : "50px";
    }
    new ResizeObserver(resize).observe(page);

    V.on("player", () => { renderCenter(); renderHud(); });
    V.on("log", renderHud);
    V.on("levels", (levels) => V.viz?.setLevels(levels));
    V.on("kick", (strength) => {
      if (!P.isPlaying || V.calm()) return;
      playBtn.animate([
        { transform: `scale(${1 + 0.06 * (0.6 + strength * 0.4)})`, boxShadow: "0 0 60px var(--acid-glow)" },
        { transform: "scale(1)", boxShadow: "0 0 20px var(--acid-glow)" },
      ], { duration: 220, easing: "ease-out" });
    });

    V.waveLoad = async () => {
      feed.load();
      try { characters = await V.invoke("wave_characters"); } catch (_) { characters = []; }
      try { lastWave = await V.invoke("wave_last"); } catch (_) { lastWave = null; }
      renderCenter();
    };

    renderCenter();
    renderHud();
    return page;
  };

  /// The title pill doubles as a seek bar: its fill shows how far the track is, dragging
  /// sideways scrubs (the title turns into the time), a click opens the full player.
  function scrubPill() {
    const fill = h("div.pill-fill");
    const label = h("div.pill-label");
    const el = h("div.scrub-pill", fill, label);
    let scrub = null, startX = 0, startFraction = 0, moved = false;

    const fraction = () => (P.duration > 0 ? Math.min(Math.max(P.liveElapsed() / P.duration, 0), 1) : 0);
    el.addEventListener("pointerdown", (event) => {
      if (!P.current) return;
      el.setPointerCapture(event.pointerId);
      startX = event.clientX;
      startFraction = fraction();
      moved = false;
    });
    el.addEventListener("pointermove", (event) => {
      if (!el.hasPointerCapture(event.pointerId) || P.duration <= 0) return;
      const dx = event.clientX - startX;
      if (!moved && Math.abs(dx) < 6) return;
      moved = true;
      scrub = Math.min(Math.max(startFraction + dx / el.clientWidth, 0), 1);
      el.classList.add("scrubbing");
      label.textContent = `${V.time(scrub * P.duration)} / ${V.time(P.duration)}`;
    });
    el.addEventListener("pointerup", () => {
      if (scrub !== null) P.seek(scrub * P.duration);
      else if (!moved && P.current) V.openPlayer();
      scrub = null;
      el.classList.remove("scrubbing");
      render();
    });

    function render() {
      if (scrub === null && P.current) V.scramble(label, V.fullTitle(P.current));
    }
    (function tick() {
      if (el.isConnected || !document.body.contains(el)) {
        fill.style.transform = `scaleX(${scrub ?? fraction()})`;
      }
      requestAnimationFrame(tick);
    })();
    return { el, render };
  }
})(window.V);
