// Updates and the tray. The app checks GitHub for a newer release at start and every few hours;
// a thin line at the top offers it. After an update the first start shows «Что нового» from the
// changelog built into the exe. Tray menu actions arrive here because the UI owns the player.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
  const FIRST_CHECK_MS = 6000;

  // ---------- tray ----------
  V.closeToTray = () => V.store.get("closeToTray", true);
  V.setCloseToTray = (on) => {
    V.store.set("closeToTray", on);
    V.invoke("set_close_to_tray", { on }).catch(V.logError);
  };
  V.invoke("set_close_to_tray", { on: V.closeToTray() }).catch(V.logError);

  V.listen("tray", (event) => {
    if (event.payload === "toggle") P.current ? P.togglePlay() : P.startWave();
    if (event.payload === "next") P.next();
    if (event.payload === "previous") P.previous();
  });
  V.on("track", (track) => {
    const title = track ? `${track.artists} — ${V.fullTitle(track)}` : null;
    V.invoke("set_tray_track", { title }).catch(V.logError);
  });

  // ---------- «Что нового» after an update ----------
  function notesList(text) {
    // A bullet may wrap onto indented lines: glue them back to it.
    const bullets = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("- ")) bullets.push(line.slice(2));
      else if (line && !line.startsWith("#") && bullets.length && /^\s/.test(raw)) bullets[bullets.length - 1] += ` ${line}`;
    }
    const items = bullets.map((b) => h("li", b));
    return items.length ? h("ul.whats-new", ...items) : h("div.whats-new-empty", "> без подробностей");
  }

  V.openWhatsNew = async () => {
    try {
      const info = await V.invoke("whats_new");
      V.sheet.open(h("div.sheet-page",
        h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Закрыть"),
        h("div.large-title", "Что нового"),
        V.terminalLabel(`версия ${info.version}`),
        notesList(info.notes)));
    } catch (error) {
      V.logError(error);
    }
  };

  V.invoke("whats_new").then((info) => {
    const seen = V.store.get("seenVersion", null);
    V.appVersion = info.version;
    V.store.set("seenVersion", info.version);
    // Only after an update: a fresh install has nothing to compare with.
    if (seen && seen !== info.version) setTimeout(V.openWhatsNew, 1200);
  }).catch(V.logError);

  // ---------- the update line ----------
  let offer = null;
  let installing = false;
  const text = h("span.update-text");
  const goBtn = h("button.update-go", { onclick: () => install() }, "обновить");
  const notesBtn = h("button.update-link", { onclick: () => offer && openOfferNotes() }, "что нового");
  const laterBtn = h("button.update-link", { onclick: () => { if (offer) V.store.set("skippedVersion", offer.version); hide(); } }, "позже");
  const bar = h("div.update-bar", { role: "status" }, text, goBtn, notesBtn, laterBtn);

  function show() {
    if (!bar.isConnected) document.body.append(bar);
    requestAnimationFrame(() => bar.classList.add("on"));
  }
  function hide() {
    bar.classList.remove("on");
  }
  function render() {
    if (!offer) return;
    const mb = (offer.size / 1048576).toFixed(1);
    text.textContent = `> доступна ${offer.version} (у тебя ${offer.current}) | ${mb} МБ`;
  }
  function openOfferNotes() {
    V.sheet.open(h("div.sheet-page",
      h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Закрыть"),
      h("div.large-title", `Версия ${offer.version}`),
      notesList(offer.notes.split("## Как запустить")[0]),
      h("button.choice", { onclick: () => { V.sheet.close(); install(); } },
        h("div", h("div.choice-title", "Обновить сейчас"), h("div.choice-sub", "скачаю, проверю контрольную сумму и перезапущусь")),
        h("span.choice-check", "→"))));
  }

  async function install() {
    if (installing || !offer) return;
    installing = true;
    goBtn.disabled = true;
    text.textContent = "> скачиваю… 0%";
    try {
      await V.invoke("install_update");
      text.textContent = "> перезапускаюсь…";
    } catch (error) {
      installing = false;
      goBtn.disabled = false;
      render();
      V.emit("error", `Не удалось обновиться: ${error}`);
    }
  }
  V.listen("update-progress", (event) => {
    if (installing) text.textContent = event.payload >= 1 ? "> ставлю…" : `> скачиваю… ${Math.round(event.payload * 100)}%`;
  });

  /// Asks GitHub for a newer version. `manual` also reports «уже последняя».
  V.checkForUpdate = async (manual = false) => {
    try {
      const found = await V.invoke("check_update");
      if (!found) {
        if (manual) V.toast("> у тебя последняя версия");
        return;
      }
      offer = found;
      render();
      if (manual || V.store.get("skippedVersion", null) !== found.version) show();
    } catch (error) {
      if (manual) V.emit("error", `Не удалось проверить обновления: ${error}`);
      else V.logError(error);
    }
  };
  V.autoUpdateCheck = () => V.store.get("autoUpdateCheck", true);

  setTimeout(() => { if (V.autoUpdateCheck()) V.checkForUpdate(); }, FIRST_CHECK_MS);
  setInterval(() => { if (V.autoUpdateCheck()) V.checkForUpdate(); }, CHECK_EVERY_MS);
})(window.V);
