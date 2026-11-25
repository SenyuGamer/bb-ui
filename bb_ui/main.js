// bb_ui Regolith filter: generates 3D UI entities (BP + RP), the script registry and the runtime copy
// from <data>/<dataPath>/<id>/ui.json + geo.json + texture.png. Zero npm dependencies; runs under node and bun.
// Contract: docs/CONTRACT.md (sections 1-3).
//
// Regolith runs filters with cwd = the tmp dir that holds BP/, RP/ and data/. Settings arrive as a JSON
// string in process.argv[2].
const fs = require('fs');
const path = require('path');
const { Canvas } = require('./lib/png.js');
const MIN_SERVER_VERSION = '2.8.0'; // lowest version checked: all runtime APIs are in the 2.8.0 typings; it may also work on older versions

function readSettings() {
  let s = {};
  if (process.argv[2]) {
    try { s = JSON.parse(process.argv[2]); } catch (e) { console.warn(`[bb_ui] settings are not valid JSON, using defaults: ${e.message}`); }
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : d);
  const out = {
    dataPath: str(s.dataPath, 'bb_ui'),
    scriptsPath: str(s.scriptsPath, 'bb_ui'),
    autoImport: s.autoImport === undefined ? true : !!s.autoImport,
    defaultNamespace: str(s.defaultNamespace, 'bbui'),
  };
  for (const k of ['dataPath', 'scriptsPath']) {
    if (out[k].split('/').includes('..')) { console.error(`[bb_ui] setting ${k} must not contain ".."`); process.exit(1); }
  }
  return out;
}
const SETTINGS = readSettings();

// Regolith runs filters with cwd = <.regolith>/tmp
const TMP_DIR = process.cwd();
const DATA_DIR = path.join(TMP_DIR, 'data', SETTINGS.dataPath);
const T_BP = path.join(TMP_DIR, 'BP');
const T_RP = path.join(TMP_DIR, 'RP');
const RUNTIME_SRC = path.join(__dirname, 'runtime');
const SCRIPTS_DIR = path.join(T_BP, 'scripts', SETTINGS.scriptsPath);

const MAX_PROPERTIES = 32;
const DIGIT_Z_OFFSET = 0.2; // px in front of the number bone
const OPS = ['==', '!=', '>', '>=', '<', '<='];
const ELEMENT_TYPES = ['button', 'image', 'model', 'number'];
const PERMISSIONS = ['any', 'gamedirectors', 'admin'];
const QUERY_SOURCES = ['dynamic_property', 'script', 'scoreboard'];

const errors = [];
function err(uiId, msg) {
  errors.push(`[bb_ui:${uiId}] ${msg}`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function writeJson(file, data) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function copyDir(src, dst, skip) {
  mkdirp(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}
function readJsonIfExists(...candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const NAME_RE = /^[a-z0-9_]+$/;
const ID_RE = /^[a-z0-9_]+:[a-z0-9_]+$/;

// ---------------------------------------------------------------- geo helpers
function loadGeo(uiId, file) {
  let geo;
  try {
    geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(uiId, `geo.json no se puede leer: ${e.message}`);
    return null;
  }
  const list = geo['minecraft:geometry'];
  if (!Array.isArray(list) || list.length !== 1) {
    err(uiId, 'geo.json debe tener exactamente un "minecraft:geometry" (format_version 1.12.0+)');
    return null;
  }
  const g = list[0];
  if (!g.description || !Array.isArray(g.bones)) {
    err(uiId, 'geo.json: falta description o bones');
    return null;
  }
  return geo;
}

function boneBounds(bone) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const c of bone.cubes || []) {
    if (!c.origin || !c.size) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], c.origin[i]);
      max[i] = Math.max(max[i], c.origin[i] + c.size[i]);
    }
  }
  if (!isFinite(min[0])) return null;
  return { min, max };
}

