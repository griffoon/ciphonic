// Tuning My Wave on one screen (WaveSettingsView.swift): the smoke glows behind, the headline
// says what wave you'll get, sideways drums pick mood, character and language, activity
// waves sit below as chips.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  /// Width of one drum stop; the lit window is the same width.
  const SLOT = 140;

  V.openWaveSettings = function openWaveSettings() {
    let rows = [];
    const picks = {};
    const canvas = h("canvas.viz.on.ws-viz");
    const viz = window.Visualizer ? window.Visualizer.create(canvas) : null;
    viz?.setEffect(4);
    viz?.setCover(V.coverImage || null);
    viz?.setAccent(V.accentRGB);
    viz?.setPlaying(P.isPlaying);
    const offLevels = V.on("levels", (levels) => viz?.setLevels(levels));

    const summary = h("div.ws-summary", " ");
    const drums = h("div.ws-drums", V.loading());
    const stationsHost = h("div.ws-stations");
    const reset = h("button.ws-reset", { onclick: () => { for (const key of Object.keys(picks)) picks[key] = -1; drumEls.forEach((d) => d.set(-1)); renderSummary(); } },
      V.icon("refresh"), "Сбросить");
    const launch = h("button.ws-launch", { onclick: () => {
      const seeds = rows.map((row) => row.options[picks[row.key]]?.seed).filter(Boolean);
      P.setCharacterSeeds(seeds);
      V.sheet.close();
      P.startWave();
    } }, V.glyph("play", 16), h("span", "запустить"));
    let drumEls = [];

    const page = h("div.ws",
      canvas,
      h("div.ws-fade"),
      h("div.ws-column",
        h("div.ws-top", reset),
        h("div.ws-head", h("div.ws-kicker", "> моя волна будет"), summary),
        drums,
        stationsHost,
        launch));

    function renderSummary() {
      const parts = rows
        .map((row) => row.options[picks[row.key]]?.name?.toLowerCase())
        .filter(Boolean);
      const text = (parts.length ? parts.join(" | ") : "как обычно").toUpperCase();
      if (summary.textContent !== text) {
        summary.textContent = text;
        summary.animate([{ opacity: 0.2, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
          { duration: V.springs.snappy.ms, easing: V.springs.snappy.easing });
      }
    }

    function render(settings) {
      rows = settings.rows;
      const saved = new Set(P.characterSeeds);
      for (const row of rows) picks[row.key] = row.options.findIndex((o) => saved.has(o.seed));
      drumEls = rows.map((row) => drum(row, picks[row.key], (index) => { picks[row.key] = index; renderSummary(); }));
      drums.replaceChildren(...drumEls.map((d) => d.el));
      requestAnimationFrame(() => drumEls.forEach((d) => d.set(picks[d.key], false)));
      if (settings.stations.length) {
        stationsHost.replaceChildren(
          h("div.ws-kicker", "> или сразу под занятие"),
          h("div.ws-chips", settings.stations.map((station) => h("button.ws-chip", {
            onclick: () => { V.sheet.close(); P.startWave([station.seed], station.name); },
          }, V.icon("radiowaves"), station.name.toLowerCase()))));
      }
      renderSummary();
    }

    V.invoke("wave_settings").then(render).catch((error) => drums.replaceChildren(V.errorBanner(String(error), () => {
      V.sheet.close();
      V.openWaveSettings();
    })));

    V.sheet.open(page, { cls: "ws-sheet", onClose: () => { offLevels(); viz?.dispose(); } });
  };

  /// One setting as a sideways drum: options slide under a lit window in the middle and what
  /// stops in the window is the pick. «любое» is always the first stop.
  function drum(row, selected, onChange) {
    const names = ["любое", ...row.options.map((o) => o.name.toLowerCase())];
    const items = names.map((name, i) => h("button.drum-item", { onclick: () => set(i - 1) }, name));
    const strip = h("div.drum-strip", items);
    const el = h("div.drum",
      h("div.drum-head", h("span.drum-title", row.title.toUpperCase()), h("span.drum-hint", "← свайп →")),
      h("div.drum-body", h("div.drum-window"), strip));
    let current = selected;
    let settleTimer = null;

    function style() {
      const position = strip.scrollLeft / SLOT;
      items.forEach((item, i) => {
        const distance = Math.min(Math.abs(i - position), 1);
        item.style.opacity = String(1 - distance * 0.55);
        item.style.transform = `scale(${1 - distance * 0.12})`;
        item.style.filter = `blur(${Math.abs(i - position) * 1.2}px)`;
        item.classList.toggle("picked", i === Math.round(position));
      });
    }

    function set(index, smooth = true) {
      strip.scrollTo({ left: (index + 1) * SLOT, behavior: smooth ? "smooth" : "instant" });
      if (!smooth) style();
    }

    strip.addEventListener("scroll", () => {
      style();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const index = Math.round(strip.scrollLeft / SLOT) - 1;
        if (index !== current) {
          current = index;
          onChange(index);
        }
      }, 90);
    }, { passive: true });

    // The mouse wheel turns the drum one stop at a time.
    strip.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      const index = Math.round(strip.scrollLeft / SLOT) - 1 + Math.sign(event.deltaY);
      set(Math.min(Math.max(index, -1), names.length - 2));
    }, { passive: false });

    // Dragging with the mouse spins it too; letting go snaps to the nearest stop.
    let dragX = null, startLeft = 0, moved = false;
    strip.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") return;
      dragX = event.clientX;
      startLeft = strip.scrollLeft;
      moved = false;
      strip.setPointerCapture(event.pointerId);
      strip.classList.add("dragging");
    });
    strip.addEventListener("pointermove", (event) => {
      if (dragX === null) return;
      if (Math.abs(event.clientX - dragX) > 4) moved = true;
      strip.scrollLeft = startLeft - (event.clientX - dragX);
    });
    strip.addEventListener("pointerup", () => {
      if (dragX === null) return;
      dragX = null;
      strip.classList.remove("dragging");
      if (moved) {
        set(Math.round(strip.scrollLeft / SLOT) - 1);
        // A drag is not a click on the item under the pointer.
        strip.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
      }
    });

    return { el, set, key: row.key };
  }
})(window.V);
