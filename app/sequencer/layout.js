// Read an xLights show (xlights_rgbeffects.xml) into a plain description of
// models, groups and singing-face definitions, and suggest a role for each.
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: n => ['model', 'modelGroup', 'faceInfo', 'subModel'].includes(n) });

function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// bump when parseLayout learns something new, so saved layouts are re-read once
const PARSE_VERSION = 3;

function parseLayout(xml) {
  const root = parser.parse(xml).xrgb;
  if (!root) throw new Error("That isn't an xlights_rgbeffects.xml file.");
  const models = (root.models?.model || []).map(m => ({
    geo: {                                   // what the preview needs to place every pixel
      x: num(m.WorldPosX), y: num(m.WorldPosY), sx: num(m.ScaleX, 1), sy: num(m.ScaleY, 1),
      rz: num(m.RotateZ), x2: num(m.X2), y2: num(m.Y2), pixelSize: num(m.PixelSize, 2),
      strings: num(m.NumStrings, num(m.parm1, 1)), perString: num(m.NodesPerString, num(m.parm2, 1)),
      customW: num(m.CustomWidth, 1), customH: num(m.CustomHeight, 1), custom: m.CustomModel || '',
      // newer xLights saves custom models compressed: "node,row,col;node,row,col;..."
      customCompressed: m.CustomModelCompressed || '',
      points: num(m.StarPoints, 5), startSide: m.StartSide || 'B', dir: m.Dir || 'L',
      top: num(m.TopNodes, 0), side: num(m.SideNodes, 0), bottom: num(m.BottomNodes, 0),
      strandsPerString: num(m.StrandsPerString, 1), bottomTop: num(m.TreeBottomTopRatio, 6),
      perspective: num(m.TreePerspective, 0.2), treeRotation: num(m.TreeRotation, 0),
      wired: !!(m.Controller || '').trim() || !/^!Hue:/.test(m.StartChannel || ''),
    },
    // picture faces: phoneme → image path as saved in xLights (EyesOpen set, else the plain one)
    faceDefs: Object.fromEntries((m.faceInfo || []).filter(f => f.Name).map(f => [f.Name, {
      type: f.Type || '', placement: f.ImagePlacement || '',
      mouths: Object.fromEntries(['AI', 'E', 'etc', 'FV', 'L', 'MBP', 'O', 'U', 'WQ', 'rest']
        .map(ph => [ph, f[`Mouth-${ph}-EyesOpen`] || f[`Mouth-${ph}`] || ''])
        .filter(([, v]) => v && /\.(png|jpe?g|gif|bmp|webp)$/i.test(v))),
    }])),
    name: m.name,
    type: m.DisplayAs,
    x: num(m.WorldPosX), y: num(m.WorldPosY),
    nodes: m.DisplayAs === 'Window Frame' ? num(m.TopNodes) + 2 * num(m.SideNodes) + num(m.BottomNodes) || 1
      : m.DisplayAs === 'Custom' ? (m.CustomModelCompressed ? String(m.CustomModelCompressed).split(';').filter(Boolean).length
        : (String(m.CustomModel || '').match(/\d+/g) || [1]).length)
      : num(m.NodesPerString, 1) * num(m.NumStrings, 1),
    width: m.DisplayAs === 'Matrix' ? num(m.NodesPerString) : null,
    height: m.DisplayAs === 'Matrix' ? num(m.NumStrings) : null,
    controller: m.Controller || '',
    stringType: m.StringType || '',
    faces: (m.faceInfo || []).map(f => f.Name).filter(Boolean),
  }));
  const byName = new Map(models.map(m => [m.name, m]));
  const groups = (root.modelGroups?.modelGroup || []).map(g => ({
    name: g.name,
    members: String(g.models || '').split(',').map(s => s.trim()).filter(Boolean),
  }));
  const version = root.settings?.xlightsVersion?.value || '';
  return { models, groups, version, modelNames: [...byName.keys()], parseVersion: PARSE_VERSION };
}

// Expand names (models or groups, nested groups allowed) to models, sorted left → right.
function expand(layout, names) {
  const models = new Map(layout.models.map(m => [m.name, m]));
  const groups = new Map(layout.groups.map(g => [g.name, g]));
  const out = new Map();
  const walk = (n, depth = 0) => {
    if (depth > 6) return;
    if (models.has(n)) out.set(n, models.get(n));
    else if (groups.has(n)) groups.get(n).members.forEach(m => walk(m, depth + 1));
  };
  names.forEach(n => walk(n));
  return [...out.values()].sort((a, b) => a.x - b.x);
}