// ---------------------------------------------------------------- validation + normalization
function validate(uiId, ui, geoBones, usedGlobal) {
  if (ui.format_version !== 1) err(uiId, 'format_version debe ser 1');
  if (ui.id !== uiId) err(uiId, `id "${ui.id}" no coincide con la carpeta "${uiId}"`);
  if (!NAME_RE.test(uiId)) err(uiId, 'el id de la carpeta debe cumplir [a-z0-9_]+');
  if (typeof ui.namespace !== 'string' || !NAME_RE.test(ui.namespace)) {
    err(uiId, 'namespace invalido ([a-z0-9_]+)');
    return null;
  }
  const NS = ui.namespace;
  const d = ui.display;
  if (!isObj(d)) err(uiId, 'falta "display"');
  else {
    for (const k of ['fov', 'distance', 'height']) {
      if (typeof d[k] !== 'number') err(uiId, `display.${k} debe ser numero`);
    }
    if (d.anchor !== 'player' && d.anchor !== 'trigger') err(uiId, 'display.anchor debe ser "player" o "trigger"');
  }

  const queries = ui.queries || {};
  for (const [q, def] of Object.entries(queries)) {
    if (!isObj(def) || !QUERY_SOURCES.includes(def.source)) {
      err(uiId, `queries.${q}: source invalido (${QUERY_SOURCES.join(' | ')})`);
      continue;
    }
    if (def.source === 'dynamic_property' && typeof def.key !== 'string') err(uiId, `queries.${q}: falta key`);
    if (def.source === 'script' && typeof def.fn !== 'string') err(uiId, `queries.${q}: falta fn`);
    if (def.source === 'scoreboard' && typeof def.objective !== 'string') err(uiId, `queries.${q}: falta objective`);
  }

  // open methods
  if (!Array.isArray(ui.open) || ui.open.length === 0) err(uiId, '"open" debe tener al menos un metodo');
  for (const o of ui.open || []) {
    if (!isObj(o)) { err(uiId, 'open: entrada invalida'); continue; }
    if (o.type === 'item' || o.type === 'block') {
      const id = o[o.type];
      if (typeof id !== 'string' || !ID_RE.test(id)) { err(uiId, `open ${o.type}: id invalido "${id}"`); continue; }
      if (o.generate) {
        if (!isObj(o.generate) || typeof o.generate.name !== 'string' || typeof o.generate.texture !== 'string') {
          err(uiId, `open ${o.type} ${id}: generate necesita name y texture`);
        }
        if (usedGlobal.generated.has(id)) err(uiId, `${o.type} generado duplicado: ${id}`);
        usedGlobal.generated.add(id);
      }
    } else if (o.type === 'entity') {
      if (typeof o.entity !== 'string' || !ID_RE.test(o.entity)) err(uiId, `open entity: id invalido "${o.entity}"`);
    } else if (o.type === 'command') {
      if (typeof o.name !== 'string' || !ID_RE.test(o.name)) err(uiId, `open command: name invalido "${o.name}" (namespace:name)`);
      else {
        if (usedGlobal.commands.has(o.name)) err(uiId, `comando duplicado: ${o.name}`);
        usedGlobal.commands.add(o.name);
      }
      if (o.permission !== undefined && !PERMISSIONS.includes(o.permission)) {
        err(uiId, `open command ${o.name}: permission debe ser ${PERMISSIONS.join(' | ')}`);
      }
    } else {
      err(uiId, `open: type invalido "${o.type}"`);
    }
  }

  // screens
  if (!Array.isArray(ui.screens) || ui.screens.length === 0) {
    err(uiId, '"screens" debe tener al menos una pantalla');
    return null;
  }
  const screenIds = new Set();
  for (const s of ui.screens) {
    if (!isObj(s) || typeof s.id !== 'string') { err(uiId, 'screen sin id'); continue; }
    if (screenIds.has(s.id)) err(uiId, `screen duplicada: ${s.id}`);
    screenIds.add(s.id);
  }
  if (!screenIds.has(ui.start_screen)) err(uiId, `start_screen "${ui.start_screen}" no existe`);

  const needBone = (b, where) => {
    if (typeof b !== 'string' || !geoBones.has(b)) err(uiId, `${where}: el hueso "${b}" no existe en geo.json`);
  };
  const checkQuery = (q, where) => {
    if (typeof q !== 'string' || !queries[q]) err(uiId, `${where}: query "${q}" no esta declarada en "queries"`);
  };
  const checkAction = (a, where) => {
    if (!isObj(a)) { err(uiId, `${where}: action invalida`); return; }
    switch (a.type) {
      case 'goto':
        if (!screenIds.has(a.screen)) err(uiId, `${where}: goto a screen inexistente "${a.screen}"`);
        break;
      case 'back':
      case 'close':
        break;
      case 'command':
        if (typeof a.command !== 'string' || !a.command) err(uiId, `${where}: command vacio`);
        else if (a.command.startsWith('/')) err(uiId, `${where}: command sin "/"`);
        if (a.as !== undefined && a.as !== 'player' && a.as !== 'server') err(uiId, `${where}: as debe ser "player" o "server"`);
        break;
      case 'script':
        if (typeof a.fn !== 'string' || !a.fn) err(uiId, `${where}: script sin fn`);
        if (a.args !== undefined && !isObj(a.args)) err(uiId, `${where}: args debe ser objeto`);
        break;
      case 'set':
        if (typeof a.key !== 'string' || !a.key) err(uiId, `${where}: set sin key`);
        if (a.value === undefined) err(uiId, `${where}: set sin value`);
        break;
      case 'add':
        if (typeof a.key !== 'string' || !a.key) err(uiId, `${where}: add sin key`);
        if (typeof a.amount !== 'number') err(uiId, `${where}: add.amount debe ser numero`);
        for (const k of ['min', 'max']) if (a[k] !== undefined && typeof a[k] !== 'number') err(uiId, `${where}: add.${k} debe ser numero`);
        break;
      case 'sequence':
        if (!Array.isArray(a.actions) || a.actions.length === 0) err(uiId, `${where}: sequence sin actions`);
        else a.actions.forEach((x, i) => checkAction(x, `${where}.actions[${i}]`));
        break;
      default:
        err(uiId, `${where}: action type invalido "${a.type}"`);
    }
  };

  let numberCount = 0;
  let condCount = 0;
  let maxButtons = 0;
  for (const s of ui.screens) {
    if (!isObj(s) || typeof s.id !== 'string') continue;
    const where = `screen ${s.id}`;
    for (const b of s.bones || []) needBone(b, `${where}.bones`);
    const buttons = [];
    const seen = new Set();
    for (const e of s.elements || []) {
      const ew = `${where} elemento ${e && e.bone}`;
      if (!isObj(e)) { err(uiId, `${where}: elemento invalido`); continue; }
      needBone(e.bone, ew);
      if (seen.has(e.bone)) err(uiId, `${ew}: hueso repetido en la pantalla`);
      seen.add(e.bone);
      if (!ELEMENT_TYPES.includes(e.type)) { err(uiId, `${ew}: type invalido "${e.type}"`); continue; }
      if (e.visible_if !== undefined) {
        const v = e.visible_if;
        if (!isObj(v) || !OPS.includes(v.op) || typeof v.value !== 'number') err(uiId, `${ew}: visible_if invalido (query, op, value numerico)`);
        else checkQuery(v.query, `${ew}.visible_if`);
        condCount++;
      }
      if (e.type === 'button') {
        buttons.push(e.bone);
        if (e.action === undefined) err(uiId, `${ew}: el boton necesita action`);
        else checkAction(e.action, `${ew}.action`);
        if (e.highlight !== undefined) needBone(e.highlight, `${ew}.highlight`);
      } else {
        if (e.action !== undefined) err(uiId, `${ew}: solo los botones llevan action`);
        if (e.highlight !== undefined) err(uiId, `${ew}: solo los botones llevan highlight`);
      }
      if (e.type === 'number') {
        numberCount++;
        checkQuery(e.query, ew);
        if (!Number.isInteger(e.digits) || e.digits < 1 || e.digits > 9) err(uiId, `${ew}: digits debe ser entero 1-9`);
        if (e.align !== undefined && !['left', 'center', 'right'].includes(e.align)) err(uiId, `${ew}: align invalido`);
      }
    }
    // nav / default_focus refer to buttons of the screen
    for (const e of s.elements || []) {
      if (isObj(e) && e.nav !== undefined) {
        if (!isObj(e.nav)) { err(uiId, `${where} ${e.bone}: nav invalido`); continue; }
        for (const [dir, tgt] of Object.entries(e.nav)) {
          if (!['up', 'down', 'left', 'right'].includes(dir)) err(uiId, `${where} ${e.bone}: nav.${dir} no es una direccion`);
          else if (tgt !== null && !buttons.includes(tgt)) err(uiId, `${where} ${e.bone}: nav.${dir} apunta a "${tgt}", que no es un boton de la pantalla`);
        }
      }
    }
    if (s.default_focus !== undefined && s.default_focus !== null && !buttons.includes(s.default_focus)) {
      err(uiId, `${where}: default_focus "${s.default_focus}" no es un boton de la pantalla`);
    }
    if (typeof s.actionbar === 'string') {
      for (const m of s.actionbar.matchAll(/\{(\w+)\}/g)) checkQuery(m[1], `${where}.actionbar`);
    }
    maxButtons = Math.max(maxButtons, buttons.length);
  }

  const propCount = 3 + numberCount + condCount;
  if (propCount > MAX_PROPERTIES) {
    err(uiId, `demasiadas propiedades de entidad: ${propCount} (maximo ${MAX_PROPERTIES}: 3 base + ${numberCount} numeros + ${condCount} visible_if)`);
  }
  return { NS, maxButtons };
}

