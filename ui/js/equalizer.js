// Ten-band equalizer: presets on top, vertical sliders below. The gains live in local storage
// and go to the Rust player at start and on every change; flat means the filter is off.
"use strict";

(function (V) {
  const { h } = V;
  const LABELS = ["31", "62", "125", "250", "500", "1к", "2к", "4к", "8к", "16к"];
  const MAX_DB = 12;
  const PRESETS = [
    { id: "flat", title: "Обычный", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: "bass", title: "Больше баса", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    { id: "vocal", title: "Голос", gains: [-2, -2, -1, 0, 2, 4, 4, 3, 1, 0] },
    { id: "electro", title: "Электроника", gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
    { id: "rock", title: "Рок", gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
    { id: "night", title: "Ночью тише", gains: [-4, -3, -1, 0, 0, 0, 0, -2, -4, -6] },
  ];

  const stored = () => {
    const gains = V.store.get("eq", null);
    return Array.isArray(gains) && gains.length === LABELS.length ? gains.map(Number) : PRESETS[0].gains.slice();
  };

  let send = null;
  /// Sends the gains to the player at most once per animation frame while a slider is dragged.
  function apply(gains) {
    V.store.set("eq", gains);
    if (send) cancelAnimationFrame(send);
    send = requestAnimationFrame(() => {
      send = null;
      V.invoke("set_eq", { gains }).catch(V.logError);
    });
  }

  V.eqIsOn = () => stored().some((g) => Math.abs(g) > 0.05);

  // ---------- speed (nightcore / slowed) and the hall ----------
  const MOODS = [
    { id: "normal", title: "Как есть", speed: 1, reverb: 0 },
    { id: "nightcore", title: "Найткор", speed: 1.25, reverb: 0 },
    { id: "slowed", title: "Slowed", speed: 0.8, reverb: 0 },
    { id: "slowedReverb", title: "Slowed + reverb", speed: 0.8, reverb: 0.55 },
    { id: "hall", title: "Зал", speed: 1, reverb: 0.45 },
  ];
  const clampSpeed = (v) => Math.min(2, Math.max(0.5, Number(v) || 1));
  let speed = clampSpeed(V.store.get("speed", 1));
  let reverb = Math.min(1, Math.max(0, Number(V.store.get("reverb", 0)) || 0));

  function setSpeed(value) {
    speed = Math.round(clampSpeed(value) * 100) / 100;
    V.store.set("speed", speed);
    V.invoke("set_speed", { speed }).catch(V.logError);
    V.emit("sound-fx");
  }
  function setReverb(value) {
    reverb = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    V.store.set("reverb", reverb);
    V.invoke("set_reverb", { amount: reverb }).catch(V.logError);
    V.emit("sound-fx");
  }
  V.soundFxOn = () => speed !== 1 || reverb > 0;

  function fxSection() {
    const moods = h("div.eq-presets");
    const speedInput = h("input.fx-range", { type: "range", min: "0.5", max: "2", step: "0.01", value: String(speed), "aria-label": "Скорость" });
    const reverbInput = h("input.fx-range", { type: "range", min: "0", max: "1", step: "0.01", value: String(reverb), "aria-label": "Зал" });
    const speedValue = h("span.fx-value");
    const reverbValue = h("span.fx-value");
    const render = () => {
      const current = MOODS.find((m) => m.speed === speed && m.reverb === reverb)?.id;
      moods.replaceChildren(...MOODS.map((m) => h(`button.eq-preset${m.id === current ? ".on" : ""}`, {
        onclick: () => { setSpeed(m.speed); setReverb(m.reverb); render(); },
      }, m.title)));
      if (document.activeElement !== speedInput) speedInput.value = String(speed);
      if (document.activeElement !== reverbInput) reverbInput.value = String(reverb);
      speedValue.textContent = `x${speed.toFixed(2)}`;
      reverbValue.textContent = `${Math.round(reverb * 100)}%`;
    };
    // Speed restarts the buffer, so it is applied when the slider is let go, not on every step.
    speedInput.addEventListener("input", () => { speedValue.textContent = `x${Number(speedInput.value).toFixed(2)}`; });
    speedInput.addEventListener("change", () => { setSpeed(speedInput.value); render(); });
    speedInput.addEventListener("dblclick", () => { setSpeed(1); render(); });
    reverbInput.addEventListener("input", () => { setReverb(Number(reverbInput.value)); render(); });
    reverbInput.addEventListener("dblclick", () => { setReverb(0); render(); });
    render();
    return [
      V.terminalLabel("настроение"),
      moods,
      h("div.fx-row", h("span.fx-label", "скорость"), speedInput, speedValue),
      h("div.fx-row", h("span.fx-label", "зал"), reverbInput, reverbValue),
      h("div.eq-hint", "> скорость меняет и тон: быстрее — выше, медленнее — ниже. Двойной клик сбрасывает"),
    ];
  }

  V.openEqualizer = () => {
    let gains = stored();
    const presetRow = h("div.eq-presets");
    const sliders = h("div.eq-sliders");
    const inputs = [];
    const values = [];

    function presetId() {
      return PRESETS.find((p) => p.gains.every((g, i) => g === gains[i]))?.id || null;
    }
    function renderPresets() {
      const current = presetId();
      presetRow.replaceChildren(...PRESETS.map((preset) => h(`button.eq-preset${preset.id === current ? ".on" : ""}`, {
        onclick: () => setAll(preset.gains),
      }, preset.title)));
    }
    function renderValue(i) {
      const g = gains[i];
      values[i].textContent = g > 0 ? `+${g}` : String(g);
    }
    function setAll(next) {
      gains = next.slice();
      inputs.forEach((input, i) => { input.value = String(gains[i]); renderValue(i); });
      renderPresets();
      apply(gains);
    }

    LABELS.forEach((label, i) => {
      const input = h("input.eq-range", { type: "range", min: String(-MAX_DB), max: String(MAX_DB), step: "1", value: String(gains[i]), "aria-label": `${label} Гц` });
      input.addEventListener("input", () => {
        gains = gains.map((g, j) => (j === i ? Number(input.value) : g));
        renderValue(i);
        renderPresets();
        apply(gains);
      });
      input.addEventListener("dblclick", () => { input.value = "0"; input.dispatchEvent(new Event("input")); });
      input.addEventListener("wheel", (event) => {
        event.preventDefault();
        input.value = String(Math.min(MAX_DB, Math.max(-MAX_DB, Number(input.value) + (event.deltaY < 0 ? 1 : -1))));
        input.dispatchEvent(new Event("input"));
      }, { passive: false });
      const value = h("div.eq-value");
      inputs.push(input);
      values.push(value);
      sliders.append(h("div.eq-band", value, h("div.eq-slot", input), h("div.eq-label", label)));
      renderValue(i);
    });
    renderPresets();

    const page = h("div.sheet-page.eq",
      h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Закрыть"),
      h("div.large-title", "Звук"),
      ...fxSection(),
      V.terminalLabel("эквалайзер"),
      presetRow,
      V.terminalLabel("полосы, дБ"),
      sliders,
      h("div.eq-hint", "> колесо мыши над полосой двигает её, двойной клик сбрасывает в 0"));
    V.sheet.open(page);
  };

  // The player starts flat: hand it the saved curve as soon as the page loads.
  if (V.eqIsOn()) V.invoke("set_eq", { gains: stored() }).catch(V.logError);
  if (speed !== 1) V.invoke("set_speed", { speed }).catch(V.logError);
  if (reverb > 0) V.invoke("set_reverb", { amount: reverb }).catch(V.logError);
})(window.V);
