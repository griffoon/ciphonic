// Shared building blocks: the Tauri bridge, DOM helpers, events, springs, icons and glyphs.
// Everything hangs off one global `V` so the plain scripts can share it without a bundler.
"use strict";

window.V = window.V || {};

(function (V) {
  const tauri = window.__TAURI__;
  V.invoke = tauri ? tauri.core.invoke : async () => { throw new Error("нет Tauri"); };
  V.listen = tauri ? tauri.event.listen : async () => () => {};

  V.$ = (selector, root = document) => root.querySelector(selector);
  V.$$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /// h("div.row", {onclick}, child, "text") — text always goes in as text, never as HTML.
  V.h = function h(spec, attrs, ...children) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag || "div");
    if (classes.length) el.className = classes.join(" ");
    if (attrs && (attrs.constructor !== Object || attrs instanceof Node)) {
      children.unshift(attrs);
      attrs = null;
    }
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key === "html") el.innerHTML = value; // only for our own static SVG strings
      else if (key === "text") el.textContent = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  };

  // ---------- events ----------
  const handlers = new Map();
  V.on = (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name).delete(fn);
  };
  V.emit = (name, data) => handlers.get(name)?.forEach((fn) => {
    try { fn(data); } catch (error) { console.warn(`[${name}]`, error); }
  });

  V.logError = (error) => console.warn("[volna]", String(error));

  // ---------- storage (per-viewer conveniences only) ----------
  V.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`volna.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(`volna.${key}`, JSON.stringify(value)); } catch (_) { /* private mode */ }
    },
  };

  // ---------- formatting ----------
  V.time = (seconds) => {
    const s = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  V.fullTitle = (track) => (track.version ? `${track.title} (${track.version})` : track.title);
  /// Yandex cover links end in a size like 200x200; ask for the size the view needs.
  V.coverSize = (url, px) => (url ? url.replace(/\d+x\d+(?=$|\?)/, `${px}x${px}`) : url);
  V.plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };

  // ---------- springs ----------
  /// A SwiftUI-style spring(duration, bounce) as a CSS `linear()` easing, sampled from the
  /// damped oscillator. Returns the easing and how long to run it (it settles after `duration`).
  V.spring = function spring(duration, bounce = 0) {
    const omega = (2 * Math.PI) / duration;
    const zeta = 1 - Math.min(Math.max(bounce, 0), 0.95);
    const total = duration * (bounce > 0 ? 1.6 : 1.25);
    const samples = 48;
    const points = [];
    for (let i = 0; i <= samples; i++) {
      const t = (i / samples) * total;
      let x;
      if (zeta >= 1) {
        x = 1 - Math.exp(-omega * t) * (1 + omega * t);
      } else {
        const wd = omega * Math.sqrt(1 - zeta * zeta);
        x = 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
      }
      points.push(i === samples ? 1 : Math.round(x * 10000) / 10000);
    }
    return { easing: `linear(${points.join(", ")})`, ms: Math.round(total * 1000) };
  };

  // The app's springs, as CSS variables so stylesheets can use them.
  const springs = {
    snappy: V.spring(0.3, 0.1),
    spring: V.spring(0.45, 0.15),
    bouncy: V.spring(0.55, 0.3),
    sheet: V.spring(0.5, 0),
    soft: V.spring(0.6, 0.15),
  };
  V.springs = springs;
  for (const [name, { easing, ms }] of Object.entries(springs)) {
    document.documentElement.style.setProperty(`--${name}`, easing);
    document.documentElement.style.setProperty(`--${name}-ms`, `${ms}ms`);
  }

  /// Animates a number with a critically damped spring (for scroll follow and drags).
  V.animateValue = function animateValue(from, to, duration, onFrame) {
    const omega = (2 * Math.PI) / duration;
    const start = performance.now();
    let cancelled = false;
    function frame(now) {
      if (cancelled) return;
      const t = (now - start) / 1000;
      const p = 1 - Math.exp(-omega * t) * (1 + omega * t);
      onFrame(from + (to - from) * p);
      if (p < 0.9995) requestAnimationFrame(frame);
      else onFrame(to);
    }
    requestAnimationFrame(frame);
    return () => { cancelled = true; };
  };

  // ---------- icons (our own, stroke-drawn) ----------
  const stroke = (body, view = "0 0 24 24") =>
    `<svg viewBox="${view}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const fill = (body, view = "0 0 24 24") =>
    `<svg viewBox="${view}" fill="currentColor" aria-hidden="true">${body}</svg>`;
  const heartPath = "M12 20.5s-7.6-4.7-9.4-9.4C1.3 7.6 3.6 4 7.1 4c2 0 3.6 1.1 4.9 2.9C13.3 5.1 14.9 4 16.9 4c3.5 0 5.8 3.6 4.5 7.1-1.8 4.7-9.4 9.4-9.4 9.4z";
  V.icons = {
    waveform: stroke('<path d="M2 10.5v3M6 7v10M10 3.5v17M14 8v8M18 5v14M22 10v4"/>'),
    collection: stroke('<rect x="3.5" y="8" width="17" height="13" rx="2"/><path d="M6 5h12M8.5 2h7"/><path d="M13.5 17.5V11l3-1"/><circle cx="11.8" cy="17.5" r="1.7"/>'),
    search: stroke('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>'),
    heart: stroke(`<path d="${heartPath}"/>`),
    heartFill: fill(`<path d="${heartPath}"/>`),
    heartSlash: stroke(`<path d="${heartPath}"/><path d="M3 3l18 18"/>`),
    ellipsis: fill('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>'),
    shuffle: stroke('<path d="M3 7h3.2c1.9 0 3.2.9 4.2 2.5l3.2 5c1 1.6 2.3 2.5 4.2 2.5H21M3 17h3.2c1.4 0 2.5-.5 3.3-1.4M14.2 8.4c.8-.9 1.9-1.4 3.3-1.4H21M18 4l3 3-3 3M18 14l3 3-3 3"/>'),
    repeat: stroke('<path d="M17 2.5 20 5.5l-3 3"/><path d="M4 11.5v-2a4 4 0 0 1 4-4h12"/><path d="M7 21.5 4 18.5l3-3"/><path d="M20 12.5v2a4 4 0 0 1-4 4H4"/>'),
    repeatOne: stroke('<path d="M17 2.5 20 5.5l-3 3"/><path d="M4 11.5v-2a4 4 0 0 1 4-4h12"/><path d="M7 21.5 4 18.5l3-3"/><path d="M20 12.5v2a4 4 0 0 1-4 4H4"/><path d="M11 10.5l1.5-1v5.5"/>'),
    list: stroke('<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".6" fill="currentColor"/><circle cx="4" cy="12" r=".6" fill="currentColor"/><circle cx="4" cy="18" r=".6" fill="currentColor"/>'),
    quote: stroke('<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 21 11.5z"/><path d="M9 10.5h.01M12.5 10.5h.01M16 10.5h.01" stroke-width="2.6"/>'),
    quoteFill: fill('<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 21 11.5z"/>'),
    speaker: stroke('<path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.8 6.2a8.5 8.5 0 0 1 0 11.6"/>'),
    speakerLow: stroke('<path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z"/>'),
    moon: stroke('<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4a8.4 8.4 0 1 0 10.6 10.6z"/>'),
    moonFill: fill('<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4a8.4 8.4 0 1 0 10.6 10.6z"/>'),
    chevronDown: stroke('<path d="m4 9 8 6 8-6"/>'),
    chevronLeft: stroke('<path d="m15 4-8 8 8 8"/>'),
    gear: stroke('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.2 19.8 6 18M18 6l1.8-1.8"/>'),
    xmark: stroke('<path d="M6 6l12 12M18 6 6 18"/>'),
    radiowaves: stroke('<circle cx="12" cy="12" r="1.8"/><path d="M8.3 8.3a5.3 5.3 0 0 0 0 7.4M15.7 8.3a5.3 5.3 0 0 1 0 7.4M5.4 5.4a9.4 9.4 0 0 0 0 13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2"/>'),
    thumbsDown: stroke('<path d="M7 14V3.5M7 14l3.8 6.5c1.4 0 2.4-1 2.2-2.4L12.6 15h5.6a2 2 0 0 0 2-2.4l-1.2-6.8a2.2 2.2 0 0 0-2.2-1.8H7M7 14H3.5V3.5H7"/>'),
    playNext: stroke('<path d="M3 6h11M3 12h7M3 18h11M16 9l5 3-5 3z"/>'),
    playLast: stroke('<path d="M3 6h11M3 12h11M3 18h7M16 15l5 3-5 3z"/>'),
    mic: stroke('<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>'),
    album: stroke('<rect x="3.5" y="7" width="13.5" height="13.5" rx="1.5"/><path d="M7 3.5h13.5V17"/>'),
    clock: stroke('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    plus: stroke('<path d="M12 5v14M5 12h14"/>'),
    sliders: stroke('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    turnForward: stroke('<path d="M4 18v-5a5 5 0 0 1 5-5h11"/><path d="m16 4 4 4-4 4"/>'),
    playSmall: fill('<path d="M7 4.5v15l12-7.5z"/>'),
    refresh: stroke('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    arrowUpRight: stroke('<path d="M7 17 17 7M9 7h8v8"/>', "0 0 24 24"),
  };

  /// An icon element by name.
  V.icon = (name, cls = "") => V.h(`span.icon${cls ? "." + cls : ""}`, { html: V.icons[name] || "" });

  // ---------- transport glyphs (TransportGlyph.swift) ----------
  // Sharp triangles and bars like terminal glyphs, not rounded system symbols.
  const ASPECT = { play: 0.9, pause: 0.8, next: 1.35, previous: 1.35 };
  function glyphPath(kind, w, h) {
    const tri = (left, right, pointsRight) => pointsRight
      ? `M${left} 0L${right} ${h / 2}L${left} ${h}Z`
      : `M${right} 0L${left} ${h / 2}L${right} ${h}Z`;
    const rect = (x, width) => `M${x} 0h${width}v${h}h${-width}Z`;
    switch (kind) {
      case "play": return tri(w * 0.12, w * 0.95, true);
      case "pause": return rect(w * 0.16, w * 0.24) + rect(w * 0.6, w * 0.24);
      case "next": return tri(0, w * 0.44, true) + tri(w * 0.4, w * 0.84, true) + rect(w * 0.86, w * 0.14);
      case "previous": return rect(0, w * 0.14) + tri(w * 0.16, w * 0.6, false) + tri(w * 0.56, w, false);
      default: return "";
    }
  }
  V.glyph = function glyph(kind, height) {
    const width = height * ASPECT[kind];
    return V.h("span.glyph", {
      html: `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="currentColor" aria-hidden="true"><path d="${glyphPath(kind, width, height)}"/></svg>`,
    });
  };

  // ---------- terminal text ----------
  const NOISE = Array.from("▓▒░#@%&$*/\\<>01");
  /// Text that "decrypts" from noise into its value whenever it changes (ScrambleText).
  V.scramble = function scramble(el, text, duration = 0.5) {
    if (el._scrambleText === text) return;
    el._scrambleText = text;
    cancelAnimationFrame(el._scrambleFrame);
    const chars = Array.from(text || "");
    const start = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / (duration * 1000));
      const fixed = Math.floor(chars.length * p);
      el.textContent = chars.map((c, i) => (i < fixed || c === " " ? c : NOISE[(Math.random() * NOISE.length) | 0])).join("");
      if (p < 1) el._scrambleFrame = requestAnimationFrame(() => setTimeout(step, 33));
      else el.textContent = text;
    };
    step();
  };

  const RAMP = Array.from("▁▂▃▄▅▆▇█");
  /// `▁▂▃▅▇` bars from the analyzer bands (SpectrumText).
  V.spectrumText = (bands, count, live) =>
    Array.from({ length: count }, (_, i) => RAMP[Math.min(7, Math.floor((live ? bands?.[i] || 0 : 0) * 8))]).join("");

  // ---------- cover pixels and accent (Theme.swift) ----------
  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  }
  V.rgbToHsv = rgbToHsv;
  V.hsvToRgb = hsvToRgb;

  /// Strongest hue family by saturation × brightness, pushed bright enough to read on black.
  /// Null for grey covers, which keep the acid default (Theme.dominantAccent).
  V.dominantAccent = function dominantAccent(data) {
    const buckets = 12;
    const weight = new Array(buckets).fill(0);
    const sums = Array.from({ length: buckets }, () => [0, 0, 0]);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const [h, s, v] = rgbToHsv(r, g, b);
      if (s < 0.28 || v < 0.22) continue;
      const bucket = Math.min(buckets - 1, Math.floor(h * buckets));
      const w = s * s * v;
      weight[bucket] += w;
      sums[bucket][0] += r * w;
      sums[bucket][1] += g * w;
      sums[bucket][2] += b * w;
    }
    let best = 0;
    for (let i = 1; i < buckets; i++) if (weight[i] > weight[best]) best = i;
    if (!(weight[best] > (data.length / 4) * 0.012)) return null;
    const avg = sums[best].map((c) => c / weight[best]);
    const [h, s, v] = rgbToHsv(...avg);
    return hsvToRgb(h, Math.min(Math.max(s, 0.55), 0.9), Math.max(v, 0.92));
  };

  /// Small RGBA pixel buffer of an image (for accent picking and ASCII art).
  V.pixels = function pixels(image, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  };

  V.loadImage = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

  /// A cover through the Rust proxy, as a data URL readable by canvas and WebGL. Cached per URL.
  const coverCache = new Map();
  V.coverData = function coverData(url) {
    if (!url) return Promise.resolve(null);
    if (!coverCache.has(url)) {
      const pending = V.invoke("cover_data", { url }).catch((error) => {
        coverCache.delete(url);
        throw error;
      });
      coverCache.set(url, pending);
      if (coverCache.size > 12) coverCache.delete(coverCache.keys().next().value);
    }
    return coverCache.get(url);
  };
})(window.V);
