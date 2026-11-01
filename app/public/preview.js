// AutoSeq preview: your house, every pixel, playing the planned sequence with the song.
//
// The effects are re-drawn here in simplified form, from the same plan the .xsq is
// written from. It's a guide to what the show does and when; xLights' own render is
// the final word on exactly how each effect looks.
(function () {
  const TAU = Math.PI * 2;
  const hex = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const frac = x => x - Math.floor(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const hash = (a, b) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
  const num = (s, k, d) => { const v = parseFloat(s[k]); return Number.isFinite(v) ? v : d; };
  const mix = (c1, c2, f) => [c1[0] + (c2[0] - c1[0]) * f, c1[1] + (c2[1] - c1[1]) * f, c1[2] + (c2[2] - c1[2]) * f];
  const palAt = (pal, f) => {                       // smooth walk through the palette, wrapping
    const n = pal.length; if (n === 1) return pal[0];
    const x = frac(f) * n, i = Math.floor(x);
    return mix(pal[i], pal[(i + 1) % n], x - i);
  };

  // Mouth shapes for the singing face, drawn as an open-ness and width (0..1).
  const MOUTH = { AI: [0.9, 0.7], E: [0.45, 0.85], etc: [0.35, 0.6], FV: [0.15, 0.6], L: [0.45, 0.55],
    MBP: [0.04, 0.55], O: [0.75, 0.45], U: [0.45, 0.3], WQ: [0.35, 0.3], rest: [0.04, 0.5] };

  // One effect → a function (bx, by) → [r, g, b] for the given time.
  function shader(e, t, W, H, ctx) {
    const s = e.settings, dur = Math.max(0.001, e.end - e.start);
    const p = clamp((t - e.start) / dur, 0, 1), el = t - e.start;
    const pal = e.pal;
    let k = e.brightness / 100;
    const fo = num(s, 'T_TEXTCTRL_Fadeout', 0), fi = num(s, 'T_TEXTCTRL_Fadein', 0);
    if (fo > 0 && e.end - t < fo) k *= (e.end - t) / fo;
    if (fi > 0 && el < fi) k *= el / fi;
    const out = c => [c[0] * k, c[1] * k, c[2] * k];
    switch (e.effect) {
      case 'On': {
        const a = num(s, 'E_TEXTCTRL_Eff_On_Start', 100), b = num(s, 'E_TEXTCTRL_Eff_On_End', 100);
        const c = out(pal[0]).map(v => v * (a + (b - a) * p) / 100);
        if (s.E_CHECKBOX_On_Shimmer === '1') return (x, y) => (hash(x, Math.floor(el * 20) + y) > 0.5 ? c : [0, 0, 0]);
        return () => c;
      }
      case 'Color Wash': {
        const cyc = num(s, 'E_TEXTCTRL_ColorWash_Cycles', 1), hf = s.E_CHECKBOX_ColorWash_HFade === '1' || s.E_CHECKBOX_ColorWash_HFade === 1;
        const c = out(palAt(pal, p * cyc));
        return hf ? (x) => { const f = 1 - Math.abs((x + 0.5) / W * 2 - 1); return c.map(v => v * f); } : () => c;
      }
      case 'Single Strand': {
        if (s.E_CHOICE_SingleStrand_FX && s.E_CHOICE_SingleStrand_FX !== 'None' && !s.E_CHOICE_Chase_Type1) {
          return (x) => { const h = hash(x, Math.floor(el * 12)); return h > 0.85 ? out(pal[Math.floor(h * 97) % pal.length]) : [0, 0, 0]; };
        }
        const type = s.E_CHOICE_Chase_Type1 || 'Left-Right', rot = num(s, 'E_TEXTCTRL_Chase_Rotations', 1);
        const size = Math.max(1, W * num(s, 'E_SLIDER_Color_Mix1', 10) / 100), chases = Math.max(1, num(s, 'E_SLIDER_Number_Chases', 1));
        const fade = (s.E_CHOICE_Fade_Type || 'None') !== 'None';
        const ph = frac(p * rot);
        const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
        let heads;
        switch (type) {
          case 'Right-Left': heads = [(1 - ph) * (W + size)]; break;
          case 'Bounce from Left': heads = [tri * W]; break;
          case 'Bounce from Right': heads = [(1 - tri) * W]; break;
          case 'Dual Bounce': heads = [tri * W / 2, W - tri * W / 2]; break;
          case 'From Middle': heads = [W / 2 + ph * W / 2, W / 2 - ph * W / 2]; break;
          case 'To Middle': heads = [ph * W / 2, W - ph * W / 2]; break;
          default: heads = [ph * (W + size)];
        }
        if (chases > 1) heads = heads.flatMap(h => Array.from({ length: chases }, (_, i) => (h + i * W / chases) % (W + size)));
        return (x) => {
          for (let i = 0; i < heads.length; i++) {
            const d = Math.abs(x - heads[i]);
            if (d < size / 2) return out(pal[i % pal.length]).map(v => v * (fade ? 1 - d / (size / 2) : 1));
          }
          return [0, 0, 0];
        };
      }
      case 'Bars': {
        const n = Math.max(1, num(s, 'E_SLIDER_Bars_BarCount', 1)) * pal.length, cyc = num(s, 'E_SLIDER_Bars_Cycles', 1);
        const dir = s.E_CHOICE_Bars_Direction || 'Left', grad = s.E_CHECKBOX_Bars_Gradient === '1' || s.E_CHECKBOX_Bars_Gradient === 1;
        const vertical = /up|down|expand|compress/i.test(dir) && !/^H-/.test(dir);
        const sign = /Right|down/i.test(dir) ? -1 : 1;
        return (x, y) => {
          const pos = vertical ? y / H : x / W;
          const f = frac(pos * n / pal.length + sign * p * cyc);
          const i = Math.floor(f * pal.length), sub = frac(f * pal.length);
          return out(grad ? mix(pal[i], pal[(i + 1) % pal.length], sub) : pal[i]);
        };
      }
      case 'Shockwave': {
        const cx = num(s, 'E_SLIDER_Shockwave_CenterX', 50) / 100 * W, cy = num(s, 'E_SLIDER_Shockwave_CenterY', 50) / 100 * H;
        const span = Math.hypot(W, H) / 2;
        const r = span * (num(s, 'E_SLIDER_Shockwave_Start_Radius', 1) + (num(s, 'E_SLIDER_Shockwave_End_Radius', 10) - num(s, 'E_SLIDER_Shockwave_Start_Radius', 1)) * p) / 100;
        const w = Math.max(1, span * (num(s, 'E_SLIDER_Shockwave_Start_Width', 5) + (num(s, 'E_SLIDER_Shockwave_End_Width', 10) - num(s, 'E_SLIDER_Shockwave_Start_Width', 5)) * p) / 100);
        return (x, y) => {
          const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
          return d < w ? out(palAt(pal, p)).map(v => v * (1 - d / w)) : [0, 0, 0];
        };
      }
      case 'Plasma': case 'Butterfly': {
        const sp = num(s, 'E_SLIDER_Plasma_Speed', num(s, 'E_SLIDER_Butterfly_Speed', 10)) / 10;
        const tt = el * sp;
        return (x, y) => {
          const u = x / Math.max(W, 8) * 6, v = y / Math.max(H, 8) * 6;
          const f = (Math.sin(u + tt) + Math.sin(v * 0.8 + tt * 0.7) + Math.sin((u + v) * 0.6 + tt * 1.3)) / 6 + 0.5;
          return out(palAt(pal, f));
        };
      }
      case 'Shader': {                                    // an ISF shader from the show folder, run with WebGL
        const runner = ctx.shaderFor && ctx.shaderFor(s.E_0FILEPICKERCTRL_IFS || s.E_FILEPICKERCTRL_IFS || '', W, H);
        if (!runner) return () => [0, 0, 0];
        const speed = num(s, 'E_TEXTCTRL_Shader_Speed', num(s, 'E_SLIDER_Shader_Speed', 100) / 100) || 1;
        const px = runner.render(el * speed);
        return (x, y) => { const o = (y * W + x) * 4; return [px[o] * k, px[o + 1] * k, px[o + 2] * k]; };
      }
      case 'Ripple': {                                   // a ring growing out from the centre
        const r = p * 0.75, w = 0.12;
        return (x, y) => {
          const d = Math.abs(Math.hypot((x + 0.5) / W - 0.5, (y + 0.5) / H - 0.5) - r);
          return d < w ? out(palAt(pal, p)).map(v => v * (1 - d / w)) : [0, 0, 0];
        };
      }
      case 'Strobe': {
        const n = Math.max(1, num(s, 'E_SLIDER_Number_Strobes', 3));
        return (x, y) => (hash(x + n, Math.floor(el * 25) + y * 7) > 0.6 ? out(pal[0]) : [0, 0, 0]);
      }
      case 'Fire': {
        const hgt = num(s, 'E_SLIDER_Fire_Height', 50) / 100;
        const fire = [[255, 30, 0], [255, 120, 0], [255, 220, 60]];
        return (x, y) => {
          const ny = y / Math.max(1, H - 1);
          const flick = hash(x, Math.floor(el * 15)) * 0.35;
          const heat = clamp(1 - ny / Math.max(0.1, hgt) + flick - 0.2, 0, 1);
          return heat <= 0 ? [0, 0, 0] : out(palAt(fire, heat * 0.66)).map(v => v * heat);
        };
      }
      case 'Meteors': {
        const cnt = Math.max(1, num(s, 'E_SLIDER_Meteors_Count', 10)), len = num(s, 'E_SLIDER_Meteors_Length', 25) / 100;
        const sp = num(s, 'E_SLIDER_Meteors_Speed', 10) / 10;
        const down = /Down|Up/.test(s.E_CHOICE_Meteors_Effect || 'Down');
        return (x, y) => {
          const lane = down ? x : y, along = down ? (H - y) / H : x / W;
          const seed = hash(Math.floor(lane * cnt / (down ? W : H)) + 3, 7);
          if (seed > cnt / (down ? W : H) * 4) return [0, 0, 0];
          const head = frac(el * sp * 0.5 + seed);
          const d = head - along;
          return d >= 0 && d < len ? out(pal[Math.floor(seed * 13) % pal.length]).map(v => v * (1 - d / len)) : [0, 0, 0];
        };
      }
      case 'Spirals': {
        const cnt = Math.max(1, num(s, 'E_SLIDER_Spirals_Count', 1)) * pal.length, rot = num(s, 'E_SLIDER_Spirals_Rotation', 20) / 10;
        const th = num(s, 'E_SLIDER_Spirals_Thickness', 50) / 100;
        return (x, y) => {
          const f = frac((x / W + y / Math.max(H, 1) * rot * 0.3) * cnt / pal.length + p * 2);
          const i = Math.floor(f * pal.length), sub = frac(f * pal.length);
          return sub < th ? out(pal[i]) : [0, 0, 0];
        };
      }
      case 'Pinwheel': {                                 // spinning arms around the centre
        const arms = Math.max(1, num(s, 'E_SLIDER_Pinwheel_Arms', 3)), th = Math.max(0.05, num(s, 'E_SLIDER_Pinwheel_Thickness', 5) / 100);
        const twist = num(s, 'E_SLIDER_Pinwheel_Twist', 0) / 100, sp = num(s, 'E_SLIDER_Pinwheel_Speed', 10) / 10;
        const dir = String(s.E_CHECKBOX_Pinwheel_Rotation ?? '1') === '0' ? -1 : 1;
        return (x, y) => {
          const u = (x + 0.5) / W - 0.5, v = (y + 0.5) / Math.max(H, 1) - 0.5, r = Math.hypot(u, v) * 2;
          const a = (Math.atan2(v, u) / TAU + 1 + twist * r + dir * el * sp * 0.25) * arms;
          const i = Math.floor(a) % arms, f = frac(a);
          return f < th * 2 ? out(pal[i % pal.length]).map(c => c * (1 - f / (th * 2) * 0.5)) : [0, 0, 0];
        };
      }
      case 'Snowflakes': {                               // flakes drifting down (piling up when accumulating)
        const cnt = num(s, 'E_SLIDER_Snowflakes_Count', 5), sp = num(s, 'E_SLIDER_Snowflakes_Speed', 10) / 10;
        const pile = /Accum/.test(s.E_CHOICE_Falling || ''), drive = /Driving/.test(s.E_CHOICE_Falling || '');
        const dens = Math.min(0.5, cnt / Math.max(20, W * Math.max(H, 1)) * 6);
        return (x, y) => {
          if (pile && y < H * Math.min(0.3, p * 0.3)) return out(pal[0]).map(c => c * 0.8);
          const lane = drive ? x - Math.floor((H - y) * 0.4) : x;
          for (let k = 0; k < 3; k++) {                  // up to three flakes per column, each falling at its own pace
            const h = hash(lane + 3, k + 11);
            if (h > dens * 3) continue;
            const fy = (1 - frac(h * 7 + el * sp * (0.15 + h * 0.2))) * Math.max(H, 1);
            if (Math.abs(y - fy) < 0.9) return out(pal[k % pal.length]);
          }
          return [0, 0, 0];
        };
      }
      case 'Wave': {
        const n = Math.max(0.5, num(s, 'E_TEXTCTRL_Number_Waves', num(s, 'E_SLIDER_Number_Waves', 1)));
        const th = Math.max(0.05, num(s, 'E_SLIDER_Thickness_Percentage', 25) / 100), amp = num(s, 'E_SLIDER_Wave_Height', 50) / 100;
        const sp = num(s, 'E_TEXTCTRL_Wave_Speed', 10) / 10;
        return (x, y) => {
          if (H <= 1) return out(palAt(pal, frac(x / W * n + el * sp * 0.3)));
          const cy = 0.5 + 0.5 * amp * Math.sin(TAU * (x / W * n + el * sp * 0.3));
          return Math.abs(y / H - cy) < th / 2 ? out(palAt(pal, x / W)) : [0, 0, 0];
        };
      }
      case 'Curtain': {
        const open = (s.E_CHOICE_Curtain_Effect || 'open') === 'open';
        const f = open ? 1 - p : p;
        return (x) => (Math.abs(x / W - 0.5) * 2 > 1 - f ? out(pal[0]) : [0, 0, 0]);
      }
      case 'Twinkle': {
        const cnt = num(s, 'E_SLIDER_Twinkle_Count', 3) / 100, steps = Math.max(2, num(s, 'E_SLIDER_Twinkle_Steps', 30));
        const speed = 20 / steps;
        return (x, y) => {
          const h = hash(x + 1, y + 1);
          if (h > Math.max(0.03, cnt * 3)) return [0, 0, 0];
          const tw = 0.5 + 0.5 * Math.sin(TAU * (el * speed + h * 10));
          return out(pal[Math.floor(h * 991) % pal.length]).map(v => v * tw);
        };
      }
      case 'Faces': {
        const ph = ctx.phonemeAt(t) || 'rest';
        const pics = ctx.facePics.get(e.el);
        if (pics && (pics[ph] || pics.rest)) {               // the real picture face from the show folder
          const img = pics[ph] || pics.rest;
          const thr = (s.E_CHECKBOX_Faces_TransparentBlack === '1') ? num(s, 'E_TEXTCTRL_Faces_TransparentBlack', 0) * 3 : -1;
          return (x, y) => {
            const o = ((H - 1 - y) * W + x) * 4;
            const r = img[o], g = img[o + 1], b = img[o + 2], a = img[o + 3] / 255;
            if (a < 0.05 || r + g + b <= thr) return [0, 0, 0];
            return [r * a * k, g * a * k, b * a * k];
          };
        }
        const [open, width] = MOUTH[ph] || MOUTH.rest;
        const white = [235 * k, 235 * k, 235 * k], orange = [255 * k, 110 * k, 0];
        return (x, y) => {
          const u = x / W - 0.5, v = y / H - 0.5;                          // v: up is +
          const eye = (ex) => Math.hypot((u - ex) * 1.6, v - 0.18) < 0.07;
          if (eye(-0.14) || eye(0.14)) return orange;
          const mw = 0.32 * width, mh = 0.02 + 0.2 * open;
          if (Math.abs(u) < mw && Math.abs(v + 0.15) < mh && ((u / mw) ** 2 + ((v + 0.15) / mh) ** 2) < 1) return white;
          return [0, 0, 0];
        };
      }
      default:
        return (x, y) => (hash(x, y) > 0.5 ? out(pal[0]).map(v => v * 0.6) : [0, 0, 0]);
    }
  }

  class Preview {
    constructor(root, data, audioUrl) {
      this.root = root;
      this.geo = data.geometry;
      this.dur = data.duration;
      this.sections = data.sections || [];
      this.phonemes = data.phonemes || [];
      this.byEl = new Map();
      for (const e of data.effects) {
        e.pal = (e.colors && e.colors.length ? e.colors : ['#FFFFFF']).map(hex);
        if (!this.byEl.has(e.el)) this.byEl.set(e.el, []);
        this.byEl.get(e.el).push(e);
      }
      for (const list of this.byEl.values()) list.sort((a, b) => a.layer - b.layer || a.start - b.start);
      this.pixelScale = 1; this.showUnlit = true;
      this.facePics = new Map();
      this.shaderSources = data.shaderSources || {};      // file name (lowercase) → .fs source text
      this.shaders = new Map();
      this.testShader = null;                             // { runner } while trying a shader on the matrix
      this.folderFaces = data.folderFaces || null;           // picture URLs found in a show folder chosen in the browser
      this.loadFaces(data.faces || {});
      this.canvas = root.querySelector('canvas');
      this.c2 = this.canvas.getContext('2d');
      this.audio = root.querySelector('audio');
      this.audio.src = audioUrl;
      this.mtx = new Map();
      for (const m of this.geo.models) if (m.rect) {
        const cv = document.createElement('canvas'); cv.width = m.W; cv.height = m.H;
        this.mtx.set(m.name, { cv, ctx: cv.getContext('2d'), img: cv.getContext('2d').createImageData(m.W, m.H) });
      }
      // groups: one canvas laid over where their props are (xLights "Per Preview")
      this.groups = new Map();
      this.modelGroups = new Map();
      for (const g of this.geo.groups || []) {
        if (!this.byEl.has(g.name)) continue;            // only groups the plan actually uses
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of g.members) {
          const m = this.geo.models.find(z => z.name === n);
          if (!m) continue;
          if (m.rect) { x0 = Math.min(x0, m.rect[0]); y0 = Math.min(y0, m.rect[1]); x1 = Math.max(x1, m.rect[0] + m.rect[2]); y1 = Math.max(y1, m.rect[1] + m.rect[3]); }
          for (let i = 0; i < m.nodes.length; i += 4) {
            x0 = Math.min(x0, m.nodes[i]); x1 = Math.max(x1, m.nodes[i]); y0 = Math.min(y0, m.nodes[i + 1]); y1 = Math.max(y1, m.nodes[i + 1]);
          }
          if (!this.modelGroups.has(n)) this.modelGroups.set(n, []);
          this.modelGroups.get(n).push(g.name);
        }
        if (!(x1 > x0)) continue;
        const W = 240, H = Math.max(24, Math.min(240, Math.round(240 * (y1 - y0) / (x1 - x0))));
        this.groups.set(g.name, { W, H, x0, y0, sx: (W - 1) / (x1 - x0), sy: (H - 1) / Math.max(1e-6, y1 - y0) });
      }
      this.fit();
      this.bind();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    // Load each face picture and draw it into the prop's own buffer size, so the
    // renderer can read it pixel by pixel like any other effect.
    loadFaces(faces) {
      for (const [el, f] of Object.entries(faces)) {
        const m = this.geo.models.find(x => x.name === el);
        if (!m) continue;
        const pics = {};
        this.facePics.set(el, pics);
        const urls = { ...(this.folderFaces?.[el] || {}), ...(f.mouths || {}) };
        for (const [ph, url] of Object.entries(urls)) {
          const img = new Image();
          img.onload = () => {
            const cv = document.createElement('canvas'); cv.width = m.W; cv.height = m.H;
            const c = cv.getContext('2d');
            const fit = f.placement === 'Centered' ? Math.min(1, m.W / img.width, m.H / img.height)
              : Math.min(m.W / img.width, m.H / img.height);
            const w = img.width * fit, h = img.height * fit;
            c.drawImage(img, (m.W - w) / 2, (m.H - h) / 2, w, h);
            pics[ph] = c.getImageData(0, 0, m.W, m.H).data;
          };
          img.src = url;
        }
      }
    }

    shaderFor(path, W, H) {
      const name = String(path).split(/[\\/]/).pop().toLowerCase();
      const key = `${name}|${W}x${H}`;
      if (this.shaders.has(key)) return this.shaders.get(key);
      let runner = null;
      const src = this.shaderSources[name];
      if (src && window.ISFShader) {
        try { runner = new ISFShader.ShaderRunner(src, W, H); } catch (e) { console.warn('shader', name, e.message); }
      }
      this.shaders.set(key, runner);
      return runner;
    }

    phonemeAt(t) {
      const ps = this.phonemes;
      let lo = 0, hi = ps.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ps[mid].end <= t) lo = mid + 1; else if (ps[mid].start > t) hi = mid - 1; else return ps[mid].text;
      }
      return null;
    }

    fit() {
      const [x0, y0, x1, y1] = this.geo.bounds;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = r.width * devicePixelRatio; this.canvas.height = r.height * devicePixelRatio;
      const pad = 40 * devicePixelRatio;
      this.zoom = Math.min((this.canvas.width - 2 * pad) / Math.max(1, x1 - x0), (this.canvas.height - 2 * pad) / Math.max(1, y1 - y0));
      this.panX = this.canvas.width / 2 - (x0 + x1) / 2 * this.zoom;
      this.panY = this.canvas.height / 2 + (y0 + y1) / 2 * this.zoom;   // world y points up
    }

    zoomAt(f, sx, sy) {
      const wx = (sx - this.panX) / this.zoom, wy = (this.panY - sy) / this.zoom;
      this.zoom = clamp(this.zoom * f, 0.02, 60);
      this.panX = sx - wx * this.zoom; this.panY = sy + wy * this.zoom;
    }

    bind() {
      const cv = this.canvas, dpr = () => devicePixelRatio;
      // wheel moves around the layout; Ctrl/⌘ + wheel (or a trackpad pinch) zooms at the cursor
      cv.addEventListener('wheel', ev => {
        ev.preventDefault();
        const r = cv.getBoundingClientRect();
        if (ev.ctrlKey || ev.metaKey) {
          this.zoomAt(Math.exp(-ev.deltaY * 0.0025), (ev.clientX - r.left) * dpr(), (ev.clientY - r.top) * dpr());
        } else {
          const dx = ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX, dy = ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY;
          this.panX -= dx * dpr(); this.panY -= dy * dpr();
        }
      }, { passive: false });
      let drag = null;
      cv.addEventListener('pointerdown', ev => { drag = [ev.clientX, ev.clientY]; cv.setPointerCapture(ev.pointerId); });
      cv.addEventListener('pointermove', ev => {
        if (!drag) return;
        this.panX += (ev.clientX - drag[0]) * dpr(); this.panY += (ev.clientY - drag[1]) * dpr();
        drag = [ev.clientX, ev.clientY];
      });
      cv.addEventListener('pointerup', () => { drag = null; });
      window.addEventListener('resize', () => this.fit());
    }

    // group effects covering this prop right now, as functions of a WORLD position
    groupColors(m, t) {
      const names = this.modelGroups.get(m.name);
      if (!names) return null;
      const out = [];
      for (const gname of names) {
        const G = this.groups.get(gname);
        if (!G) continue;
        for (const e of this.byEl.get(gname) || []) {
          if (t < e.start || t >= e.end) continue;
          const f = shader(e, t, G.W, G.H, this);
          out.push((wx, wy) => f(Math.max(0, Math.min(G.W - 1, Math.round((wx - G.x0) * G.sx))),
            Math.max(0, Math.min(G.H - 1, Math.round((wy - G.y0) * G.sy)))));
        }
      }
      return out.length ? out : null;
    }

    modelColors(m, t) {
      const list = this.byEl.get(m.name);
      if (!list) return null;
      const active = list.filter(e => t >= e.start && t < e.end);
      if (!active.length) return null;
      return active.map(e => shader(e, t, m.W, m.H, this));
    }

    loop() {
      if (!this.canvas.isConnected) return;          // detached (measuring only): no drawing
      const t = this.audio.currentTime || 0;
      const g = this.c2, cw = this.canvas.width, ch = this.canvas.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#05070c'; g.fillRect(0, 0, cw, ch);
      const pick = (fns, x, y) => {
        for (const f of fns) { const c = f(x, y); if (c[0] + c[1] + c[2] > 3) return c; }
        return null;
      };
      for (const m of this.geo.models) {
        if (m.wired === false && !this.showAll) continue;         // props xLights doesn't draw either (no controller)
        const fns = this.modelColors(m, t);
        if (m.rect && this.testShader) {                    // trying a shader: it plays on the matrix the whole time
          const M = this.mtx.get(m.name), d = M.img.data;
          const r = this.testShader.runners.get(m.name) || (() => {
            let x = null; try { x = new ISFShader.ShaderRunner(this.testShader.source, m.W, m.H); } catch (e) { this.testShader.error = e.message; }
            this.testShader.runners.set(m.name, x); return x; })();
          if (r) {
            const px = r.render(t * (this.testShader.speed || 1));
            for (let y = 0; y < m.H; y++) {                   // GL rows run bottom-up, the image top-down
              const src = (m.H - 1 - y) * m.W * 4;
              d.set(px.subarray(src, src + m.W * 4), y * m.W * 4);
            }
            for (let o = 3; o < d.length; o += 4) d[o] = 255;
            M.ctx.putImageData(M.img, 0, 0);
            const [rx, ry, rw, rh] = m.rect;
            g.imageSmoothingEnabled = false;
            g.drawImage(M.cv, this.panX + rx * this.zoom, this.panY - (ry + rh) * this.zoom, rw * this.zoom, rh * this.zoom);
            continue;
          }
        }
        const gfns = this.groupColors(m, t);
        if (m.rect) {                                         // matrix: render its buffer as an image
          const M = this.mtx.get(m.name), d = M.img.data;
          const [rx0, ry0, rw0, rh0] = m.rect;
          for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
            const wx = rx0 + (x + 0.5) / m.W * rw0, wy = ry0 + rh0 - (y + 0.5) / m.H * rh0;
            const c = (gfns && pick(gfns, wx, wy)) || (fns ? pick(fns, x, m.H - 1 - y) : null), o = (y * m.W + x) * 4;
            d[o] = c ? c[0] : 0; d[o + 1] = c ? c[1] : 0; d[o + 2] = c ? c[2] : 0; d[o + 3] = 255;
          }
          M.ctx.putImageData(M.img, 0, 0);
          const [rx, ry, rw, rh] = m.rect;
          g.imageSmoothingEnabled = false;
          g.drawImage(M.cv, this.panX + rx * this.zoom, this.panY - (ry + rh) * this.zoom, rw * this.zoom, rh * this.zoom);
          if (this.showUnlit) { g.strokeStyle = '#1d2638'; g.strokeRect(this.panX + rx * this.zoom, this.panY - (ry + rh) * this.zoom, rw * this.zoom, rh * this.zoom); }
          continue;
        }
        const size = Math.max(1, m.pixelSize * this.pixelScale * devicePixelRatio * 0.5);
        const n = m.nodes;
        for (let i = 0; i < n.length; i += 4) {
          const c = (gfns && pick(gfns, n[i], n[i + 1])) || (fns ? pick(fns, n[i + 2], n[i + 3]) : null);
          if (!c && !this.showUnlit) continue;
          const sx = this.panX + n[i] * this.zoom, sy = this.panY - n[i + 1] * this.zoom;
          if (sx < -size || sy < -size || sx > cw + size || sy > ch + size) continue;
          g.fillStyle = c ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : '#1d2638';
          g.beginPath(); g.arc(sx, sy, size, 0, TAU); g.fill();
        }
      }
      this.onFrame && this.onFrame(t);
      requestAnimationFrame(this.loop);
    }
  }

  // Measure a plan without drawing it: how much of the outdoor display is lit, every
  // `step` seconds. Used by the song page's "Check the show" to find dark stretches the
  // way a person watching would see them (sparse effects count as sparse).
  Preview.measure = async (data, { outdoor, step = 0.25, onProgress } = {}) => {
    const root = document.createElement('div');
    root.innerHTML = '<canvas></canvas><audio></audio>';
    const pv = new Preview(root, data, '');
    const models = data.geometry.models.filter(m => outdoor.has(m.name) && m.wired !== false);
    const res = [];
    const pick = (list, a, b) => { if (!list) return null; for (const f of list) { const c = f(a, b); if (c[0] + c[1] + c[2] > 3) return c; } return null; };
    for (let t = 0, n = 0; t < data.duration; t += step, n++) {
      let lit = 0, tot = 0;
      for (const m of models) {
        let fns = pv.modelColors(m, t), gfns = pv.groupColors(m, t);
        // a shader we couldn't load (folder not connected) counts as lit, not as dark
        const unknown = (pv.byEl.get(m.name) || []).some(e => e.effect === 'Shader' && t >= e.start && t < e.end && !pv.shaderFor(e.settings.E_0FILEPICKERCTRL_IFS || '', m.W, m.H));
        const w = m.rect || m.nodes.length > 200 ? 3 : 1;
        if (unknown) { lit += w * 0.5; tot += w; continue; }
        let ml = 0, mn = 0;
        if (m.rect) {
          for (let y = 0; y < m.H; y += 8) for (let x = 0; x < m.W; x += 8) {
            const wx = m.rect[0] + (x + .5) / m.W * m.rect[2], wy = m.rect[1] + m.rect[3] - (y + .5) / m.H * m.rect[3];
            const c = pick(gfns, wx, wy) || pick(fns, x, m.H - 1 - y); mn++; if (c && Math.max(...c) > 40) ml++;
          }
        } else {
          for (let i = 0; i < m.nodes.length; i += 4) {
            const c = pick(gfns, m.nodes[i], m.nodes[i + 1]) || pick(fns, m.nodes[i + 2], m.nodes[i + 3]); mn++; if (c && Math.max(...c) > 40) ml++;
          }
        }
        lit += w * ml / Math.max(1, mn); tot += w;
      }
      res.push([t, tot ? lit / tot : 0]);
      if (n % 40 === 0) { onProgress && onProgress(t / data.duration); await new Promise(r => setTimeout(r, 0)); }
    }
    return res;
  };

  window.AutoSeqPreview = Preview;
})();
