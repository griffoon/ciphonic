// WebGL2 port of CoverVisualizer.swift: the playing cover redrawn as ASCII that breathes with the
// music (effect 0), or the glowing smoke cloud in the cover's colours (effect 1).
// Audio levels arrive as `levels` events from the Rust analyzer; smoothing happens per frame here.
(function () {
  const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uGrid;
uniform float uN;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uKick;
uniform float uFlash;
uniform float uMidHit;
uniform float uHighHit;
uniform float uHasCover;
uniform float uEffect;
uniform vec3 uAccent;
uniform vec3 uCore;
uniform vec3 uGlow;
uniform vec3 uShade;
uniform sampler2D uCover;
uniform sampler2D uAtlas;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float aspectLen(vec2 v) { return length(v * vec2(uRes.x / uRes.y, 1.0)); }

// Square cover filling the screen height, centred; a slow ripple when there is no cover.
float coverL(vec2 cuv, float t) {
  if (uHasCover < 0.5) {
    float r = aspectLen(cuv - 0.5);
    return 0.3 * (0.5 + 0.5 * sin(r * 20.0 - t * 2.0));
  }
  vec2 uv = (cuv - 0.5) * vec2(uRes.x / uRes.y, 1.0) + 0.5;
  return luma(texture(uCover, uv).rgb);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), w.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), w.x), w.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return v;
}

