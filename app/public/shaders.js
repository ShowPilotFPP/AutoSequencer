// ISF shader player for the preview.
//
// xLights' Shader effect plays ISF shaders (.fs files: a JSON header in a comment,
// then GLSL). This compiles one with WebGL, renders it at the prop's own size (e.g.
// 320x180 for the matrix) and hands back the pixels, so the preview can light each
// matrix pixel exactly like any other effect.
//
// Supported: single-pass ISF with float / long / bool / color / point2D inputs, TIME,
// TIMEDELTA, FRAMEINDEX, RENDERSIZE, DATE and isf_FragNormCoord. Image inputs get a
// blank texture; multi-pass shaders run their last pass only (they may look off).
(function () {
  const VERT = 'attribute vec2 p;varying vec2 isf_FragNormCoord;void main(){isf_FragNormCoord=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';

  function parseHeader(src) {
    const m = src.match(/\/\*\s*(\{[\s\S]*?\})\s*\*\//);
    let meta = {};
    if (m) { try { meta = JSON.parse(m[1]); } catch { meta = {}; } }
    const body = m ? src.slice(0, m.index) + src.slice(m.index + m[0].length) : src;
    return { meta, body };
  }

  const TYPES = { float: 'float', long: 'int', bool: 'bool', event: 'bool', color: 'vec4', point2D: 'vec2', image: 'sampler2D', audio: 'sampler2D', audioFFT: 'sampler2D' };

  class ShaderRunner {
    constructor(source, W, H) {
      this.W = W; this.H = H;
      const { meta, body } = parseHeader(source);
      this.meta = meta;
      this.inputs = (meta.INPUTS || []).filter(i => i.NAME && TYPES[i.TYPE]);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const gl = cv.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false })
        || cv.getContext('experimental-webgl', { preserveDrawingBuffer: true });
      if (!gl) throw new Error('This browser has no WebGL, so shaders can\u2019t be previewed.');
      this.gl = gl;
      const decl = this.inputs.map(i => `uniform ${TYPES[i.TYPE]} ${i.NAME};`).join('\n');
      const prefix = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float TIME;uniform float TIMEDELTA;uniform int FRAMEINDEX;uniform vec2 RENDERSIZE;uniform vec4 DATE;uniform int PASSINDEX;
varying vec2 isf_FragNormCoord;
#define IMG_NORM_PIXEL(i,c) texture2D(i,c)
#define IMG_PIXEL(i,c) texture2D(i,(c)/RENDERSIZE)
#define IMG_THIS_PIXEL(i) texture2D(i,isf_FragNormCoord)
#define IMG_THIS_NORM_PIXEL(i) texture2D(i,isf_FragNormCoord)
#define IMG_SIZE(i) RENDERSIZE
${decl}
`;
      // GLSL ES 1.0 can't take a #version line from desktop GLSL
      const frag = prefix + body.replace(/^\s*#version.*$/m, '');
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader did not compile');
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader did not link');
      gl.useProgram(prog);
      this.prog = prog;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = n => gl.getUniformLocation(prog, n);
      // inputs start at the shader's own defaults; image inputs get a blank 1x1 texture
      let unit = 0;
      for (const i of this.inputs) {
        const l = this.u(i.NAME), d = i.DEFAULT;
        if (TYPES[i.TYPE] === 'sampler2D') {
          const tex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
          gl.uniform1i(l, unit++);
        } else this.set(i.NAME, d);
      }
      gl.uniform2f(this.u('RENDERSIZE'), W, H);
      this.pixels = new Uint8Array(W * H * 4);
      this.frame = 0; this.last = 0;
    }

    set(name, value) {
      const gl = this.gl, i = this.inputs.find(x => x.NAME === name), l = this.u(name);
      if (!i || !l) return;
      const t = TYPES[i.TYPE];
      if (t === 'float') gl.uniform1f(l, Number(value ?? i.DEFAULT ?? 0.5));
      else if (t === 'int') gl.uniform1i(l, Math.round(Number(value ?? i.DEFAULT ?? 0)));
      else if (t === 'bool') gl.uniform1i(l, value ?? i.DEFAULT ? 1 : 0);
      else if (t === 'vec4') { const c = value || i.DEFAULT || [1, 1, 1, 1]; gl.uniform4f(l, c[0], c[1], c[2], c[3] ?? 1); }
      else if (t === 'vec2') { const c = value || i.DEFAULT || [0.5, 0.5]; gl.uniform2f(l, c[0], c[1]); }
    }

    // render at shader time t (seconds) and return RGBA pixels, row 0 = bottom
    render(t) {
      const gl = this.gl;
      gl.viewport(0, 0, this.W, this.H);
      gl.uniform1f(this.u('TIME'), t);
      gl.uniform1f(this.u('TIMEDELTA'), Math.max(0, t - this.last));
      gl.uniform1i(this.u('FRAMEINDEX'), this.frame++);
      const d = new Date();
      gl.uniform4f(this.u('DATE'), d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
      this.last = t;
      return this.pixels;
    }

    get name() { return this.meta.DESCRIPTION || ''; }
  }

  window.ISFShader = { ShaderRunner, parseHeader };
})();
