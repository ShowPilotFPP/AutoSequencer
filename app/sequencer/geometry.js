// Where every pixel of every prop sits, for the in-app preview.
//
// Follows how xLights places models: a line runs from its world position to
// world + (X2, Y2); boxed models (matrix, custom, star, window frame...) are laid
// out in their own buffer and scaled around their world position by ScaleX/ScaleY.
// Each node also gets buffer coordinates (bx, by) in a W×H grid — that's the space
// effects are drawn in, just like xLights' render buffer.
function nodesFor(m) {
  const g = m.geo;
  const out = [];
  const place = (lx, ly) => {                    // local (-0.5..0.5) → world
    const c = Math.cos(-g.rz * Math.PI / 180), s = Math.sin(-g.rz * Math.PI / 180);
    const x = lx * g.W * g.sx, y = ly * g.H * g.sy;
    return [g.x + x * c - y * s, g.y + x * s + y * c];
  };
  switch (m.type) {
    case 'Single Line': case 'Poly Line': {
      const n = Math.max(1, g.strings * g.perString);
      g.W = n; g.H = 1;
      for (let i = 0; i < n; i++) {
        const f = n === 1 ? 0.5 : i / (n - 1);
        out.push({ x: g.x + g.x2 * f, y: g.y + g.y2 * f, bx: i, by: 0 });
      }
      break;
    }
    case 'Matrix': case 'Virtual Matrix': case 'Vert Matrix': case 'Horiz Matrix': {
      const W = Math.max(1, g.perString), H = Math.max(1, g.strings);
      g.W = W; g.H = H;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const [x, y] = place((c + 0.5) / W - 0.5, 0.5 - (r + 0.5) / H);
        out.push({ x, y, bx: c, by: H - 1 - r });
      }
      break;
    }
    case 'Custom': {
      if (!g.custom && g.customCompressed) {           // "node,row,col;..." (layer first when there are 4 numbers)
        const W = Math.max(1, g.customW), H = Math.max(1, g.customH);
        g.W = W; g.H = H;
        for (const cell of g.customCompressed.split(';')) {
          const v = cell.split(',').map(Number);
          if (v.length < 3 || v.some(x => !Number.isFinite(x))) continue;
          const [n, r, c] = v.length >= 4 ? [v[0], v[v.length - 2], v[v.length - 1]] : v;
          const [x, y] = place((c + 0.5) / W - 0.5, 0.5 - (r + 0.5) / H);
          out.push({ x, y, bx: c, by: H - 1 - r, n });
        }
        if (out.length) break;
      }
      const rows = g.custom.split(';');
      // xLights centres a grid that's narrower than its declared width (a 1-node flood
      // in a 2-wide custom model sits in the middle), so use the real grid size
      const W = Math.max(1, Math.min(g.customW, Math.max(...rows.map(r => r.split(',').length))));
      const H = Math.max(1, Math.min(g.customH, rows.length));
      g.W = W; g.H = H;
      rows.forEach((row, r) => row.split(',').forEach((cell, c) => {
        if (!cell.trim()) return;
        const [x, y] = place((c + 0.5) / W - 0.5, 0.5 - (r + 0.5) / H);
        out.push({ x, y, bx: c, by: H - 1 - r, n: parseInt(cell, 10) });
      }));
      if (!out.length) { const [x, y] = place(0, 0); out.push({ x, y, bx: 0, by: 0 }); }
      break;
    }
    case 'Star': {
      const n = Math.max(1, g.strings * g.perString), P = Math.max(3, g.points);
      const size = Math.max(5, Math.round(n * 0.8));       // star buffer, about xLights' size for the node count
      g.W = size; g.H = size;
      const verts = [];
      for (let k = 0; k < 2 * P; k++) {
        const a = Math.PI / 2 + k * Math.PI / P, r = k % 2 ? 0.19 : 0.5;
        verts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      verts.push(verts[0]);
      const seg = verts.slice(1).map((v, i) => Math.hypot(v[0] - verts[i][0], v[1] - verts[i][1]));
      const total = seg.reduce((a, b) => a + b, 0);
      for (let i = 0; i < n; i++) {
        let d = (i / n) * total, k = 0;
        while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; }
        const f = d / seg[k];
        const lx = verts[k][0] + (verts[k + 1][0] - verts[k][0]) * f;
        const ly = verts[k][1] + (verts[k + 1][1] - verts[k][1]) * f;
        const [x, y] = place(lx, ly);
        out.push({ x, y, bx: Math.min(size - 1, Math.floor((lx + 0.5) * size)), by: Math.min(size - 1, Math.floor((ly + 0.5) * size)) });
      }
      break;
    }
    case 'Tree': case 'Tree 360': case 'Tree Flat': case 'Tree Ribbon': {
      // A tree is a set of strands running from the top down. Its effect buffer is
      // strands wide x lights-per-strand high (like xLights). In the house view a 360 tree
      // is drawn as a cone: strands spread around it, narrow at the top (TreeBottomTopRatio).
      // Size: xLights draws a tree about 3.17 x ScaleY tall per light on a strand, which puts
      // the stars in this layout right on the tree tops.
      const strands = Math.max(1, (g.strandsPerString || 1) * Math.max(1, g.strings));
      const per = Math.max(1, Math.round((g.perString * Math.max(1, g.strings)) / strands));
      g.W = strands; g.H = per;
      const height = per * g.sy * 3.17, width = height * 0.6;
      const ratio = Math.max(1, g.bottomTop || 6);
      const flat = m.type === 'Tree Flat';
      const rot = (g.treeRotation || 0) * Math.PI / 180;
      for (let si = 0; si < strands; si++) {
        const ang = rot + (2 * Math.PI * si) / strands;
        for (let k = 0; k < per; k++) {
          const f = per === 1 ? 0 : k / (per - 1);            // 0 = top, 1 = bottom
          const r = (width / 2) * (1 / ratio + (1 - 1 / ratio) * f);
          const x = flat ? (si / Math.max(1, strands - 1) - 0.5) * 2 * r : r * Math.sin(ang);
          const y = height / 2 - f * height - (flat ? 0 : (g.perspective || 0) * r * 0.25 * Math.cos(ang));
          out.push({ x: g.x + x, y: g.y + y, bx: si, by: per - 1 - k });
        }
      }
      break;
    }
    case 'Window Frame': {
      // xLights: TopNodes across the top between two columns of SideNodes, BottomNodes
      // along the bottom. Columns sit on the frame's left/right edges, rows on cell centres.
      const top = Math.max(0, g.top || 0), side = Math.max(1, g.side || 1), bottom = Math.max(0, g.bottom || 0);
      const W = top + 2, H = side;
      g.W = W; g.H = H;
      const at = (c, r) => {                          // c: 0..W-1 (edges at 0 and W-1), r: 0 = top row
        const lx = W > 1 ? c / (W - 1) - 0.5 : 0, ly = 0.5 - (r + 0.5) / H;
        const [x, y] = place(lx, ly);                  // side columns on the frame's edges (as xLights draws it)
        out.push({ x, y, bx: c, by: H - 1 - r });
      };
      for (let r = H - 1; r >= 0; r--) at(0, r);      // left side, bottom → top
      for (let c = 1; c <= top; c++) at(c, 0);        // top, left → right
      for (let r = 0; r < H; r++) at(W - 1, r);       // right side, top → bottom
      for (let c = 0; c < bottom; c++) at(W - 2 - c, H - 1);
      break;
    }
    default: {                                      // anything else: a small grid around its position
      const n = Math.max(1, Math.min(400, g.strings * g.perString));
      const W = Math.ceil(Math.sqrt(n)); g.W = W; g.H = Math.ceil(n / W);
      for (let i = 0; i < n; i++) {
        const c = i % W, r = Math.floor(i / W);
        const [x, y] = place((c + 0.5) / W - 0.5, 0.5 - (r + 0.5) / g.H);
        out.push({ x, y, bx: c, by: g.H - 1 - r });
      }
    }
  }
  return out;
}

