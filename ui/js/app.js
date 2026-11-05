// Boot, login (LoginView.swift), the tab bar with the mini player (RootView.swift), the accent
// that follows the cover (Theme.swift), and settings.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const ACID = [0.776, 1.0, 0.239];
  const QUALITIES = [
    { id: "lossless", title: "Lossless (FLAC)" },
    { id: "high", title: "Высокое (MP3 320)" },
    { id: "efficient", title: "Экономное (AAC)" },
  ];

  // ---------- accent (Theme.swift) ----------
  function setAccent(rgb) {
    V.accentRGB = rgb;
    const [r, g, b] = rgb.map((c) => Math.round(c * 255));
    document.documentElement.style.setProperty("--acid", `rgb(${r}, ${g}, ${b})`);
    document.documentElement.style.setProperty("--acid-rgb", `${r}, ${g}, ${b}`);
    V.viz?.setAccent(rgb);
  }

  let themeToken = 0;
  V.on("track", async (track) => {
    const mine = ++themeToken;
    try {
      const data = await V.coverData(V.coverSize(track?.cover, 400));
      if (!data || mine !== themeToken) return;
      const image = await V.loadImage(data);
      if (mine !== themeToken) return;
      V.coverImage = image;
      V.viz?.setCover(image);
      const follows = V.store.get("coverAccent", true);
      setAccent((follows && V.dominantAccent(V.pixels(image, 32, 32))) || ACID);
    } catch (error) {
      V.viz?.setCover(null);
      setAccent(ACID);
      V.logError(error);
    }
  });

  // ---------- login ----------
  function buildLogin() {
    const error = h("div.login-error");
    const button = h("button.login-btn", { onclick: async () => {
      button.disabled = true;
      error.textContent = "";
      try { await V.invoke("start_login"); } catch (e) { error.textContent = String(e); }
      button.disabled = false;
    } }, "Войти через Яндекс");
    const tokenInput = h("input.token-input", { type: "password", placeholder: "OAuth-токен", autocomplete: "off", spellcheck: "false" });
    const ok = h("button.glass-pill", { onclick: async () => {
      const token = tokenInput.value.trim();
      if (!token) return;
      error.textContent = "";
      try {
        const session = await V.invoke("login_with_token", { token });
        tokenInput.value = "";
        showSession(session);
      } catch (e) {
        error.textContent = String(e);
      }
    } }, "OK");
    const manual = h("details.manual", h("summary", "Вставить токен вручную"), h("div.manual-row", tokenInput, ok));
    return h("section.login",
      h("div.aurora", h("i"), h("i"), h("i"), h("i")),
      h("div.login-column",
        h("div.login-spacer"),
        h("div.login-icon", V.icon("waveform")),
        h("div.login-name", "Волна"),
        h("div.login-sub", "Только музыка. Ничего лишнего."),
        h("div.login-spacer"),
        button,
        manual,
        error));
  }

  // ---------- tabs and the mini player (RootView) ----------
  let built = false;
  let tab = "wave";

  function buildRoot() {
    const root = h("div.root",
      h("section.tab.on", { "data-tab": "wave" }, h("div.stack")),
      h("section.tab", { "data-tab": "library" }, h("div.stack")),
      h("section.tab", { "data-tab": "search" }, h("div.stack")));

    const pill = h("span.tab-pill");
    const tabButton = (id, icon, label) => h("button.tab-btn", { "data-tab": id, onclick: () => select(id) }, V.icon(icon), h("span", label));
    const tabbar = h("div.tabbar.glass", pill, tabButton("wave", "waveform", "Волна"), tabButton("library", "collection", "Коллекция"));
    const searchTab = h("button.search-tab.glass", { "data-tab": "search", title: "Поиск", onclick: () => select("search") }, V.icon("search"));
    const accessory = h("div.accessory.glass", V.mini);
    const dock = h("div.dock", accessory, h("div.tabbar-row", tabbar, searchTab));

    document.body.append(root, dock);
    V.nav.root("wave", V.buildWave());
    V.nav.root("library", V.buildLibrary());
    V.nav.root("search", V.buildSearch());

    function select(id) {
      // Clicking the open tab goes back to its first screen; on the Wave tab, back to the top.
      if (id === tab) {
        if (id === "wave" && V.nav.stacks.wave.length === 1) V.waveScrollTop?.();
        V.nav.popToRoot(id);
      }
      tab = id;
      V.nav.tab = id;
      V.$$(".tab", root).forEach((el) => el.classList.toggle("on", el.dataset.tab === id));
      V.$$("[data-tab]", dock).forEach((el) => el.classList.toggle("on", el.dataset.tab === id));
      movePill();
      V.$("#viz")?.classList.toggle("on", id === "wave");
      if (id === "search") V.focusSearch?.();
      syncAccessory();
    }

    /// The light pill slides under the selected tab; hidden when search is selected.
    function movePill() {
      const active = V.$(`.tab-btn[data-tab="${tab}"]`, tabbar);
      pill.classList.toggle("gone", !active);
      if (active) {
        pill.style.width = `${active.offsetWidth}px`;
        pill.style.transform = `translateX(${active.offsetLeft}px)`;
      }
    }

    /// Shown only once something played; it steps aside while the Wave hero sits at the top.
    function syncAccessory() {
      const onHero = tab === "wave" && V.nav.stacks.wave.length === 1 && V.waveHeroFocused;
      dock.classList.toggle("with-mini", Boolean(P.current) && !onHero);
    }
    V.on("player", syncAccessory);
    V.on("hero", syncAccessory);
    V.on("navigated", syncAccessory);
    new ResizeObserver(movePill).observe(tabbar);
    tab = null;
    select("wave");
  }

  // ---------- session ----------
  let loginEl = null;

  function showSession(session) {
    V.session = session;
    document.body.classList.toggle("signed-in", Boolean(session));
    if (!session) {
      if (!loginEl) {
        loginEl = buildLogin();
        document.body.append(loginEl);
      }
      return;
    }
    loginEl?.remove();
    loginEl = null;
    if (!built) {
      built = true;
      buildRoot();
    }
    P.startPolling();
    V.invoke("ynison_start").catch(V.logError);
    P.loadLikes().then(() => V.libraryLoad?.());
    V.libraryLoad?.();
    V.waveLoad?.();
  }

  V.listen("session-changed", (event) => showSession(event.payload));
  V.listen("login-error", (event) => {
    const el = V.$(".login-error");
    if (el) el.textContent = String(event.payload);
  });

  // ---------- settings ----------
  V.openSettings = () => {
    const quality = V.store.get("quality", "high");
    const effect = V.store.get("visualizerEffect", 1);
    const follows = V.store.get("coverAccent", true);
    const page = h("div.sheet-page.settings",
      h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Закрыть"),
      h("div.large-title", "Настройки"),
      h("div.settings-account", `> ${(V.session?.displayName || V.session?.login || "").toLowerCase()} | uid ${V.session?.uid || "?"}`),
      V.terminalLabel("качество"),
      h("div.choice-list", ...QUALITIES.map((q) => choice(q.title, null, q.id === quality, () => {
        V.store.set("quality", q.id);
        V.sheet.close();
        V.openSettings();
      }))),
      V.terminalLabel("фон волны"),
      h("div.choice-list", ...window.Visualizer.effects.map((fx, i) => choice(fx.title, fx.summary, i === effect, () => {
        V.store.set("visualizerEffect", i);
        V.viz?.setEffect(i);
        V.sheet.close();
        V.openSettings();
      }))),
      V.terminalLabel("цвет"),
      h("div.choice-list", choice("Цвет из обложки", "акцент берёт самый яркий цвет обложки", follows, () => {
        V.store.set("coverAccent", !follows);
        if (follows) setAccent(ACID); else V.emit("track", P.current);
        V.sheet.close();
        V.openSettings();
      })),
      h("button.logout", { onclick: async () => { V.sheet.closeAll(); await V.invoke("logout"); } }, "Выйти из аккаунта"));
    V.sheet.open(page);
  };

  function choice(title, subtitle, on, onclick) {
    return h(`button.choice${on ? ".on" : ""}`, { onclick },
      h("div", h("div.choice-title", title), subtitle ? h("div.choice-sub", subtitle) : null),
      h("span.choice-check", on ? "●" : "○"));
  }

  // ---------- errors (the iOS alert) ----------
  V.on("error", (message) => {
    const close = () => { layer.classList.remove("on"); setTimeout(() => layer.remove(), 200); };
    const layer = h("div.alert-layer", h("div.alert.glass", h("div.alert-title", "Ошибка"), h("div.alert-text", message),
      h("button.alert-ok", { onclick: close }, "OK")));
    document.body.append(layer);
    requestAnimationFrame(() => layer.classList.add("on"));
  });

  // ---------- keyboard ----------
  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest?.("input, textarea");
    if (typing || !V.session) return;
    if (event.code === "Space") { event.preventDefault(); P.togglePlay(); }
    if (event.key === "ArrowRight" && event.ctrlKey) P.next();
    if (event.key === "ArrowLeft" && event.ctrlKey) P.previous();
  });

  V.invoke("current_session")
    .then(showSession)
    .catch((error) => {
      showSession(null);
      const el = V.$(".login-error");
      if (el) el.textContent = String(error);
    });
})(window.V);
