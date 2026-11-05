// Search tab (SearchView.swift): recent queries, live suggestions, results by kind.
"use strict";

(function (V) {
  const { h } = V;
  /// Wait for the user to stop typing before hitting the API.
  const DEBOUNCE_MS = 350;
  const RECENT_LIMIT = 12;

  V.buildSearch = function buildSearch() {
    let recent = V.store.get("searchHistory", []);
    let timer = null;
    let token = 0;

    const input = h("input.search-input", { type: "search", placeholder: "Что послушаем?", spellcheck: "false", autocomplete: "off" });
    const clear = h("button.search-clear", { title: "Очистить", onclick: () => { input.value = ""; input.focus(); update(); } }, V.icon("xmark"));
    const field = h("div.search-field", V.icon("search"), input, clear);
    const suggestions = h("div.suggestions");
    const body = h("div.search-body");
    const content = h("div.content.search", h("div.large-title", "Поиск"), h("div.search-wrap", field, suggestions), body);

    function remember(text) {
      const clean = text.trim();
      if (clean.length < 2) return;
      recent = [clean, ...recent.filter((r) => r.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_LIMIT);
      V.store.set("searchHistory", recent);
    }

    function renderRecent() {
      if (!recent.length) {
        body.replaceChildren(h("div.search-empty", V.icon("search"), h("div", "Треки, артисты, альбомы, плейлисты")));
        return;
      }
      body.replaceChildren(
        h("div.section-head", V.terminalLabel("недавние"),
          h("button.link-acid", { onclick: () => { recent = []; V.store.set("searchHistory", []); renderRecent(); } }, "очистить")),
        ...recent.map((item) => h("div.recent-row",
          h("button.recent-text", { onclick: () => { input.value = item; update(true); } }, V.icon("clock"), h("span", item)),
          h("button.recent-remove", {
            title: "Убрать",
            onclick: () => { recent = recent.filter((r) => r !== item); V.store.set("searchHistory", recent); renderRecent(); },
          }, V.icon("xmark")))));
    }

    function renderResults(result) {
      const sections = [];
      if (result.artists.length) sections.push(V.terminalLabel("артисты"), V.shelf(result.artists.slice(0, 12).map(V.artistCard)));
      if (result.tracks.length) sections.push(V.terminalLabel("треки"), V.trackList(result.tracks));
      if (result.albums.length) sections.push(V.terminalLabel("альбомы"), V.shelf(result.albums.slice(0, 12).map(V.albumCard)));
      if (result.playlists.length) {
        sections.push(V.terminalLabel("плейлисты"), ...result.playlists.slice(0, 8).map((p) =>
          h("button.playlist-row", { onclick: () => V.route.push("playlist", { ...p }) },
            V.cover(p.cover, 100), h("span", p.title), h("span.dim", `${p.trackCount} трк`))));
      }
      body.replaceChildren(...(sections.length ? sections : [h("div.search-empty", h("div", "Ничего не нашлось"))]));
    }

    async function run(text, mine) {
      try {
        const [result, hints] = await Promise.all([
          V.invoke("search", { text }),
          text.length >= 2 ? V.invoke("search_suggest", { part: text }).catch(() => []) : Promise.resolve([]),
        ]);
        if (mine !== token) return;
        renderResults(result);
        renderSuggestions(hints.filter((s) => s.toLowerCase() !== text.toLowerCase()).slice(0, 6));
      } catch (error) {
        if (mine !== token) return;
        body.replaceChildren(V.errorBanner(String(error), () => update(true)));
      }
    }

    function renderSuggestions(list) {
      suggestions.replaceChildren(...list.map((s) => h("button.suggestion", {
        onclick: () => { input.value = s; remember(s); update(true); },
      }, V.icon("search"), h("span", s))));
      suggestions.classList.toggle("on", list.length > 0 && document.activeElement === input);
    }

    function update(now = false) {
      const text = input.value.trim();
      field.classList.toggle("has-text", Boolean(text));
      clearTimeout(timer);
      const mine = ++token;
      if (!text) {
        suggestions.classList.remove("on");
        renderRecent();
        return;
      }
      timer = setTimeout(() => run(text, mine), now ? 0 : DEBOUNCE_MS);
    }

    input.addEventListener("input", () => update());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        remember(input.value);
        suggestions.classList.remove("on");
        update(true);
      }
    });
    input.addEventListener("blur", () => setTimeout(() => suggestions.classList.remove("on"), 150));
    input.addEventListener("focus", () => suggestions.classList.toggle("on", suggestions.childElementCount > 0 && Boolean(input.value)));

    renderRecent();
    V.focusSearch = () => setTimeout(() => input.focus(), 60);
    return V.page(content);
  };
})(window.V);
