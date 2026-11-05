// Everything below the visualizer on the Wave tab (HomeSections.swift, HomeShelfViews.swift):
// generated playlists, news from the feed, new releases and the chart. Empty sections hide.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const CHART_PREVIEW = 10;
  const TRACK_PREVIEW = 5;
  const RELEASES_PAGE = 24;

  /// Yandex titles mix «вы» and «ты»; the app speaks informally, so they are brought to one voice.
  const SWAPS = [
    ["вы", "ты"], ["Вы", "Ты"], ["вам", "тебе"], ["Вам", "Тебе"], ["вас", "тебя"], ["Вас", "Тебя"],
    ["ваш", "твой"], ["ваша", "твоя"], ["ваше", "твоё"], ["ваши", "твои"], ["вашей", "твоей"],
    ["ваших", "твоих"], ["вашим", "твоим"], ["вашего", "твоего"],
    ["слушали", "слушал"], ["слышали", "слышал"], ["знали", "знал"], ["видели", "видел"],
    ["пропустили", "пропустил"], ["искали", "искал"], ["любите", "любишь"], ["слушаете", "слушаешь"],
    ["цените", "ценишь"], ["оцените", "оцени"], ["послушайте", "послушай"], ["попробуйте", "попробуй"],
    ["откройте", "открой"], ["включите", "включи"],
  ].map(([formal, casual]) => [new RegExp(`(?<![\\p{L}])${formal}(?![\\p{L}])`, "gu"), casual]);
  V.informal = (title) => (title ? SWAPS.reduce((text, [re, casual]) => text.replace(re, casual), title) : null);

  // ---------- cards (HomeSections.swift) ----------
  /// Monochrome in the accent colour, with the track count stamped on it.
  V.feedPlaylistCard = (playlist) => h("button.feed-pl", { onclick: () => V.route.push("playlist", { ...playlist }) },
    h("div.tinted", V.cover(playlist.cover, 400), h("span.feed-badge", `[${playlist.trackCount} трк]`)),
    h("div.feed-pl-title", playlist.title));

  // ---------- full-screen shelves ----------
  V.pages.grid = ({ title, caption, items, card }) => h("div.content",
    V.terminalHeader(title, caption),
    h("div.card-grid", items.map(card)));

  V.pages.tracks = ({ title, caption, tracks, numbered }) => h("div.content",
    V.terminalHeader(title, caption),
    V.terminalActions(() => P.play(tracks), () => P.play([...tracks].sort(() => Math.random() - 0.5))),
    V.trackList(tracks, { numbered }));

  /// Every new release, loaded page by page as you scroll.
  V.pages.releases = ({ ids, first }) => {
    let albums = [...first];
    let loading = false;
    const grid = h("div.card-grid", albums.map(V.albumCard));
    const more = h("div.more-line");
    const content = h("div.content", V.terminalHeader("Новые релизы", "landing3/new-releases"), grid, more);
    async function loadMore() {
      if (loading || albums.length >= ids.length) return;
      loading = true;
      more.textContent = "> догружаю…";
      try {
        const next = ids.slice(albums.length, albums.length + RELEASES_PAGE);
        const page = await V.invoke("albums", { ids: next });
        const known = new Set(albums.map((a) => a.id));
        const fresh = page.filter((a) => !known.has(a.id));
        albums = [...albums, ...fresh];
        grid.append(...fresh.map(V.albumCard));
        if (page.length === 0) albums.length = ids.length; // nothing more comes back: stop asking
      } catch (error) {
        V.logError(error);
      } finally {
        loading = false;
        more.textContent = "";
      }
    }
    // Load the next page when the end of the grid comes into view.
    const watcher = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: "400px" });
    watcher.observe(more);
    return content;
  };

  // ---------- the feed ----------
  V.buildFeed = function buildFeed() {
    let loading = false;
    let collapsed = new Set(V.store.get("homeCollapsed", []));
    const refreshIcon = V.icon("refresh");
    const refreshLabel = h("span", "обновить");
    const refresh = h("button.capsule-outline", { onclick: () => load(true) }, refreshIcon, refreshLabel);
    const body = h("div.feed-body", V.loading());
    const el = h("div.feed", h("div.feed-head", h("span.feed-kicker", "> рекомендации"), refresh), body);

    function toggle(title) {
      if (collapsed.has(title)) collapsed.delete(title); else collapsed.add(title);
      V.store.set("homeCollapsed", [...collapsed]);
    }

    /// Section title: the name opens the whole list, the chevron folds the shelf like a spoiler.
    function section(title, open, makeContent) {
      const content = makeContent();
      const box = h("div.feed-section", { "data-collapsed": collapsed.has(title) ? "1" : null });
      const chevron = h("button.fold", {
        title: collapsed.has(title) ? `Развернуть: ${title}` : `Свернуть: ${title}`,
        onclick: () => {
          toggle(title);
          const isCollapsed = collapsed.has(title);
          box.toggleAttribute("data-collapsed", isCollapsed);
          if (!isCollapsed) content.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
            { duration: V.springs.snappy.ms, easing: V.springs.snappy.easing });
        },
      }, V.icon("chevronDown"));
      box.append(
        h("div.feed-section-head",
          h("button.feed-open", { onclick: open }, V.terminalLabel(title), V.icon("arrowUpRight")),
          chevron),
        content);
      return box;
    }

    const shelfOf = (cards) => h("div.shelf.feed-shelf", cards);
    const pushGrid = (title, caption, items, card) => () => V.route.push("grid", { title, caption, items, card });
    const pushTracks = (title, caption, tracks, numbered = false) => () => V.route.push("tracks", { title, caption, tracks, numbered });

    function trackBlock(tracks, numbered) {
      return h("div.feed-tracks", tracks.map((track, i) => V.trackRow(track, numbered ? i + 1 : null, () => P.play(tracks, i))));
    }

    function render(home) {
      const sections = [];
      if (home.generated.length) {
        sections.push(section("собрано для тебя",
          pushGrid("Собрано для тебя", "feed | generated", home.generated, V.feedPlaylistCard),
          () => shelfOf(home.generated.map(V.feedPlaylistCard))));
      }
      for (const event of home.events) {
        const title = V.informal(event.title);
        if (event.albums.length) {
          sections.push(section((title || "новое у твоих артистов").toLowerCase(),
            pushGrid(title || "Новое у твоих артистов", null, event.albums, V.albumCard),
            () => shelfOf(event.albums.map(V.albumCard))));
        } else if (event.tracks.length) {
          sections.push(section((title || "для тебя").toLowerCase(),
            pushTracks(title || "Для тебя", null, event.tracks),
            () => trackBlock(event.tracks.slice(0, TRACK_PREVIEW), false)));
        } else if (event.artists.length) {
          sections.push(section((title || "артисты").toLowerCase(),
            pushGrid(title || "Артисты", null, event.artists, V.artistCard),
            () => shelfOf(event.artists.map(V.artistCard))));
        }
      }
      if (home.releases.length) {
        sections.push(section("новые релизы",
          () => V.route.push("releases", { ids: home.releaseIds, first: home.releases, title: "Новые релизы" }),
          () => shelfOf(home.releases.map(V.albumCard))));
      }
      if (home.chart.length) {
        sections.push(section("чарт",
          pushTracks("Чарт", `топ ${home.chart.length}`, home.chart, true),
          () => trackBlock(home.chart.slice(0, CHART_PREVIEW), true)));
      }
      body.replaceChildren(...(sections.length ? sections : [h("div.feed-empty", "> подборки не загрузились")]));
      // Keep the playing row marked as the track changes.
      const rows = V.$$(".track-row", body);
      const off = V.on("player", () => (body.isConnected ? rows.forEach((r) => r._mark?.()) : off()));
    }

    async function load(force = false) {
      if (loading) return;
      loading = true;
      refresh.disabled = true;
      refreshLabel.textContent = "обновляю…";
      refreshIcon.classList.add("spinning");
      if (force || !body.querySelector(".feed-section")) body.replaceChildren(V.loading());
      try {
        render(await V.invoke("home_feed"));
      } catch (error) {
        body.replaceChildren(h("div.feed-empty", "> подборки не загрузились"), V.errorBanner(String(error), () => load(true)));
      } finally {
        loading = false;
        refresh.disabled = false;
        refreshLabel.textContent = "обновить";
        refreshIcon.classList.remove("spinning");
      }
    }

    return { el, load };
  };
})(window.V);
