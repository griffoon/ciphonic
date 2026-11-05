// Collection tab and the catalogue pages it and Search push (LibraryView.swift, AlbumView,
// ArtistView), plus the router that opens them in a tab or as a sheet (Router.swift).
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;

  // ---------- router ----------
  V.route = {
    /// Push a page inside the current tab (NavigationLink).
    push(kind, args) {
      V.nav.push(V.page(V.pages[kind](args), { back: true, title: args?.title || "" }));
    },
    /// Open from a menu or the player: the player steps aside and the page comes up as a sheet.
    destination(kind, args) {
      V.sheet.closeAll();
      const close = h("button.sheet-close", { onclick: () => V.sheet.close() }, V.icon("xmark"), "Закрыть");
      setTimeout(() => V.sheet.open(h("div.sheet-page", close, V.pages[kind](args))), 120);
    },
  };

  /// Loads data into a container, showing a spinner and a retry banner on failure.
  function loader(load, render) {
    const box = h("div.loader-box", V.loading());
    const run = async () => {
      box.replaceChildren(V.loading());
      try {
        box.replaceChildren(render(await load()));
      } catch (error) {
        box.replaceChildren(V.errorBanner(String(error), run));
      }
    };
    run();
    return box;
  }

  const shuffled = (list) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  // ---------- pages ----------
  V.pages = {
    liked() {
      const header = V.terminalHeader("Мне нравится", "loading…");
      const actions = V.terminalActions(() => P.play(P.likedTracks), () => P.play(shuffled(P.likedTracks)));
      const listHost = h("div");
      const render = () => {
        header.querySelector(".t-caption").textContent = `> ${P.likedTracks.length} трк`;
        listHost.replaceChildren(P.likedTracks.length ? V.trackList(P.likedTracks) : V.loading());
      };
      render();
      const off = V.on("likes", () => (listHost.isConnected ? render() : off()));
      return h("div.content", header, actions, listHost);
    },

    playlist(playlist) {
      return loader(() => V.invoke("playlist_tracks", { id: playlist.id }), (tracks) => h("div.content",
        V.collectionHeader({
          kind: "playlist", title: playlist.title, subtitle: `${tracks.length} трк`, cover: playlist.cover,
          play: () => P.play(tracks), shuffle: () => P.play(shuffled(tracks)),
        }),
        V.trackList(tracks, { numbered: true })));
    },

    album({ id }) {
      return loader(() => V.invoke("album", { id }), ({ album, tracks }) => h("div.content",
        V.collectionHeader({
          kind: "album", title: album.title,
          subtitle: [album.artists, album.year].filter(Boolean).join(" | "), cover: album.cover,
          play: () => P.play(tracks), shuffle: () => P.play(shuffled(tracks)),
        }),
        V.trackList(tracks, { numbered: true })));
    },

    artist({ id }) {
      return loader(() => V.invoke("artist", { id }), ({ artist, popular, albums }) => h("div.content",
        h("div.artist-head",
          V.cover(artist.cover, 400, "artist-photo"),
          h("div",
            h("div.c-kind", "> type: artist"),
            h("div.artist-name", artist.name))),
        h("div.t-actions",
          h("button.btn-acid", { onclick: () => P.startWave([`artist:${artist.id}`], `Волна: ${artist.name}`) }, V.icon("radiowaves"), "ВОЛНА АРТИСТА"),
          h("button.btn-outline", { onclick: () => P.play(popular) }, V.glyph("play", 12), "ПОПУЛЯРНОЕ")),
        popular.length ? V.terminalLabel("популярное") : null,
        V.trackList(popular.slice(0, 10)),
        albums.length ? V.terminalLabel(`релизы | ${albums.length}`) : null,
        V.shelf(albums.map(V.albumCard))));
    },
  };

  // ---------- cards ----------
  V.shelf = (items) => h("div.shelf", items);

  V.albumCard = (album) => h("button.album-card", { onclick: () => V.route.push("album", { id: album.id, title: album.title }) },
    V.cover(album.cover, 300),
    h("div.ac-title", album.title),
    h("div.ac-sub", [album.year, album.artists].filter(Boolean).join(" | ").toLowerCase()));

  V.artistCard = (artist) => h("button.artist-card", { onclick: () => V.route.push("artist", { id: artist.id, title: artist.name }) },
    V.cover(artist.cover, 300, "round"),
    h("div.ac-title", artist.name));

  /// A playlist as a playlist: its cover on a stack of sheets, the title and the count.
  V.playlistStack = (playlist) => h("button.pl-stack", { onclick: () => V.route.push("playlist", { ...playlist }) },
    h("div.pl-sheets", h("div.pl-sheet.d2"), h("div.pl-sheet.d1"), V.cover(playlist.cover, 400, "pl-cover")),
    h("div.pl-title", V.icon("list"), h("span", playlist.title)),
    h("div.pl-count", `${playlist.trackCount} трк`));

  // ---------- Collection tab ----------
  V.buildLibrary = function buildLibrary() {
    const kicker = h("div.lib-kicker");
    const stats = h("div.lib-stats");
    const header = h("div.lib-header", kicker, h("div.lib-title", "КОЛЛЕКЦИЯ"), stats);
    const wall = likedWall();
    const grid = h("div.pl-grid");
    const gridLabel = V.terminalLabel("плейлисты");
    let playlists = [];

    function renderStats() {
      kicker.textContent = `> ~/коллекция${V.session?.displayName ? ` | ${V.session.displayName.toLowerCase()}` : ""}`;
      const parts = [`${P.likedTracks.length} трк`];
      if (playlists.length) parts.push(`${playlists.length} плейл.`);
      stats.textContent = parts.join(" | ");
    }

    V.libraryLoad = async () => {
      renderStats();
      try {
        playlists = await V.invoke("playlists");
        gridLabel.textContent = `// плейлисты | ${playlists.length}`;
        grid.replaceChildren(...playlists.map(V.playlistStack));
      } catch (error) {
        grid.replaceChildren(V.errorBanner(String(error), V.libraryLoad));
      }
      renderStats();
    };
    V.on("likes", () => { renderStats(); wall.render(); });

    return V.page(h("div.content.library", header, wall.el, gridLabel, grid));
  };

  /// "Мне нравится": three rows of liked covers drifting past each other in grey, a huge count,
  /// play and shuffle at hand. Clicking the block opens the full list.
  function likedWall() {
    const rows = [h("div.drift"), h("div.drift"), h("div.drift")];
    const count = h("div.lw-count", "----");
    const playBtn = h("button.lw-play", { title: "Играть «Мне нравится»", onclick: (e) => { e.stopPropagation(); P.play(P.likedTracks); } }, V.icon("playSmall"));
    const shuffleBtn = h("button.lw-shuffle", { title: "Перемешать", onclick: (e) => { e.stopPropagation(); P.play(shuffled(P.likedTracks)); } }, V.icon("shuffle"));
    const el = h("button.liked-wall", { onclick: () => V.route.push("liked", { title: "Мне нравится" }) },
      h("div.lw-rows", ...rows),
      h("div.lw-fade"),
      h("div.lw-bottom",
        h("div", h("div.lw-label", "// мне нравится"), count, h("div.lw-unit", "треков")),
        h("div.lw-buttons", shuffleBtn, playBtn)));

    const speeds = [14, -10, 8];
    function render() {
      const tracks = P.likedTracks;
      count.textContent = tracks.length ? String(tracks.length) : "----";
      const sets = [tracks.slice(0, 12), tracks.slice(12, 24), tracks.slice(0, 12).reverse()];
      rows.forEach((row, i) => {
        const list = sets[i].length ? sets[i] : tracks.slice(0, 12);
        // Two copies back to back so the strip loops seamlessly.
        const strip = h("div.drift-strip", ...[...list, ...list].map((t) => V.cover(t.cover, 150, "tile")));
        const width = Math.max(list.length, 1) * 72;
        strip.style.setProperty("--w", `${width}px`);
        strip.style.animationDuration = `${width / Math.abs(speeds[i])}s`;
        strip.style.animationDirection = speeds[i] > 0 ? "normal" : "reverse";
        row.replaceChildren(strip);
      });
    }
    render();
    return { el, render };
  }
})(window.V);
