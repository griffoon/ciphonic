// The artist page (ArtistView.swift): photo header with listeners and «подписаться», the bio,
// popular tracks, discography, compilations, concerts, similar artists and profile links.
"use strict";

(function (V) {
  const { h } = V;
  const P = V.player;
  const BIO_PREVIEW_LINES = 4;
  const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
  const PROFILE_ICONS = { youtube: "play", vk: "globe", telegram: "share", instagram: "album", x: "quote", tiktok: "waveform", site: "globe" };

  /// Artists the user follows; loaded once, kept in step with the subscribe button.
  let followed = null;
  async function followedArtists() {
    if (!followed) followed = new Set(await V.invoke("liked_artist_ids").catch(() => []));
    return followed;
  }

  /// Photos one after another; arrows and dots switch, like the pager on iOS.
  function photoPager(photos, fallback) {
    const list = photos.length ? photos : (fallback ? [fallback] : []);
    let index = 0;
    const img = h("img.ah-photo", { alt: "", draggable: "false" });
    const dots = h("div.ah-dots", list.map((_, i) => h(`span${i === 0 ? ".on" : ""}`)));
    const show = (next) => {
      index = (next + list.length) % list.length;
      img.src = V.coverSize(list[index], 1000);
      [...dots.children].forEach((d, i) => d.classList.toggle("on", i === index));
    };
    if (list.length) show(0);
    const nav = list.length > 1 ? [
      h("button.ah-prev", { title: "Назад", onclick: () => show(index - 1) }, V.icon("chevronLeft")),
      h("button.ah-next", { title: "Дальше", onclick: () => show(index + 1) }, V.icon("chevronLeft")),
      dots,
    ] : [];
    return h("div.ah-pager", list.length ? img : h("div.ah-blank"), ...nav);
  }

  function concertRow(concert) {
    const date = concert.datetime ? new Date(concert.datetime) : null;
    const valid = date && !Number.isNaN(date.getTime());
    const time = valid ? date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : null;
    return h("div.concert",
      h("div.concert-date",
        h("div.concert-day", valid ? String(date.getDate()) : "--"),
        h("div.concert-month", valid ? date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "") : "")),
      h("div.concert-text",
        h("div.concert-city", concert.city || concert.title || "Концерт"),
        h("div.concert-place", [concert.place, time].filter(Boolean).join(" | ").toLowerCase()),
        concert.afishaUrl ? h("button.link-acid", { onclick: () => V.invoke("open_url", { url: concert.afishaUrl }).catch((e) => V.emit("error", String(e))) }, "билеты на афише ›") : null));
  }

  V.artistPage = (page) => {
    const { artist, popular, albums, alsoAlbums, similar, description, monthlyListeners, likesCount, photos, links, concerts } = page;

    // ---- header over the photo ----
    const subscribe = h("button.subscribe");
    const renderSubscribe = (on) => {
      subscribe.classList.toggle("on", on);
      subscribe.replaceChildren(V.icon(on ? "heartFill" : "heart"), on ? "ТЫ ПОДПИСАН" : "ПОДПИСАТЬСЯ");
    };
    renderSubscribe(false);
    followedArtists().then((set) => renderSubscribe(set.has(artist.id)));
    subscribe.addEventListener("click", async () => {
      const set = await followedArtists();
      const on = !set.has(artist.id);
      if (on) set.add(artist.id); else set.delete(artist.id);
      renderSubscribe(on);
      try {
        await V.invoke("set_artist_like", { artistId: artist.id, liked: on });
      } catch (error) {
        if (on) set.delete(artist.id); else set.add(artist.id);
        renderSubscribe(!on);
        V.emit("error", String(error));
      }
    });

    const playAll = h("button.btn-acid", { onclick: async () => {
      playAll.lastChild.textContent = "ЗАГРУЖАЮ…";
      let tracks = await V.invoke("artist_tracks", { id: artist.id }).catch(() => []);
      if (!tracks.length) tracks = popular;
      playAll.lastChild.textContent = "ИГРАТЬ";
      if (tracks.length) P.play([...tracks].sort(() => Math.random() - 0.5));
    } }, V.icon("shuffle"), h("span", "ИГРАТЬ"));

    const stats = h("div.ah-stats",
      monthlyListeners ? h("span", V.icon("speaker"), `${compact.format(monthlyListeners)} слушателей за месяц`) : null,
      likesCount ? h("span", V.icon("heartFill"), compact.format(likesCount)) : null);

    const header = h("div.artist-hero",
      photoPager(photos, artist.cover),
      h("div.ah-scrim"),
      h("div.ah-content",
        stats,
        h("div.ah-name-row", h("div.ah-name", artist.name), subscribe),
        h("div.t-actions",
          playAll,
          h("button.btn-outline", { onclick: () => P.startWave([`artist:${artist.id}`], `Волна: ${artist.name}`) }, V.icon("radiowaves"), "ВОЛНА"))));

    // ---- bio ----
    const bio = description
      ? (() => {
        const text = h("div.bio-text", { style: { WebkitLineClamp: String(BIO_PREVIEW_LINES) } }, description);
        const more = h("button.link-acid", { onclick: () => {
          const open = text.classList.toggle("open");
          more.textContent = open ? "свернуть" : "читать дальше";
        } }, "читать дальше");
        return h("div.bio", text, more);
      })()
      : h("div.feed-empty", "> описание отсутствует");

    const section = (label, content) => (content ? [V.terminalLabel(label), content] : []);
    return h("div.artist-page",
      header,
      h("div.content.artist-body",
        V.terminalLabel("об артисте"), bio,
        ...section("популярное", popular.length ? V.trackList(popular.slice(0, 10), { numbered: true }) : null),
        ...section(`дискография | ${albums.length}`, albums.length ? V.shelf(albums.map(V.albumCard)) : null),
        ...section("сборники и участие", alsoAlbums.length ? V.shelf(alsoAlbums.map(V.albumCard)) : null),
        ...section(`концерты | ${concerts.length}`, concerts.length ? h("div", concerts.map(concertRow)) : null),
        ...section("похожие", similar.length ? V.shelf(similar.slice(0, 15).map(V.artistCard)) : null),
        ...section("профили", links.length ? h("div", links.map((link) =>
          h("button.panel-row.profile-row", { onclick: () => V.invoke("open_url", { url: link.url }).catch((e) => V.emit("error", String(e))) },
            V.icon(PROFILE_ICONS[link.kind] || "globe"), h("span", link.title), V.icon("arrowUpRight")))) : null)));
  };
})(window.V);
