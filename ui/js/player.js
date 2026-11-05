// The playback brain, a port of PlayerEngine.swift + WaveSession.swift + Session likes.
// Rust plays the audio; this owns the queue, the order, and every report Yandex learns from.
"use strict";

(function (V) {
  const WAVE_FROM = "radio-mobile-user-onyourwave";
  const COLLECTION_FROM = "mobile-own_collection-default";
  const MY_WAVE = "Моя волна";
  const MAX_FAILURES = 4;
  const REFILL_THRESHOLD = 2;
  const LOG_LENGTH = 6;
  /// The analyzer readout and lyrics extrapolate between status polls at most this far.
  const MAX_EXTRAPOLATION = 1;

  const P = {
    queue: [],
    index: -1,
    /// { kind: "wave", title } or { kind: "list" }.
    source: { kind: "list" },
    isPlaying: false,
    isLoading: false,
    elapsed: 0,
    elapsedStamp: performance.now(),
    duration: 0,
    stream: null,
    repeatMode: "off",
    isShuffled: false,
    unshuffled: null,
    sleepTimer: null,
    reportLog: [],
    waveTag: null,
    errorMessage: null,
    volume: V.store.get("volume", 1),
    liked: new Set(),
    likedTracks: [],
    characterSeeds: V.store.get("waveSeeds", []),
  };
  V.player = P;

  let listen = null; // { track, playId, from }
  /// Where to start the next load (pulling a track from another device mid-way).
  let resumeAt = 0;
  let failures = 0;
  let loadToken = 0;
  let waveLoading = false;
  let endHandled = false;
  /// When the last load took effect; the old track's end flag is ignored right after it.
  let loadedAt = 0;
  const END_GRACE_MS = 800;
  let sleepTask = null;

  const changed = () => V.emit("player", P);

  Object.defineProperties(P, {
    current: { get: () => P.queue[P.index] || null },
    isWave: { get: () => P.source.kind === "wave" },
    nextTrack: { get: () => P.queue[P.index + 1] || null },
    previousTrack: { get: () => (P.index > 0 ? P.queue[P.index - 1] : null) },
    upNext: { get: () => P.queue.slice(P.index + 1) },
  });

  /// Elapsed time extrapolated between status polls, for smooth scrubbers and lyrics.
  P.liveElapsed = () => {
    if (!P.isPlaying || P.isLoading) return P.elapsed;
    return P.elapsed + Math.min((performance.now() - P.elapsedStamp) / 1000, MAX_EXTRAPOLATION);
  };

  function log(line) {
    P.reportLog = [...P.reportLog, line].slice(-LOG_LENGTH);
    V.emit("log", P.reportLog);
  }

  const describe = (error) => {
    const text = String(error);
    const code = text.match(/\d{3}/);
    if (text === "unauthorized") return "unauthorized";
    return code ? `http ${code[0]}` : "err";
  };

  // ---------- reports ----------
  function waveEvent(kind, track, played, label) {
    if (!P.isWave) return;
    V.invoke("wave_feedback", { kind, trackId: track.id, albumId: track.albumId ?? null, played: played || 0 })
      .then(() => log(`${label} | ok`))
      .catch((error) => log(`${label} | ${describe(error)}`));
  }

  function reportListen(played, position, label) {
    if (!listen) return;
    const { track, playId, from } = listen;
    V.invoke("report_listen", {
      trackId: track.id, albumId: track.albumId ?? null, durationMs: track.durationMs || 0,
      from, playId, played, position,
    })
      .then(() => label && log(`${label} | ok`))
      .catch((error) => log(`${label || "play-audio start"} | ${describe(error)}`));
  }

  function beginListen(track) {
    const playId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    listen = { track, playId, from: P.isWave ? WAVE_FROM : COLLECTION_FROM };
    reportListen(0, 0, null);
  }

  function endListen() {
    if (!listen) return;
    const elapsed = P.liveElapsed();
    reportListen(elapsed, elapsed, `play-audio ${Math.round(elapsed)}s`);
    listen = null;
  }

  /// Called whenever the current track is abandoned before its end.
  function reportSkipIfNeeded() {
    const track = P.current;
    const elapsed = P.liveElapsed();
    endListen();
    if (track && P.isWave) waveEvent("skip", track, elapsed, `skip ${elapsed.toFixed(1)}s`);
  }

  /// Gets the next track resolved and downloaded while this one plays, so switching is instant.
  function preloadNext() {
    const next = P.repeatMode === "one" ? null : P.nextTrack;
    if (!next || next.available === false) return;
    V.invoke("preload_track", { trackId: next.id, quality: V.store.get("quality", "high") })
      .catch((error) => log(`preload | ${describe(error)}`));
  }

  // ---------- loading ----------
  async function loadCurrent() {
    const track = P.current;
    if (!track) return;
    const token = ++loadToken;
    endHandled = false;
    P.isLoading = true;
    P.elapsed = 0;
    P.elapsedStamp = performance.now();
    P.duration = (track.durationMs || 0) / 1000;
    P.stream = null;
    changed();
    V.emit("track", track);
    try {
      const quality = V.store.get("quality", "high");
      const source = await V.invoke("play_track", { trackId: track.id, quality });
      if (token !== loadToken) return;
      P.stream = source;
      P.isLoading = false;
      P.isPlaying = true;
      P.elapsedStamp = performance.now();
      loadedAt = performance.now();
      failures = 0;
      if (resumeAt > 1) P.seek(resumeAt);
      resumeAt = 0;
      changed();
      if (P.isWave) waveEvent("trackStarted", track, 0, "trackStarted");
      beginListen(track);
      if (P.isWave && P.queue.length - P.index <= REFILL_THRESHOLD) refillWave(false);
      preloadNext();
      V.invoke("media_update", {
        title: V.fullTitle(track), artist: track.artists,
        cover: V.coverSize(track.cover, 400) || null, durationMs: track.durationMs || 0,
      }).catch(V.logError);
    } catch (error) {
      if (token !== loadToken) return;
      skipUnplayable(track, describe(error));
    }
  }

  /// A track that won't play is skipped quietly; only a run of failures interrupts the user.
  function skipUnplayable(track, reason) {
    P.isLoading = false;
    failures += 1;
    log(`skip «${track.title.toLowerCase()}» | ${reason}`);
    if (failures >= MAX_FAILURES) {
      failures = 0;
      P.isPlaying = false;
      P.errorMessage = `Подряд не играют ${MAX_FAILURES} трека. Проверь интернет или подписку.`;
      V.invoke("set_playing", { playing: false }).catch(V.logError);
      changed();
      V.emit("error", P.errorMessage);
      return;
    }
    advance();
  }

  async function refillWave(thenAdvance) {
    if (waveLoading || !P.isWave) return;
    waveLoading = true;
    try {
      const batch = await V.invoke("wave_more");
      P.waveTag = batch.tag;
      log(`batch ${String((batch.tag || "").slice(-2))} | ${batch.tracks.length} trk`);
      const known = new Set(P.queue.map((t) => t.id));
      P.queue = [...P.queue, ...batch.tracks.filter((t) => !known.has(t.id))];
      changed();
      if (thenAdvance && P.index + 1 < P.queue.length) {
        P.index += 1;
        loadCurrent();
      } else {
        preloadNext();
      }
    } catch (error) {
      log(`wave more | ${describe(error)}`);
    } finally {
      waveLoading = false;
    }
  }

  function advance() {
    if (P.index + 1 >= P.queue.length) {
      if (P.repeatMode === "all" && !P.isWave && P.queue.length) {
        P.index = 0;
        return loadCurrent();
      }
      if (P.isWave) return refillWave(true);
      const last = P.current;
      // The music never stops: a finished list rolls into a wave seeded by its last track.
      if (last) return P.startWave([`track:${last.id}`], "Волна по треку");
      return stopAtEnd();
    }
    P.index += 1;
    loadCurrent();
  }

  function stopAtEnd() {
    P.isPlaying = false;
    V.invoke("set_playing", { playing: false }).catch(V.logError);
    changed();
  }

  function trackEnded() {
    const track = P.current;
    endListen();
    if (track && P.isWave) waveEvent("trackFinished", track, P.duration, `finished ${Math.round(P.duration)}s`);
    if (P.sleepTimer?.kind === "end") {
      P.setSleepTimer(null);
      return stopAtEnd();
    }
    if (P.repeatMode === "one" && track) {
      // Same track again from the top; counts as a fresh listen.
      return loadCurrent();
    }
    advance();
  }

  function resetOrder() {
    P.isShuffled = false;
    P.unshuffled = null;
    if (P.isWave && P.repeatMode === "all") P.repeatMode = "off";
  }

  // ---------- public transport ----------
  P.play = (tracks, startAt = 0, position = 0) => {
    if (!tracks?.length) return;
    reportSkipIfNeeded();
    resumeAt = position;
    P.source = { kind: "list" };
    P.queue = [...tracks];
    P.index = Math.min(Math.max(startAt, 0), tracks.length - 1);
    resetOrder();
    loadCurrent();
  };

  /// My Wave with the saved character, or any rotor seeds (`track:1`, `artist:2`…).
  P.startWave = async (seeds = null, title = MY_WAVE) => {
    reportSkipIfNeeded();
    const finalSeeds = seeds || ["user:onyourwave", ...P.characterSeeds];
    P.source = { kind: "wave", title };
    resetOrder();
    P.queue = [];
    P.index = 0;
    P.isLoading = true;
    V.invoke("set_playing", { playing: false }).catch(V.logError);
    changed();
    try {
      const batch = await V.invoke("wave_start", { seeds: finalSeeds });
      if (P.source.kind !== "wave" || P.source.title !== title) return;
      P.waveTag = batch.tag;
      log("radioStarted | ok");
      P.queue = batch.tracks;
      P.index = 0;
      loadCurrent();
    } catch (error) {
      P.isLoading = false;
      P.errorMessage = String(error);
      changed();
      V.emit("error", P.errorMessage);
    }
  };

  P.togglePlay = () => {
    if (!P.current) return;
    P.elapsed = P.liveElapsed();
    P.elapsedStamp = performance.now();
    P.isPlaying = !P.isPlaying;
    V.invoke("set_playing", { playing: P.isPlaying }).catch(V.logError);
    changed();
  };

  P.next = () => {
    reportSkipIfNeeded();
    advance();
  };

  /// The button: restarts the track first, like iOS, then goes back.
  P.previous = () => {
    if (P.liveElapsed() > 3 || P.index === 0) return P.seek(0);
    endListen();
    P.index -= 1;
    loadCurrent();
  };

  /// Swipe back: always the previous track.
  P.goBack = () => {
    if (P.index <= 0) return P.seek(0);
    reportSkipIfNeeded();
    P.index -= 1;
    loadCurrent();
  };

  P.jump = (position) => {
    if (position < 0 || position >= P.queue.length) return;
    reportSkipIfNeeded();
    P.index = position;
    loadCurrent();
  };

  P.seek = (seconds) => {
    const target = Math.max(0, Math.min(seconds, P.duration || seconds));
    P.elapsed = target;
    P.elapsedStamp = performance.now();
    V.invoke("seek", { seconds: target }).catch(V.logError);
    changed();
  };

  P.playNext = (track) => {
    if (!P.current) return P.play([track]);
    P.queue.splice(P.index + 1, 0, track);
    changed();
    preloadNext();
  };

  P.enqueue = (track) => {
    if (!P.current) return P.play([track]);
    if (P.isWave) return P.playNext(track);
    P.queue.push(track);
    changed();
  };

  /// The wave never ends, so there it is only off or one track; lists also get «all».
  P.cycleRepeat = () => {
    P.repeatMode = P.repeatMode === "off" ? (P.isWave ? "one" : "all") : P.repeatMode === "all" ? "one" : "off";
    changed();
  };

  P.toggleShuffle = () => {
    const track = P.current;
    if (P.isWave || !track) return;
    if (P.isShuffled && P.unshuffled) {
      P.queue = P.unshuffled;
      P.index = Math.max(0, P.queue.findIndex((t) => t.id === track.id));
      P.unshuffled = null;
      P.isShuffled = false;
    } else {
      P.unshuffled = [...P.queue];
      const rest = P.queue.filter((_, i) => i !== P.index);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      P.queue = [track, ...rest];
      P.index = 0;
      P.isShuffled = true;
    }
    changed();
  };

  P.setVolume = (volume) => {
    P.volume = Math.min(Math.max(volume, 0), 1);
    V.store.set("volume", P.volume);
    V.invoke("set_volume", { volume: P.volume }).catch(V.logError);
    changed();
  };

  /// `{ kind: "at", at }` pauses at a time with a fade; `{ kind: "end" }` after this track.
  P.setSleepTimer = (timer) => {
    clearTimeout(sleepTask);
    P.sleepTimer = timer;
    if (timer?.kind === "at") {
      sleepTask = setTimeout(fadeOutAndPause, Math.max(0, timer.at - Date.now()));
    }
    changed();
  };

  async function fadeOutAndPause() {
    const start = P.volume;
    for (let step = 1; step <= 20; step++) {
      V.invoke("set_volume", { volume: start * (1 - step / 20) }).catch(V.logError);
      await new Promise((r) => setTimeout(r, 150));
    }
    if (P.isPlaying) P.togglePlay();
    V.invoke("set_volume", { volume: start }).catch(V.logError);
    P.sleepTimer = null;
    changed();
  }

  // ---------- likes (Session.swift) ----------
  P.isLiked = (track) => Boolean(track && P.liked.has(track.id));

  P.loadLikes = async () => {
    try {
      P.likedTracks = await V.invoke("liked_tracks");
      P.liked = new Set(P.likedTracks.map((t) => t.id));
      V.emit("likes", P.likedTracks);
    } catch (error) {
      V.logError(error);
    }
  };

  P.toggleLike = async (track) => {
    if (!track) return;
    const liked = !P.liked.has(track.id);
    if (liked) P.liked.add(track.id); else P.liked.delete(track.id);
    if (liked) P.likedTracks = [track, ...P.likedTracks];
    else P.likedTracks = P.likedTracks.filter((t) => t.id !== track.id);
    changed();
    V.emit("likes", P.likedTracks);
    try {
      await V.invoke("set_like", { trackId: track.id, albumId: track.albumId ?? null, liked });
      // Likes are part of what My Wave learns from.
      if (liked && P.isWave) waveEvent("like", track, 0, "like");
    } catch (error) {
      if (liked) P.liked.delete(track.id); else P.liked.add(track.id);
      changed();
      V.emit("error", String(error));
    }
  };

  /// «Не рекомендовать»: hides the track from recommendations and skips it.
  P.dislike = async (track) => {
    if (!track) return;
    if (P.isLiked(track)) await P.toggleLike(track);
    try {
      await V.invoke("dislike", { trackId: track.id, albumId: track.albumId ?? null });
      if (P.isWave) waveEvent("dislike", track, 0, "dislike");
      if (P.current?.id === track.id) P.next();
    } catch (error) {
      V.emit("error", String(error));
    }
  };

  P.setCharacterSeeds = (seeds) => {
    P.characterSeeds = seeds;
    V.store.set("waveSeeds", seeds);
  };

  // ---------- status ----------
  async function poll() {
    try {
      const status = await V.invoke("playback_status");
      if (!P.isLoading && P.current && performance.now() - loadedAt > END_GRACE_MS) {
        P.elapsed = status.position;
        P.elapsedStamp = performance.now();
        if (status.duration > 0) P.duration = status.duration;
        if (status.playing !== P.isPlaying && !status.ended) {
          // Paused or resumed from outside (media keys, the flyout).
          P.isPlaying = status.playing;
          changed();
        }
        if (status.ended && !endHandled) {
          endHandled = true;
          P.isPlaying = false;
          trackEnded();
        }
      }
      V.emit("status", status);
    } catch (_) {
      // Not signed in yet or the player is busy; try again on the next tick.
    }
  }

  P.startPolling = () => {
    if (P._polling) return;
    P._polling = setInterval(poll, 250);
    V.invoke("set_volume", { volume: P.volume }).catch(V.logError);
  };

  V.listen("media-next", () => P.next());
})(window.V);
