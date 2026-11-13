// Other devices on the account through Ynison (DevicesView.swift): what plays where, remote
// controls, and pulling the track over here at the same second.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;

  V.ynison = { status: "idle", devices: [], activeDeviceId: null, queue: [], currentIndex: -1, paused: true, progressMs: 0, durationMs: 0, receivedAtMs: 0 };
  V.listen("ynison", (event) => {
    V.ynison = event.payload;
    V.emit("ynison", V.ynison);
  });

  const Y = () => V.ynison;
  V.ynisonCurrent = () => Y().queue[Y().currentIndex] || null;
  V.ynisonActive = () => Y().devices.find((d) => d.id === Y().activeDeviceId) || null;
  V.ynisonProgress = () => {
    const s = Y();
    const elapsed = s.paused ? 0 : Date.now() - s.receivedAtMs;
    return Math.min(s.durationMs, s.progressMs + elapsed) / 1000;
  };

  function deviceIcon(device) {
    const type = (device.kind || "").toUpperCase();
    if (type.includes("SMART_SPEAKER") || device.appName.toLowerCase().includes("station")) return "speakerDevice";
    if (type.includes("ANDROID") || type.includes("IOS") || type.includes("PHONE")) return "phone";
    if (type.includes("TV")) return "tv";
    if (type.includes("CAR")) return "car";
    return "desktop";
  }

  const statusLine = (status) => (status.startsWith("failed")
    ? `ynison: ${status.slice(8)}`
    : `ynison: ${{ idle: "offline", connecting: "connecting…", connected: "connected" }[status] || status}`);

  /// Plays the other device's queue here from the same track and second, then pauses it there.
  async function takeOver(button) {
    const s = Y();
    if (s.currentIndex < 0 || s.currentIndex >= s.queue.length) return;
    button.disabled = true;
    button.lastChild.textContent = "ЗАБИРАЮ…";
    try {
      const start = Math.max(0, s.currentIndex - 20);
      const end = Math.min(s.queue.length, s.currentIndex + 200);
      const refs = s.queue.slice(start, end).map((p) => (p.albumId ? `${p.trackId}:${p.albumId}` : p.trackId));
      const tracks = await V.invoke("tracks", { refs });
      if (!tracks.length) throw new Error("Треки не загрузились");
      const currentId = s.queue[s.currentIndex].trackId;
      const index = Math.max(0, tracks.findIndex((t) => t.id === currentId));
      P.play(tracks, index, V.ynisonProgress());
      await V.invoke("ynison_pause", { paused: true }).catch(V.logError);
      V.sheet.closeAll();
    } catch (error) {
      V.emit("error", String(error));
      button.disabled = false;
      button.lastChild.textContent = "ПОДХВАТИТЬ ЗДЕСЬ";
    }
  }

  V.pages.devices = () => {
    const root = h("div.content.devices");
    let progressFill = null;
    let times = null;

    function render() {
      const s = Y();
      const active = V.ynisonActive();
      const playing = V.ynisonCurrent();
      const parts = [V.terminalHeader("Устройства", statusLine(s.status))];
      if (active && playing) {
        progressFill = h("div.dev-fill");
        times = h("div.dev-times", h("span"), h("span"));
        const take = h("button.btn-acid.dev-take", { onclick: (e) => takeOver(e.currentTarget) }, V.icon("desktop"), h("span", "ПОДХВАТИТЬ ЗДЕСЬ"));
        parts.push(V.terminalLabel("сейчас играет"), h("div.dev-now",
          h("div.dev-top", V.cover(playing.coverUrl, 300, "dev-cover"),
            h("div", h("div.dev-where", `> ${active.title.toLowerCase()}`), h("div.dev-title", playing.title))),
          h("div.dev-bar", h("div.dev-track"), progressFill),
          times,
          h("div.dev-controls",
            h("button.dev-btn", { title: `Предыдущий трек на ${active.title}`, onclick: () => V.invoke("ynison_skip", { delta: -1 }).catch(V.logError) }, V.glyph("previous", 16)),
            h("button.dev-btn.ring-small", { title: s.paused ? "Играть" : "Пауза", onclick: () => V.invoke("ynison_pause", { paused: !Y().paused }).catch(V.logError) }, V.glyph(s.paused ? "play" : "pause", 18)),
            h("button.dev-btn", { title: `Следующий трек на ${active.title}`, onclick: () => V.invoke("ynison_skip", { delta: 1 }).catch(V.logError) }, V.glyph("next", 16))),
          take));
      } else {
        progressFill = null;
      }
      parts.push(V.terminalLabel(`в сети | ${s.devices.length}`));
      if (!s.devices.length) {
        parts.push(h("div.feed-empty", "> других устройств нет. Открой Яндекс Музыку на телефоне или Станции."));
      }
      for (const device of s.devices) {
        const isActive = device.id === s.activeDeviceId;
        parts.push(h(`div.dev-row${isActive ? ".active" : ""}`, V.icon(deviceIcon(device)),
          h("div", h("div.dev-name", device.title),
            h("div.dev-state", isActive ? "> активно" : device.isOffline ? "> не в сети" : "> в сети"))));
      }
      parts.push(h("div.dev-note", "C1PH0N1C подключается как пульт: видит и переключает музыку на других устройствах и умеет забрать её к себе. То, что играет здесь, другие устройства пока не видят."));
      root.replaceChildren(...parts);
    }

    function tick() {
      if (!root.isConnected) return;
      if (progressFill) {
        const total = Math.max(Y().durationMs / 1000, 1);
        const now = V.ynisonProgress();
        progressFill.style.transform = `scaleX(${Math.min(now / total, 1)})`;
        times.firstChild.textContent = V.time(now);
        times.lastChild.textContent = V.time(total);
      }
      setTimeout(tick, 1000);
    }

    render();
    const off = V.on("ynison", () => (root.isConnected ? render() : off()));
    setTimeout(tick, 0);
    return root;
  };
})(window.V);
