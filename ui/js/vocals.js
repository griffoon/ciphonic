// «Голос» (VocalSlider.swift): how much of the singer to keep, 100 % = original. The model is
// downloaded on first use; the Rust side separates the track ahead of the playhead and the
// player swaps in the version without the vocal wherever it is ready.
"use strict";

(function (V) {
  const { h } = V;
  /// 1 = original vocals, 0 = karaoke. Per session, like on iOS.
  let level = 1;
  let state = { installed: false, phase: "idle", progress: 0, message: "", speed: 0 };

  V.invoke("vocals_state").then((s) => { state = s; V.emit("vocals", state); }).catch(V.logError);
  V.listen("vocals", (event) => { state = event.payload; V.emit("vocals", state); });

  let asking = false;
  /// True when the model is there. Otherwise asks once to download it (the slider fires many
  /// input events while dragged, hence the guard); declining puts the voice back.
  async function ensureInstalled() {
    if (state.installed) return true;
    if (asking || state.phase === "installing") return false;
    asking = true;
    const ok = await V.ask("Отделение голоса",
      "Нужна модель Kim Vocal 2 и ONNX Runtime — около 80 МБ, скачаются один раз. Голос отделяется прямо на компьютере.",
      "Скачать");
    asking = false;
    if (!ok) {
      setLevel(1);
      return false;
    }
    V.invoke("vocals_install").catch((e) => V.emit("error", String(e)));
    return false;
  }

  function setLevel(value) {
    level = Math.min(1, Math.max(0, value));
    V.invoke("set_vocal_cut", { cut: 1 - level }).catch(V.logError);
    V.emit("vocal-level", level);
  }

  function status() {
    switch (state.phase) {
      case "installing": return `> скачиваю модель… ${Math.round(state.progress * 100)}%`;
      case "working": return state.message ? `> ${state.message}…` : `> отделяю голос… ${Math.round(state.progress * 100)}%`;
      case "ready": return "> голос отделён";
      case "failed": return `> ошибка: ${state.message}`;
      default:
        if (!state.installed) return "> двигай влево — скачаю модель";
        return level < 0.999 ? "> жду трек" : "> двигай влево, чтобы убрать голос";
    }
  }

  /// The slider row for the full player.
  V.vocalControl = () => {
    const input = h("input.vocal-range", { type: "range", min: "0", max: "1", step: "0.01", value: String(level), "aria-label": "Голос" });
    const statusEl = h("span.vocal-status");
    const valueEl = h("span.vocal-value");
    const speedEl = h("div.vocal-speed");
    const el = h("div.vocal",
      h("div.vocal-row", h("span.vocal-icon.off", V.icon("mic")), input, h("span.vocal-icon", V.icon("mic"))),
      h("div.vocal-line", statusEl, valueEl),
      speedEl);
    const render = () => {
      if (document.activeElement !== input) input.value = String(level);
      statusEl.textContent = status();
      statusEl.classList.toggle("failed", state.phase === "failed");
      valueEl.textContent = `голос ${Math.round(level * 100)}%`;
      speedEl.textContent = level < 0.999 && state.speed > 0
        ? `> x${state.speed.toFixed(1)} от скорости трека${state.speed < 1 ? " — не успевает, начало будет с голосом" : ""}`
        : "";
    };
    input.addEventListener("input", async () => {
      const value = Number(input.value);
      // The wish is kept while the model downloads; separation then starts from it.
      setLevel(value);
      render();
      if (value < 0.999 && !state.installed) {
        await ensureInstalled();
        render();
      }
    });
    input.addEventListener("dblclick", () => { setLevel(1); render(); });
    input.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setLevel(Math.round((level + (event.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100);
      render();
    }, { passive: false });
    V.onWhileAlive(el, "vocals", render);
    V.onWhileAlive(el, "vocal-level", render);
    render();
    return el;
  };

  V.vocalLevel = () => level;
})(window.V);
