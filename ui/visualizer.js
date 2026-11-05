// WebGL2 port of CoverVisualizer.swift: the playing cover redrawn as ASCII that reacts to the
// music in one of five effects (breath, relief, scanner, matrix, smoke). Bass, mids and highs
// drive different parts of it. Audio levels come from the Rust analyzer; smoothing is per frame.
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
uniform float uBeatPhase;
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

// Square cover filling the screen height, centred; a slow ripple when there is no cover.
float coverL(vec2 cuv, float t) {
  if (uHasCover < 0.5) {
    float r = length((cuv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
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

// Smoke: a glowing cloud in the cover's colours, domain-warped so it folds like light in fog.
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
  int fx = int(uEffect + 0.5);
  if (fx == 4) {
    outColor = vec4(smoke(uv), 1.0);
    return;
  }
  vec2 grid = uGrid;
  vec2 g = uv * grid;
  vec2 cell = floor(g);
  vec2 cuv = (cell + 0.5) / grid;
  vec2 local = fract(g);
  float t = uTime;
  float l = 0.0, hot = 0.0, jitter = 0.0;

  if (fx == 0) {
    // Breath: the image never moves; light, density and glyph choice do.
    l = coverL(cuv, t);
    l = clamp((l - 0.5) * (1.2 + 0.5 * uBass) + 0.5 + 0.22 * uBass + 0.12 * uKick, 0.0, 1.0);
    jitter = (hash21(cell + floor(t * 8.0)) - 0.5) * uMid * 0.5;
    hot = step(1.0 - uHigh * 0.05 - uHighHit * 0.14, hash21(cell + floor(t * 20.0)));
  } else if (fx == 1) {
    // Relief: luminance is height; bass pushes bright regions toward the viewer.
    vec2 c = cuv - 0.5;
    c.x += c.y * uMid * 0.06 * sin(t * 0.8);
    float h0 = coverL(cuv, t);
    vec2 warped = 0.5 + c * (1.0 - (0.10 * uBass + 0.07 * uKick) * h0);
    l = coverL(warped, t);
    float hx = coverL(warped + vec2(1.0 / grid.x, 0.0), t);
    float hy = coverL(warped + vec2(0.0, 1.0 / grid.y), t);
    float light = clamp((l - hx) * 3.0 + (l - hy) * 3.0, -1.0, 1.0);
    l = clamp(l * (0.75 + 0.5 * uBass) + light * (0.25 + 0.5 * uBass), 0.0, 1.0);
    hot = smoothstep(0.85, 1.0, l) * (0.4 + uBass);
  } else if (fx == 2) {
    // Scanner: a beam sweeps down once per beat and develops the image; a trail fades behind.
    float base = coverL(cuv, t);
    float d = uBeatPhase - cuv.y;
    float trail = d > 0.0 ? exp(-d * 5.0) : 0.0;
    float head = exp(-abs(d) * 60.0);
    float noise = step(1.0 - uHighHit * 0.2 - uHigh * 0.03, hash21(cell + floor(t * 30.0)));
    l = clamp(base * (0.18 + 0.9 * trail) + head * 0.8 + noise * 0.5, 0.0, 1.0);
    hot = head + noise;
  } else {
    // Matrix: falling columns; the cover shows where the rain is bright.
    float base = coverL(cuv, t);
    float speed = 0.25 + hash21(vec2(cell.x, 3.0)) * 0.5;
    float headY = fract(t * speed * (0.6 + uBass * 1.4) + hash21(vec2(cell.x, 9.0)));
    float d = fract(headY - cuv.y);
    float trail = exp(-d * (9.0 - uMid * 5.0));
    float tip = exp(-d * 120.0);
    l = clamp(base * (0.15 + 1.1 * trail) + tip * 0.6, 0.0, 1.0);
    jitter = (hash21(cell + floor(t * 14.0)) - 0.5) * 0.4 * trail;
    hot = tip + step(1.0 - uHighHit * 0.1, hash21(cell + floor(t * 22.0)));
  }

  l *= smoothstep(1.2, 0.25, length((cuv - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
  vec3 col = mix(vec3(0.92), uAccent, clamp(hot, 0.0, 1.0));
  float gi = floor(clamp(l + jitter, 0.0, 0.999) * uN);
  float m = texture(uAtlas, vec2((gi + local.x) / uN, local.y)).r;
  outColor = vec4(col * m * (0.35 + 0.85 * l), 1.0);
}`;

  const UNIFORMS = [
    "uRes", "uGrid", "uN", "uTime", "uBass", "uMid", "uHigh", "uKick", "uFlash", "uMidHit", "uHighHit",
    "uHasCover", "uEffect", "uBeatPhase", "uAccent", "uCore", "uGlow", "uShade", "uCover", "uAtlas",
  ];
  /// Binary glyph ramp, darkest first.
  const GLYPHS = [" ", ".", "0", "1"];
  /// Cell size in CSS pixels; rows are 1.75x taller than wide, like terminal text.
  const CELL = 6;
  const MAX_DPR = 1.5;
  const ACID = [0.776, 1.0, 0.239];
  /// Yellow core, magenta glow, violet shadow: for grey covers and before a cover loads.
  const DEFAULT_SMOKE = { core: [1.0, 0.85, 0.15], glow: [0.95, 0.2, 0.75], shade: [0.35, 0.12, 0.8] };

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

  /// Two strongest hue families plus a darker shadow, pushed vivid (Theme.smokeColors).
  function smokePalette(image) {
    const V = window.V;
    const data = V.pixels(image, 32, 32);
    const buckets = 12;
    const weight = new Array(buckets).fill(0);
    const hues = new Array(buckets).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, v] = V.rgbToHsv(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      if (s < 0.25 || v < 0.2) continue;
      const bucket = Math.min(buckets - 1, Math.floor(h * buckets));
      const w = s * s * v;
      weight[bucket] += w;
      hues[bucket] += h * w;
    }
    const ranked = weight.map((_, i) => i).sort((a, b) => weight[b] - weight[a]);
    const first = ranked[0];
    if (!(weight[first] > 32 * 32 * 0.01)) return DEFAULT_SMOKE;
    const primary = hues[first] / weight[first];
    const second = ranked.find((b) => b !== first && weight[b] > weight[first] * 0.25 && Math.abs(b - first) > 1);
    const secondary = second !== undefined ? hues[second] / weight[second] : (primary + 0.12) % 1;
    return {
      core: V.hsvToRgb(primary, 0.75, 1.0),
      glow: V.hsvToRgb(secondary, 0.85, 0.95),
      shade: V.hsvToRgb((primary + 0.9) % 1, 0.85, 0.55),
    };
  }

  const noop = { supported: false, setLevels() {}, setCover() {}, setEffect() {}, setAccent() {}, setPlaying() {} };

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
      playing: false,
      bass: 0, mid: 0, high: 0, midHit: 0, highHit: 0, kick: 0, flash: 0, beatPhase: 1.3,
      lastBeat: 0, time: 0, last: performance.now(),
      hasCover: 0, smoke: DEFAULT_SMOKE, accent: ACID, effect: 1, coverToken: 0,
    };

    function step(now) {
      const dt = Math.min((now - s.last) / 1000, 0.05);
      s.last = now;
      const t = s.target;
      const live = s.playing && t.playing;
      const ease = (current, target, rate) => current + (target - current) * Math.min(1, dt * rate);
      // Levels are already what is audible now; only light smoothing so it doesn't flicker.
      s.bass = ease(s.bass, live ? t.bass : 0, 20);
      s.mid = ease(s.mid, live ? t.mid : 0, 12);
      s.high = ease(s.high, live ? t.high : 0, 24);
      s.midHit = live ? t.midHit : s.midHit * Math.exp(-dt * 6);
      s.highHit = live ? t.highHit : s.highHit * Math.exp(-dt * 10);
      s.kick *= Math.exp(-dt * 7);
      s.flash *= Math.exp(-dt * 9);
      s.beatPhase = Math.min(1.3, s.beatPhase + dt * 2.1);
      s.time += dt * (s.playing ? 0.6 + s.bass * 1.4 : 0.15);
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
      gl.uniform1f(u.uBeatPhase, s.beatPhase);
      gl.uniform3fv(u.uAccent, s.accent);
      gl.uniform3fv(u.uCore, s.smoke.core);
      gl.uniform3fv(u.uGlow, s.smoke.glow);
      gl.uniform3fv(u.uShade, s.smoke.shade);
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
      setPlaying(playing) { s.playing = playing; },
      setLevels(levels) {
        s.target = levels;
        // The jump lands on the kick: attack on the event, decay per frame.
        if (levels.beat !== s.lastBeat) {
          s.lastBeat = levels.beat;
          if (s.playing) {
            s.kick = Math.max(s.kick, 0.55 + 0.45 * levels.kickStrength);
            s.flash = Math.max(s.flash, 0.5 + 0.4 * levels.kickStrength);
            s.beatPhase = 0;
          }
        }
      },
      setEffect(index) { s.effect = index; },
      setAccent(rgb) { s.accent = rgb || ACID; },
      /// `image` is a loaded, same-origin image (the cover through the Rust proxy), or null.
      setCover(image) {
        if (!image) {
          s.hasCover = 0;
          s.smoke = DEFAULT_SMOKE;
          return;
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, coverTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        s.hasCover = 1;
        s.flash = 1;
        try {
          s.smoke = smokePalette(image);
        } catch (_) {
          s.smoke = DEFAULT_SMOKE;
        }
      },
    };
  }

  window.Visualizer = {
    create,
    effects: [
      { title: "Дыхание", summary: "обложка стоит, бас даёт свет, синт — мерцание, верха — вспышки" },
      { title: "Рельеф", summary: "яркие места выпирают на басу" },
      { title: "Сканер", summary: "на каждый удар луч проявляет обложку" },
      { title: "Матрица", summary: "обложка проступает сквозь дождь символов" },
      { title: "Дым", summary: "светящееся облако в цветах обложки, как в Яндексе" },
    ],
  };
})();