// Compact geometry for the browser: per model its buffer size, pixel size and a flat
// array [x, y, bx, by, x, y, bx, by, ...].
function geometry(layout) {
  const models = layout.models.map(m => {
    if (['Matrix', 'Virtual Matrix', 'Vert Matrix', 'Horiz Matrix'].includes(m.type)) {
      // a matrix is drawn as an image, so send its rectangle instead of every pixel
      const g = m.geo, W = Math.max(1, g.perString), H = Math.max(1, g.strings);
      return { name: m.name, type: m.type, W, H, pixelSize: g.pixelSize, nodes: [], wired: g.wired !== false,
        rect: [g.x - W * g.sx / 2, g.y - H * g.sy / 2, W * g.sx, H * g.sy] };
    }
    const nodes = nodesFor(m);
    const flat = new Array(nodes.length * 4);
    nodes.forEach((p, i) => { flat[i * 4] = +p.x.toFixed(1); flat[i * 4 + 1] = +p.y.toFixed(1); flat[i * 4 + 2] = p.bx; flat[i * 4 + 3] = p.by; });
    return { name: m.name, type: m.type, W: m.geo.W, H: m.geo.H, pixelSize: m.geo.pixelSize, nodes: flat, wired: m.geo.wired !== false };
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of models) if (m.rect) {
    x0 = Math.min(x0, m.rect[0]); y0 = Math.min(y0, m.rect[1]);
    x1 = Math.max(x1, m.rect[0] + m.rect[2]); y1 = Math.max(y1, m.rect[1] + m.rect[3]);
  }
  for (const m of models) for (let i = 0; i < m.nodes.length; i += 4) {
    x0 = Math.min(x0, m.nodes[i]); x1 = Math.max(x1, m.nodes[i]);
    y0 = Math.min(y0, m.nodes[i + 1]); y1 = Math.max(y1, m.nodes[i + 1]);
  }
  // groups, for effects that paint several props as one picture (xLights "Per Preview")
  const { expand } = require('./layout');
  const groups = layout.groups.map(g => ({ name: g.name, members: expand(layout, [g.name]).map(m => m.name) }))
    .filter(g => g.members.length);
  return { models, groups, bounds: [x0, y0, x1, y1] };
}

module.exports = { geometry };