const ROLES = [
  { key: 'background', label: 'Background', hint: 'Washes and slow movement under everything. Usually the roofline.' },
  { key: 'bars', label: 'Bar sweeps', hint: 'A sweep across the prop on every bar in the big parts of the song.' },
  { key: 'kick', label: 'Kick drum', hint: 'Short punchy flashes. Floods are perfect.', perMember: true },
  { key: 'snare', label: 'Snare', hint: 'The backbeat. A group of matching props works best.', perMember: true },
  { key: 'toms', label: 'Tom fills', hint: 'Steps across these props left to right during drum fills.', perMember: true },
  { key: 'crash', label: 'Crash cymbals', hint: 'A big flash across the show on crashes.' },
  { key: 'vocals', label: 'Singing face', hint: 'A matrix or prop with a face definition sings the lyrics.' },
  { key: 'matrix', label: 'Matrix visuals', hint: 'Animated backgrounds on a matrix while nobody is singing.' },
  { key: 'canvas', label: 'Whole-display shaders', hint: 'One of your shaders played across these props as a single picture at big moments (chorus openings; instrumental stretches when set to often). Pick a group like Everything.' },
];

// First guess at who does what. Everything here can be changed on the Layout page.
function suggestRoles(layout) {
  const roles = Object.fromEntries(ROLES.map(r => [r.key, []]));
  const { models, groups } = layout;
  const isIndoor = n => /lamp|kitchen|dining|porch|rack|tv|cave|bedroom|office|hue/i.test(n);
  const outdoor = models.filter(m => !isIndoor(m.name) && !isIndoor(m.controller));

  const faceMatrix = outdoor.find(m => m.faces.length && m.type === 'Matrix') || outdoor.find(m => m.faces.length);
  if (faceMatrix) roles.vocals = [faceMatrix.name];
  const matrix = outdoor.find(m => m.type === 'Matrix');
  if (matrix) roles.matrix = [matrix.name];

  // the floods group is the one made of floods (not "Everything WO Floods")
  const floodGroup = groups.find(g => { const ms = expand(layout, [g.name]); return ms.length && ms.every(m => /flood/i.test(m.name)); });
  roles.kick = floodGroup ? [floodGroup.name] : outdoor.filter(m => /flood/i.test(m.name)).map(m => m.name);

  // a group of 3+ identical small props that aren't floods → snare + toms
  const propGroup = groups.find(g => {
    const ms = expand(layout, [g.name]);
    return ms.length >= 3 && !/flood|all|everything/i.test(g.name) && new Set(ms.map(m => m.type)).size === 1
      && ms.every(m => !isIndoor(m.name)) && !['Matrix', 'Tree'].includes(ms[0].type);
  });
  if (propGroup) { roles.snare = [propGroup.name]; roles.toms = [propGroup.name]; }

  const lines = outdoor.filter(m => m.type === 'Single Line' && m.nodes >= 50).sort((a, b) => b.nodes - a.nodes);
  if (lines[0]) { roles.background = [lines[0].name]; roles.bars = [lines[0].name]; }
  // trees are the stars of a Christmas show: they carry the background looks too
  const isTree = m => /^Tree/.test(m.type);
  const treeGroup = groups.find(g => { const ms = expand(layout, [g.name]); return ms.length >= 2 && ms.every(isTree); });
  const trees = treeGroup ? [treeGroup.name] : outdoor.filter(isTree).map(m => m.name);
  if (trees.length) roles.background = [...new Set([...roles.background, ...trees])];
  // a group of stars (tree toppers) joins the crash flash
  const starGroup = groups.find(g => { const ms = expand(layout, [g.name]); return ms.length >= 2 && ms.every(m => m.type === 'Star'); });

  roles.crash = [...new Set([...roles.background, ...roles.kick, ...roles.snare, ...(starGroup ? [starGroup.name] : [])])];
  const everything = groups.find(g => /^(everything|all|whole house|house)$/i.test(g.name));
  roles.canvas = everything ? [everything.name] : [];
  return roles;
}

// Props that are probably inside the house (not part of the outdoor show), by name.
function suggestIndoor(layout) {
  const re = /lamp|kitchen|dining|rack|\btv\b|tv stand|cave|bedroom|office|hue|living room|den\b|garage/i;
  return layout.models.filter(m => re.test(m.name) || (!m.controller && /hue/i.test(m.stringType || ''))).map(m => m.name);
}

module.exports = { parseLayout, expand, suggestRoles, suggestIndoor, ROLES, PARSE_VERSION };
