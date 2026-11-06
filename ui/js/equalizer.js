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
      h("div.large-title", "Эквалайзер"),
      V.terminalLabel("пресеты"),
      presetRow,
      V.terminalLabel("полосы, дБ"),
      sliders,
      h("div.eq-hint", "> колесо мыши над полосой двигает её, двойной клик сбрасывает в 0"));
    V.sheet.open(page);
  };

  // The player starts flat: hand it the saved curve as soon as the page loads.
  if (V.eqIsOn()) V.invoke("set_eq", { gains: stored() }).catch(V.logError);
})(window.V);