// ---------------------------------------------------------------- generation
// 3x5 pixel font for digits 0-9, scaled up when drawn.
const FONT = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '001', '010', '010'],
  ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
];
const GLYPH_SCALE = 4;
const GLYPH_W = 3 * GLYPH_SCALE;
const GLYPH_H = 5 * GLYPH_SCALE;
const DIGITS_TEX_W = GLYPH_W * 10;
const DIGITS_TEX_H = GLYPH_H;

function writeDigitsTexture(outPath) {
  const img = new Canvas(DIGITS_TEX_W, DIGITS_TEX_H);
  for (let d = 0; d < 10; d++) {
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        if (FONT[d][y][x] !== '1') continue;
        for (let sy = 0; sy < GLYPH_SCALE; sy++) {
          for (let sx = 0; sx < GLYPH_SCALE; sx++) {
            img.set(d * GLYPH_W + x * GLYPH_SCALE + sx, y * GLYPH_SCALE + sy, 255, 255, 255, 255);
          }
        }
      }
    }
  }
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, img.toPng());
}

function buildDigitsGeo(ID, numbers, boneMap) {
  // numbers: [{bone, digits, k}]
  const bones = [];
  for (const n of numbers) {
    const src = boneMap.get(n.bone);
    const b = boneBounds(src) || (() => {
      const p = src.pivot || [0, 0, 0];
      return { min: [p[0] - 6, p[1] - 2, p[2]], max: [p[0] + 6, p[1] + 2, p[2]] };
    })();
    const W = b.max[0] - b.min[0];
    const H = b.max[1] - b.min[1];
    const cw = W / n.digits;
    const gw = Math.min(cw * 0.8, ((H * 0.8) * 3) / 5);
    const gh = (gw * 5) / 3;
    const z = b.min[2] - DIGIT_Z_OFFSET;
    const y = b.min[1] + (H - gh) / 2;
    for (let p = 0; p < n.digits; p++) {
      // position p counted from the right
      const cellX = b.min[0] + (n.digits - 1 - p) * cw;
      const x = cellX + (cw - gw) / 2;
      for (let d = 0; d < 10; d++) {
        bones.push({
          name: `${n.bone}_${p}_${d}`,
          pivot: [round(x + gw / 2), round(y + gh / 2), round(z)],
          cubes: [{
            origin: [round(x), round(y), round(z)],
            size: [round(gw), round(gh), 0],
            uv: { north: { uv: [d * GLYPH_W, 0], uv_size: [GLYPH_W, GLYPH_H] } },
          }],
        });
      }
    }
  }
  return {
    format_version: '1.12.0',
    'minecraft:geometry': [{
      description: {
        identifier: `geometry.bb_ui.${ID}.digits`,
        texture_width: DIGITS_TEX_W,
        texture_height: DIGITS_TEX_H,
        visible_bounds_width: 4,
        visible_bounds_height: 4,
        visible_bounds_offset: [0, 1, 0],
      },
      bones,
    }],
  };
}
const round = (v) => Math.round(v * 1000) / 1000;