// Smoke: domain-warped cloud. Bass swells it, mids speed up the folding, highs draw streaks.
vec3 smoke(vec2 uv) {
  vec2 p = (uv - vec2(0.5, 0.38)) * vec2(uRes.x / uRes.y, 1.0) * 1.6;
  float t = uTime * 0.18 * (1.0 + uMid * 0.8);
  vec2 q = vec2(fbm(p + t), fbm(p - t + 3.1));
  vec2 r = vec2(fbm(p + 2.0 * q + vec2(1.7, 9.2) + t * 1.3),
                fbm(p + 2.0 * q + vec2(8.3, 2.8) - t));
  float f = fbm(p + 2.6 * r);
  float radius = length(p) * (1.15 - 0.28 * uBass - 0.18 * uKick);
  float cloud = smoothstep(1.05, 0.05, radius + (f - 0.5) * 0.6);
  vec3 col = mix(uShade * 0.7, uGlow, clamp(f * f * 2.4, 0.0, 1.0));
  col = mix(col, uCore, clamp(length(q) * 0.85 - 0.15, 0.0, 1.0));
  col += uCore * pow(clamp(f, 0.0, 1.0), 3.0) * (0.6 + 1.4 * uBass);
  float intensity = cloud * (0.45 + 0.9 * f) * (0.75 + 0.45 * uBass + 0.35 * uKick);
  float streak = pow(abs(sin(p.x * 14.0 + f * 7.0 + t * 5.0)), 48.0) * (uHigh * 0.6 + uHighHit) * cloud;
  return col * intensity + streak * uGlow + uFlash * 0.08 * uCore;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes;
  if (uEffect > 0.5) {
    outColor = vec4(smoke(uv), 1.0);
    return;
  }
  // Breath: the image never moves; light, density and glyph choice do.
  vec2 g = uv * uGrid;
  vec2 cell = floor(g);
  vec2 cuv = (cell + 0.5) / uGrid;
  vec2 local = fract(g);
  float t = uTime;
  float l = coverL(cuv, t);
  l = clamp((l - 0.5) * (1.2 + 0.5 * uBass) + 0.5 + 0.22 * uBass + 0.12 * uKick, 0.0, 1.0);
  float jitter = (hash21(cell + floor(t * 8.0)) - 0.5) * uMid * 0.5;
  float hot = step(1.0 - uHigh * 0.05 - uHighHit * 0.14, hash21(cell + floor(t * 20.0)));
  l *= smoothstep(1.2, 0.25, aspectLen(cuv - 0.5));
  vec3 col = mix(vec3(0.92), uAccent, clamp(hot, 0.0, 1.0));
  float gi = floor(clamp(l + jitter, 0.0, 0.999) * uN);
  float m = texture(uAtlas, vec2((gi + local.x) / uN, local.y)).r;
  outColor = vec4(col * m * (0.35 + 0.85 * l), 1.0);
}`;

  const UNIFORMS = [
    "uRes", "uGrid", "uN", "uTime", "uBass", "uMid", "uHigh", "uKick", "uFlash", "uMidHit",
    "uHighHit", "uHasCover", "uEffect", "uAccent", "uCore", "uGlow", "uShade", "uCover", "uAtlas",
  ];
  const EFFECTS = ["ascii", "дым"];
  /// Binary glyph ramp, darkest first.
  const GLYPHS = [" ", ".", "0", "1"];
  /// Cell size in CSS pixels; rows are 1.75x taller than wide, like terminal text.
  const CELL = 6;
  const MAX_DPR = 1.5;
  const ACID = [0.776, 1.0, 0.239];
  /// Yellow core, magenta glow, violet shadow: used for grey covers and before a cover loads.
  const DEFAULT_PALETTE = { core: [1.0, 0.85, 0.15], glow: [0.95, 0.2, 0.75], shade: [0.35, 0.12, 0.8], accent: ACID };

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function setTextureParams(gl, wrap) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }

  function makeAtlas() {
    const cellW = 32, cellH = 56;
    const canvas = document.createElement("canvas");
    canvas.width = cellW * GLYPHS.length;
    canvas.height = cellH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(cellH * 0.72)}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    GLYPHS.forEach((glyph, i) => ctx.fillText(glyph, i * cellW + cellW / 2, cellH / 2 + 2));
    return canvas;
  }

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

  /// Two strongest hue families plus a darker shadow, pushed vivid (Theme.smokeColors).
  /// Throws for a cross-origin cover the canvas can't read; the caller falls back to defaults.
  function paletteFrom(image) {
    const side = 32;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, side, side);
    const data = ctx.getImageData(0, 0, side, side).data;
    const buckets = 12;
    const weight = new Array(buckets).fill(0);
    const hues = new Array(buckets).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, v] = rgbToHsv(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      if (s < 0.25 || v < 0.2) continue;
      const bucket = Math.min(buckets - 1, Math.floor(h * buckets));
      const w = s * s * v;
      weight[bucket] += w;
      hues[bucket] += h * w;
    }
    const ranked = weight.map((_, i) => i).sort((a, b) => weight[b] - weight[a]);
    const first = ranked[0];
    if (!(weight[first] > side * side * 0.01)) return DEFAULT_PALETTE;
    const primary = hues[first] / weight[first];
    const second = ranked.find((b) => b !== first && weight[b] > weight[first] * 0.25 && Math.abs(b - first) > 1);
    const secondary = second !== undefined ? hues[second] / weight[second] : (primary + 0.12) % 1;
    return {
      core: hsvToRgb(primary, 0.75, 1.0),
      glow: hsvToRgb(secondary, 0.85, 0.95),
      shade: hsvToRgb((primary + 0.9) % 1, 0.85, 0.55),
      accent: hsvToRgb(primary, 0.7, 1.0),
    };
  }

  const noop = { supported: false, setLevels() {}, setCover() {}, toggleEffect() { return EFFECTS[0]; } };

  function create(canvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) return noop;

    const program = gl.createProgram();
    try {
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    } catch (error) {
      console.warn("[viz] shader:", error);
      return noop;
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    const u = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]));

    const coverTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, coverTex);
    setTextureParams(gl, gl.MIRRORED_REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    const atlasTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    setTextureParams(gl, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeAtlas());

    gl.uniform1i(u.uCover, 0);
    gl.uniform1i(u.uAtlas, 1);
    gl.uniform1f(u.uN, GLYPHS.length);

    const s = {
      target: { bass: 0, mid: 0, high: 0, midHit: 0, highHit: 0, beat: 0, kickStrength: 0, playing: false },
      bass: 0, mid: 0, high: 0, midHit: 0, highHit: 0, kick: 0, flash: 0,
      lastBeat: 0, time: 0, last: performance.now(),
      hasCover: 0, palette: DEFAULT_PALETTE, effect: 0, coverToken: 0,
    };

    function step(now) {
      const dt = Math.min((now - s.last) / 1000, 0.05);
      s.last = now;
      const t = s.target;
      const live = t.playing;
      const ease = (current, target, rate) => current + (target - current) * Math.min(1, dt * rate);
      // Light smoothing only: the analyzer already tracks what is audible right now.
      s.bass = ease(s.bass, live ? t.bass : 0, 20);
      s.mid = ease(s.mid, live ? t.mid : 0, 12);
      s.high = ease(s.high, live ? t.high : 0, 24);
      s.midHit = live ? t.midHit : s.midHit * Math.exp(-dt * 6);
      s.highHit = live ? t.highHit : s.highHit * Math.exp(-dt * 10);
      s.kick *= Math.exp(-dt * 7);
      s.flash *= Math.exp(-dt * 9);
      s.time += dt * (live ? 0.6 + s.bass * 1.4 : 0.15);
    }

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uGrid, Math.max(8, Math.round(w / (CELL * dpr))), Math.max(8, Math.round(h / (CELL * 1.75 * dpr))));
      gl.uniform1f(u.uTime, s.time);
      gl.uniform1f(u.uBass, s.bass);
      gl.uniform1f(u.uMid, s.mid);
      gl.uniform1f(u.uHigh, s.high);
      gl.uniform1f(u.uKick, s.kick);
      gl.uniform1f(u.uFlash, s.flash);
      gl.uniform1f(u.uMidHit, s.midHit);
      gl.uniform1f(u.uHighHit, s.highHit);
      gl.uniform1f(u.uHasCover, s.hasCover);
      gl.uniform1f(u.uEffect, s.effect);
      gl.uniform3fv(u.uAccent, s.palette.accent);
      gl.uniform3fv(u.uCore, s.palette.core);
      gl.uniform3fv(u.uGlow, s.palette.glow);
      gl.uniform3fv(u.uShade, s.palette.shade);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      requestAnimationFrame(frame);
      // Hidden canvas: no GPU work, and no time jump when it comes back.
      if (!canvas.classList.contains("on")) {
        s.last = now;
        return;
      }
      step(now);
      draw();
    }
    requestAnimationFrame(frame);

    return {
      supported: true,

      setLevels(levels) {
        s.target = levels;
        // The jump lands on the kick: attack on the event, decay per frame.
        if (levels.beat !== s.lastBeat) {
          s.lastBeat = levels.beat;
          s.kick = Math.max(s.kick, 0.55 + 0.45 * levels.kickStrength);
          s.flash = Math.max(s.flash, 0.5 + 0.4 * levels.kickStrength);
        }
      },

      /// Loads the cover; a cover the GPU may not read (no CORS) leaves the ripple and default colours.
      setCover(url) {
        const token = ++s.coverToken;
        if (!url) {
          s.hasCover = 0;
          s.palette = DEFAULT_PALETTE;
          return;
        }
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
          if (token !== s.coverToken) return;
          try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, coverTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            s.hasCover = 1;
            s.flash = 1;
          } catch (error) {
            console.warn("[viz] cover:", error);
            s.hasCover = 0;
          }
          try {
            s.palette = paletteFrom(image);
          } catch (_) {
            s.palette = DEFAULT_PALETTE;
          }
        };
        image.onerror = () => {
          if (token !== s.coverToken) return;
          s.hasCover = 0;
          s.palette = DEFAULT_PALETTE;
        };
        image.src = url.replace("200x200", "400x400");
      },

      toggleEffect() {
        s.effect = (s.effect + 1) % EFFECTS.length;
        return EFFECTS[s.effect];
      },

      /// The current accent as CSS, so the UI can follow the cover's colour.
      accentCss() {
        const [r, g, b] = s.palette.accent.map((c) => Math.round(c * 255));
        return `rgb(${r}, ${g}, ${b})`;
      },
    };
  }

  window.Visualizer = { create };
})();