async function generateUi(uiId, ui, geo, ctx) {
  const { NS, maxButtons } = ctx;
  const ID = uiId;
  const P = (n) => `q.property('${NS}:${n}')`;
  const geoDesc = geo['minecraft:geometry'][0];
  const boneMap = new Map(geoDesc.bones.map((b) => [b.name, b]));

  const screenIndex = {};
  ui.screens.forEach((s, i) => { screenIndex[s.id] = i; });

  // global indices
  const buttons = {};
  const numbers = {};
  const conditions = {};
  const numberList = [];
  let nk = 0;
  let vk = 0;
  // bone -> conditions
  const boneConds = new Map();
  const addCond = (bone, expr) => {
    if (!boneConds.has(bone)) boneConds.set(bone, []);
    boneConds.get(bone).push(expr);
  };
  const digitConds = []; // for digits controller
  const focusAnims = []; // {s, i, bone}
  const normScreens = ui.screens.map((s, si) => {
    const scr = `${P('screen')} == ${si}`;
    buttons[s.id] = [];
    for (const b of s.bones || []) addCond(b, scr);
    for (const e of s.elements || []) {
      let expr = scr;
      if (e.visible_if) {
        conditions[e.bone] = vk;
        expr += ` && ${P('v' + vk)}`;
        vk++;
      }
      addCond(e.bone, expr);
      if (e.type === 'button') {
        const i = buttons[s.id].length;
        buttons[s.id].push(e.bone);
        focusAnims.push({ s: si, i, bone: e.bone });
        if (e.highlight) addCond(e.highlight, `${scr} && ${P('focus')} == ${i}`);
      }
      if (e.type === 'number') {
        numbers[e.bone] = nk;
        numberList.push({ bone: e.bone, digits: e.digits, k: nk, expr });
        nk++;
      }
    }
    const defIdx = s.default_focus ? buttons[s.id].indexOf(s.default_focus) : 0;
    return { ...s, defaultFocusIndex: Math.max(defIdx, 0) };
  });
  // a bone used as an element in several screens may collide with k indices (conditions keyed by bone): keep last, fine.

  const bonePos = {};
  for (const b of geoDesc.bones) bonePos[b.name] = b.pivot ? [...b.pivot] : [0, 0, 0];

  // ---- BP entity
  const props = {};
  props[`${NS}:viewer`] = { type: 'bool', default: false, client_sync: true };
  props[`${NS}:screen`] = { type: 'int', range: [0, Math.max(ui.screens.length - 1, 1)], default: screenIndex[ui.start_screen], client_sync: true };
  props[`${NS}:focus`] = { type: 'int', range: [0, Math.max(maxButtons, 1)], default: 0, client_sync: true };
  for (let k = 0; k < nk; k++) props[`${NS}:n${k}`] = { type: 'int', range: [0, 999999999], default: 0, client_sync: true };
  for (let k = 0; k < vk; k++) props[`${NS}:v${k}`] = { type: 'bool', default: false, client_sync: true };
  const entityId = `${NS}:ui_${ID}`;
  writeJson(path.join(T_BP, `entities/bb_ui/${ID}.json`), {
    format_version: '1.21.0',
    'minecraft:entity': {
      description: {
        identifier: entityId,
        is_spawnable: false,
        is_summonable: true,
        is_experimental: false,
        properties: props,
      },
      components: {
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:collision_box': { width: 0.0001, height: 0.0001 },
        'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: false },
        'minecraft:damage_sensor': { triggers: { cause: 'all', deals_damage: 'no' } },
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:type_family': { family: ['bb_ui'] },
      },
    },
  });

  // ---- generated items / blocks
  const itemTex = readJsonIfExists(path.join(T_RP, 'textures/item_texture.json'))
    || { resource_pack_name: 'bb_ui', texture_name: 'atlas.items', texture_data: {} };
  const terrain = readJsonIfExists(path.join(T_RP, 'textures/terrain_texture.json'))
    || { resource_pack_name: 'bb_ui', texture_name: 'atlas.terrain', texture_data: {} };
  itemTex.texture_data = itemTex.texture_data || {};
  terrain.texture_data = terrain.texture_data || {};
  let itemTexDirty = false;
  let terrainDirty = false;
  const langLines = [];
  for (const o of ui.open) {
    if (!o.generate) continue;
    if (o.type === 'item') {
      const [ins, iname] = o.item.split(':');
      const key = `${ins}_ui_item_${iname}`;
      writeJson(path.join(T_BP, `items/bb_ui/${iname}.json`), {
        format_version: '1.21.0',
        'minecraft:item': {
          description: { identifier: o.item, menu_category: { category: 'items' } },
          components: {
            'minecraft:icon': { textures: { default: key } },
            'minecraft:max_stack_size': 1,
          },
        },
      });
      itemTex.texture_data[key] = { textures: o.generate.texture };
      itemTexDirty = true;
      langLines.push(`item.${o.item}=${o.generate.name}`);
    } else if (o.type === 'block') {
      const [bns, bname] = o.block.split(':');
      const key = `${bns}_ui_block_${bname}`;
      writeJson(path.join(T_BP, `blocks/bb_ui/${bname}.json`), {
        format_version: '1.21.30',
        'minecraft:block': {
          description: { identifier: o.block, menu_category: { category: 'items' } },
          components: {
            'minecraft:geometry': 'minecraft:geometry.full_block',
            'minecraft:material_instances': { '*': { texture: key, render_method: 'opaque' } },
          },
        },
      });
      terrain.texture_data[key] = { textures: o.generate.texture };
      terrainDirty = true;
      langLines.push(`tile.${o.block}.name=${o.generate.name}`);
    }
  }
  if (itemTexDirty) writeJson(path.join(T_RP, 'textures/item_texture.json'), itemTex);
  if (terrainDirty) writeJson(path.join(T_RP, 'textures/terrain_texture.json'), terrain);

  // ---- RP geometry / textures
  const geoOut = JSON.parse(JSON.stringify(geo));
  geoOut['minecraft:geometry'][0].description.identifier = `geometry.bb_ui.${ID}`;
  writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}.geo.json`), geoOut);
  mkdirp(path.join(T_RP, 'textures/bb_ui'));
  fs.copyFileSync(path.join(DATA_DIR, ID, 'texture.png'), path.join(T_RP, `textures/bb_ui/${ID}.png`));
  const hasDigits = numberList.length > 0;
  if (hasDigits) {
    writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}_digits.geo.json`), buildDigitsGeo(ID, numberList, boneMap));
  }

  // ---- render controllers
  const viewer = P('viewer');
  const partVis = [{ '*': viewer }];
  for (const [bone, conds] of boneConds) {
    const uniq = [...new Set(conds)];
    const body = uniq.length === 1 ? uniq[0] : uniq.map((c) => `(${c})`).join(' || ');
    partVis.push({ [bone]: `${viewer} && (${body})` });
  }
  const rcMain = {
    geometry: 'Geometry.default',
    materials: [{ '*': 'Material.default' }],
    textures: ['Texture.default'],
    ignore_lighting: true,
    part_visibility: partVis,
  };
  const rcs = { [`controller.render.bb_ui.${ID}`]: rcMain };
  if (hasDigits) {
    const dv = [{ '*': 'false' }];
    for (const n of numberList) {
      for (let p = 0; p < n.digits; p++) {
        for (let d = 0; d < 10; d++) {
          let expr = `${viewer} && (${n.expr}) && math.mod(math.floor(${P('n' + n.k)} / math.pow(10, ${p})), 10) == ${d}`;
          if (p > 0) expr += ` && ${P('n' + n.k)} >= math.pow(10, ${p})`;
          dv.push({ [`${n.bone}_${p}_${d}`]: expr });
        }
      }
    }
    rcs[`controller.render.bb_ui.${ID}.digits`] = {
      geometry: 'Geometry.digits',
      materials: [{ '*': 'Material.default' }],
      textures: ['Texture.digits'],
      ignore_lighting: true,
      part_visibility: dv,
    };
  }
  writeJson(path.join(T_RP, `render_controllers/bb_ui/${ID}.json`), {
    format_version: '1.8.0',
    render_controllers: rcs,
  });

  // ---- animations (focus)
  const anims = {};
  const animRefs = {};
  const animate = [];
  for (const f of focusAnims) {
    const name = `focus_${f.s}_${f.i}`;
    const full = `animation.bb_ui.${ID}.${name}`;
    anims[full] = {
      loop: true,
      animation_length: 1,
      bones: { [f.bone]: { scale: 1.08 } },
    };
    animRefs[name] = full;
    animate.push({ [name]: `${P('screen')} == ${f.s} && ${P('focus')} == ${f.i}` });
  }
  if (focusAnims.length) {
    writeJson(path.join(T_RP, `animations/bb_ui/${ID}.animation.json`), { format_version: '1.8.0', animations: anims });
  }

  // ---- client entity
  const desc = {
    identifier: entityId,
    materials: { default: 'entity_alphatest' },
    textures: { default: `textures/bb_ui/${ID}` },
    geometry: { default: `geometry.bb_ui.${ID}` },
    render_controllers: [`controller.render.bb_ui.${ID}`],
  };
  if (hasDigits) {
    desc.textures.digits = 'textures/bb_ui/digits';
    desc.geometry.digits = `geometry.bb_ui.${ID}.digits`;
    desc.render_controllers.push(`controller.render.bb_ui.${ID}.digits`);
  }
  if (focusAnims.length) {
    desc.animations = animRefs;
    desc.scripts = { animate };
  }
  writeJson(path.join(T_RP, `entity/bb_ui/${ID}.entity.json`), {
    format_version: '1.10.0',
    'minecraft:client_entity': { description: desc },
  });

  // ---- registry entry
  const entry = {
    ...ui,
    screens: normScreens,
    entity: entityId,
    screenIndex,
    buttons,
    numbers,
    conditions,
    bonePos,
  };
  return { entry, hasDigits, langLines };
}

// ---------------------------------------------------------------- manifest / lang integration
const importLine = (rel) => `import "${rel}";`;
const newUuid = () => require('crypto').randomUUID();

function parseVersion(v) {
  if (Array.isArray(v)) return v.map((n) => Number(n) || 0);
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Warns when the BP manifest's @minecraft/server dependency is older than the runtime needs. */
function checkServerVersion(manifest) {
  const dep = (manifest.dependencies || []).find((d) => d && d.module_name === '@minecraft/server');
  if (!dep) return;
  const v = parseVersion(dep.version);
  if (!v) return; // uuid dependency or unparsable: nothing to compare
  if (cmpVersion(v, parseVersion(MIN_SERVER_VERSION)) < 0) {
    console.warn(`[bb_ui] WARNING: BP manifest uses @minecraft/server ${dep.version}; BB UI needs ${MIN_SERVER_VERSION} or newer.`);
  }
}

/** Prepends the runtime import to the BP script entry (creating the script module when there is none). */
function autoImport() {
  const manifestPath = path.join(T_BP, 'manifest.json');
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest) {
    console.warn('[bb_ui] WARNING: no BP/manifest.json, cannot auto-import the runtime. Import it from your script yourself.');
    return;
  }
  checkServerVersion(manifest);
  manifest.modules = manifest.modules || [];
  manifest.dependencies = manifest.dependencies || [];
  let mod = manifest.modules.find((m) => m && m.type === 'script' && typeof m.entry === 'string');
  let manifestDirty = false;
  if (!mod) {
    console.warn(`[bb_ui] WARNING: BP manifest has no script module; adding one (entry scripts/main.js) with @minecraft/server ${MIN_SERVER_VERSION}.`);
    mod = { type: 'script', language: 'javascript', uuid: newUuid(), version: [1, 0, 0], entry: 'scripts/main.js' };
    manifest.modules.push(mod);
    manifestDirty = true;
  }
  if (!manifest.dependencies.some((d) => d && d.module_name === '@minecraft/server')) {
    manifest.dependencies.push({ module_name: '@minecraft/server', version: MIN_SERVER_VERSION });
    manifestDirty = true;
  }
  if (manifestDirty) writeJson(manifestPath, manifest);

  const entryPath = path.join(T_BP, mod.entry);
  let rel = path.posix.relative(path.posix.dirname(mod.entry), `scripts/${SETTINGS.scriptsPath}/index.js`);
  if (!rel.startsWith('.')) rel = './' + rel;
  const line = importLine(rel);
  let code = fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : '';
  if (code.split(String.fromCharCode(10)).some((l) => l.trim() === line)) return;
  mkdirp(path.dirname(entryPath));
  fs.writeFileSync(entryPath, `${line}\n${code}`);
  console.log(`  auto-import: ${mod.entry} <- ${line}`);
}

function appendLang(langLines) {
  if (!langLines.length) return;
  const textsDir = path.join(T_RP, 'texts');
  mkdirp(textsDir);
  let files = fs.readdirSync(textsDir).filter((f) => f.endsWith('.lang'));
  if (files.length === 0) {
    files = ['en_US.lang'];
    const langsPath = path.join(textsDir, 'languages.json');
    const langs = readJsonIfExists(langsPath) || [];
    if (Array.isArray(langs) && !langs.includes('en_US')) {
      langs.push('en_US');
      writeJson(langsPath, langs);
    }
  }
  for (const f of files) {
    const p = path.join(textsDir, f);
    let lang = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (lang.length && !lang.endsWith('\n')) lang += '\n';
    lang += langLines.join('\n') + '\n';
    fs.writeFileSync(p, lang);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`[bb_ui] no data/${SETTINGS.dataPath} folder, nothing to do`);
    return;
  }
  const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (dirs.length === 0) {
    console.log('[bb_ui] no UIs found, nothing to do');
    return;
  }
  console.log('=== BB UI Filter ===');
  const usedGlobal = { commands: new Set(), generated: new Set() };
  const loaded = [];
  for (const id of dirs) {
    const dir = path.join(DATA_DIR, id);
    const uiPath = path.join(dir, 'ui.json');
    const geoPath = path.join(dir, 'geo.json');
    const texPath = path.join(dir, 'texture.png');
    let ok = true;
    for (const f of [uiPath, geoPath, texPath]) {
      if (!fs.existsSync(f)) { err(id, `falta ${path.basename(f)}`); ok = false; }
    }
    if (!ok) continue;
    let ui;
    try {
      ui = JSON.parse(fs.readFileSync(uiPath, 'utf8'));
    } catch (e) {
      err(id, `ui.json no es JSON valido: ${e.message}`);
      continue;
    }
    if (isObj(ui) && ui.namespace === undefined) ui.namespace = SETTINGS.defaultNamespace;
    const geo = loadGeo(id, geoPath);
    if (!geo) continue;
    const geoBones = new Set(geo['minecraft:geometry'][0].bones.map((b) => b.name));
    const ctx = validate(id, ui, geoBones, usedGlobal);
    if (ctx) loaded.push({ id, ui, geo, ctx });
  }
  if (errors.length) {
    console.error('\n[bb_ui] ERRORES DE VALIDACION:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }

  const registry = {};
  const langLines = [];
  let anyDigits = false;
  for (const { id, ui, geo, ctx } of loaded) {
    const { entry, hasDigits, langLines: ll } = await generateUi(id, ui, geo, ctx);
    registry[id] = entry;
    langLines.push(...ll);
    anyDigits = anyDigits || hasDigits;
    console.log(`  ${id}: ${ui.screens.length} screens, entity ${entry.entity}${hasDigits ? ', digits' : ''}`);
  }
  if (anyDigits) writeDigitsTexture(path.join(T_RP, 'textures/bb_ui/digits.png'));
  appendLang(langLines);

  // runtime + generated registry
  copyDir(RUNTIME_SRC, SCRIPTS_DIR, (name) => name === 'README.md');
  const code = `// GENERATED BY bb_ui filter - DO NOT EDIT\nexport const UI_REGISTRY = ${JSON.stringify(registry, null, 2)};\n`;
  mkdirp(path.join(SCRIPTS_DIR, 'generated'));
  fs.writeFileSync(path.join(SCRIPTS_DIR, 'generated/ui_registry.js'), code);

  if (SETTINGS.autoImport) autoImport();
  else console.log(`  autoImport off: import "scripts/${SETTINGS.scriptsPath}/index.js" from your own script`);
  console.log(`=== Done: ${loaded.length} UI(s) ===`);
}

main().catch((e) => {
  console.error('[bb_ui] Filter failed:', e);
  process.exit(1);
});
