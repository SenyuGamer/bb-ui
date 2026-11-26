// bb_ui Regolith filter: generates 3D UI entities (BP + RP), the script registry and the runtime copy
// from <data>/<dataPath>/<id>/ui.json + geo.json + texture.png. Zero npm dependencies; runs under node and bun.
// Contract: docs/CONTRACT.md (sections 1-3).
//
// Regolith runs filters with cwd = the tmp dir that holds BP/, RP/ and data/. Settings arrive as a JSON
// string in process.argv[2].
const fs = require('fs');
const path = require('path');
const { Canvas } = require('./lib/png.js');
const SERVER_UI_VERSION = '2.0.0';
// animations.json roles that play once each time their condition turns true (wired through an animation controller)
const ONE_SHOT_KINDS = new Set(['screen', 'open', 'close', 'press']);
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
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
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
// languages / translations (CONTRACT "Idiomas"): active only with more than one language
const LANG_RE = /^[a-z]{2,3}(_[a-z]{2})?$/i;
function langActive(ui) {
  return Array.isArray(ui.languages) && ui.languages.length > 1;
}
function validateLanguages(uiId, ui, geoBones) {
  if (ui.languages !== undefined) {
    if (!Array.isArray(ui.languages) || ui.languages.some((c) => typeof c !== 'string' || !LANG_RE.test(c))) {
      err(uiId, 'languages debe ser una lista de codigos de idioma (ej. ["es","en"])');
      return;
    }
    if (new Set(ui.languages).size !== ui.languages.length) err(uiId, 'languages tiene codigos repetidos');
  }
  if (ui.translations === undefined) return;
  if (!isObj(ui.translations)) { err(uiId, 'translations debe ser un objeto { hueso: codigo }'); return; }
  if (!langActive(ui)) {
    if (Object.keys(ui.translations).length) console.warn(`[bb_ui] aviso: ${uiId}: translations se ignora sin "languages" de 2 o mas idiomas`);
    return;
  }
  for (const [bone, code] of Object.entries(ui.translations)) {
    if (!geoBones.has(bone)) err(uiId, `translations: el hueso "${bone}" no existe en la geometria`);
    if (!ui.languages.includes(code)) err(uiId, `translations.${bone}: "${code}" no esta en languages`);
  }
}

function validate(uiId, ui, geoBones, usedGlobal) {
  if (ui.format_version !== 1) err(uiId, 'format_version debe ser 1');
  if (ui.id !== uiId) err(uiId, `id "${ui.id}" no coincide con la carpeta "${uiId}"`);
  if (!NAME_RE.test(uiId)) err(uiId, 'el id de la carpeta debe cumplir [a-z0-9_]+');
  if (typeof ui.namespace !== 'string' || !NAME_RE.test(ui.namespace)) {
    err(uiId, 'namespace invalido ([a-z0-9_]+)');
    return null;
  }
  const NS = ui.namespace;
  validateLanguages(uiId, ui, geoBones);
  const d = ui.display;
  if (!isObj(d)) err(uiId, 'falta "display"');
  else {
    for (const k of ['fov', 'distance', 'height']) {
      if (typeof d[k] !== 'number') err(uiId, `display.${k} debe ser numero`);
    }
    if (d.anchor !== 'player' && d.anchor !== 'trigger') err(uiId, 'display.anchor debe ser "player" o "trigger"');
    const hexOk = (c) => typeof c === 'string' && HEX_RE.test(c);
    const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    const sub = (name) => {
      const v = d[name];
      if (v === undefined || v === false || v === true) return null;
      if (!isObj(v)) { err(uiId, `display.${name} debe ser false o un objeto`); return null; }
      return v;
    };
    const bd = sub('backdrop');
    if (bd) {
      if (bd.color !== undefined && !hexOk(bd.color)) err(uiId, 'display.backdrop.color debe ser "#rrggbb"');
      if (bd.opacity !== undefined && !unit(bd.opacity)) err(uiId, 'display.backdrop.opacity debe ser un numero 0..1');
    }
    const fd = sub('fade');
    if (fd) {
      for (const k of ['in', 'hold', 'out']) {
        if (fd[k] !== undefined && !(typeof fd[k] === 'number' && fd[k] >= 0)) err(uiId, `display.fade.${k} debe ser un numero >= 0 (segundos)`);
      }
      if (fd.color !== undefined && !hexOk(fd.color)) err(uiId, 'display.fade.color debe ser "#rrggbb"');
    }
    const cu = sub('cursor');
    if (cu && cu.sensitivity !== undefined && !(typeof cu.sensitivity === 'number' && cu.sensitivity > 0)) {
      err(uiId, 'display.cursor.sensitivity debe ser un numero > 0');
    }
    for (const k of ['hide_hud', 'calibrate']) {
      if (d[k] !== undefined && typeof d[k] !== 'boolean') err(uiId, `display.${k} debe ser booleano`);
    }
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
      case 'settings':
        usedGlobal.settings = true;
        break;
      case 'open_ui':
        if (typeof a.ui !== 'string' || !a.ui) err(uiId, `${where}: open_ui necesita ui (string)`);
        else if (!usedGlobal.uiIds.has(a.ui)) console.warn(`[bb_ui] aviso: ${uiId} ${where}: open_ui a "${a.ui}" que no esta entre las UIs de este build`);
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

  // viewer, screen, focus, yaw (+ calib) (+ bd) (+ cur, cx, cy)
  const baseProps = 4 + (d && d.calibrate === false ? 0 : 1) + (d && d.backdrop === false ? 0 : 1) + (d && d.cursor === false ? 0 : 3);
  const langCount = langActive(ui) ? 1 : 0;
  const propCount = baseProps + numberCount + condCount + langCount;
  if (propCount > MAX_PROPERTIES) {
    err(uiId, `demasiadas propiedades de entidad: ${propCount} (maximo ${MAX_PROPERTIES}: ${baseProps} base + ${numberCount} numeros + ${condCount} visible_if + ${langCount} idioma)`);
  }
  return { NS, maxButtons, propCount };
}

// ---------------------------------------------------------------- animations.json (CONTRACT 3.1)
// Document name -> role name N: "animation.<model>.<N>" -> N; "animation.screen|focus|press.<x>" -> as is.
function animRoleName(doc) {
  if (!doc.startsWith('animation.')) return doc;
  const rest = doc.slice('animation.'.length);
  if (/^(screen|focus|press)\./.test(rest)) return rest;
  const i = rest.indexOf('.');
  return i >= 0 ? rest.slice(i + 1) : rest;
}
// Duration in seconds: animation_length, else the last keyframe time of any bone channel.
function animLength(a) {
  if (typeof a.animation_length === 'number') return a.animation_length;
  let max = 0;
  for (const b of Object.values(a.bones || {})) {
    for (const ch of ['position', 'rotation', 'scale']) {
      const v = b && b[ch];
      if (isObj(v)) for (const k of Object.keys(v)) if (Number.isFinite(Number(k))) max = Math.max(max, Number(k));
    }
  }
  return max;
}
// Validates animations.json (null = none) and returns the plan used by generateUi, or null when there are none.
function planAnimations(uiId, ui, geoBones, doc, propCount) {
  if (doc === null || doc === undefined) return null;
  if (!isObj(doc) || !isObj(doc.animations)) { err(uiId, 'animations.json: falta el objeto "animations"'); return null; }
  const screenIds = new Set(ui.screens.filter(isObj).map((x) => x.id));
  const buttonBones = new Set();
  for (const sc of ui.screens) for (const e of (isObj(sc) && sc.elements) || []) if (isObj(e) && e.type === 'button') buttonBones.add(e.bone);
  const plan = { list: [], animatedBones: new Set(), closeTicks: 0, pressTicks: 0, usesClosing: false, usesPress: false };
  const seen = new Map();
  for (const [docName, def] of Object.entries(doc.animations)) {
    const where = `animations.json "${docName}"`;
    if (!isObj(def)) { err(uiId, `${where}: debe ser un objeto`); continue; }
    const N = animRoleName(docName);
    if (!N) { err(uiId, `${where}: nombre vacio tras quitar el prefijo animation.`); continue; }
    const S = N.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (S === 'backdrop' || S === 'yaw' || /^focus_\d+_\d+$/.test(S)) err(uiId, `${where}: el nombre "${S}" esta reservado`);
    if (seen.has(S)) err(uiId, `${where}: da el mismo nombre "${S}" que "${seen.get(S)}"`);
    seen.set(S, docName);
    let kind = 'always';
    let arg = null;
    if (N === 'idle') kind = 'idle';
    else if (N === 'open') kind = 'open';
    else if (N === 'close') kind = 'close';
    else {
      const m = /^(screen|focus|press)\.(.+)$/.exec(N);
      if (m) { kind = m[1]; arg = m[2]; }
    }
    if (kind === 'screen' && !screenIds.has(arg)) err(uiId, `${where}: la pantalla "${arg}" no existe`);
    if (kind === 'focus' || kind === 'press') {
      if (!geoBones.has(arg)) err(uiId, `${where}: el hueso "${arg}" no existe en geo.json`);
      else if (!buttonBones.has(arg)) err(uiId, `${where}: el hueso "${arg}" no es un boton de ninguna pantalla`);
    }
    const len = animLength(def);
    if (kind === 'close') {
      if (!(len > 0)) err(uiId, `${where}: close necesita animation_length > 0`);
      plan.closeTicks = Math.ceil(len * 20 - 1e-6);
      plan.usesClosing = true;
    }
    if (kind === 'press') {
      plan.pressTicks = Math.max(plan.pressTicks, Math.max(1, Math.ceil(len * 20 - 1e-6)));
      plan.usesPress = true;
    }
    const out = { ...def };
    if (isObj(def.bones)) {
      out.bones = {};
      for (const [b, v] of Object.entries(def.bones)) {
        if (!geoBones.has(b)) { console.warn(`[bb_ui] aviso: ${uiId} ${where}: el hueso "${b}" no existe en geo.json (se ignora)`); continue; }
        out.bones[b] = v;
        plan.animatedBones.add(b);
      }
    }
    plan.list.push({ S, kind, arg, def: out });
  }
  const extra = (plan.usesClosing ? 1 : 0) + (plan.usesPress ? 1 : 0);
  if (propCount + extra > MAX_PROPERTIES) {
    err(uiId, `demasiadas propiedades de entidad: ${propCount + extra} (maximo ${MAX_PROPERTIES}; las animaciones close/press anaden ${extra})`);
  }
  return plan;
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
      bones: wrapYaw(bones),
    }],
  };
}
const round = (v) => Math.round(v * 1000) / 1000;

// Root bone of every geometry of the entity: the RP rotates it with NS:yaw (the entity body itself never turns).
const YAW_BONE = '__bbui_yaw';
// Puts YAW_BONE first and parents every former root bone to it (list order, so draw order, unchanged).
function wrapYaw(bones) {
  return [{ name: YAW_BONE, pivot: [0, 0, 0] }, ...bones.map((b) => (b.parent == null ? { ...b, parent: YAW_BONE } : b))];
}

// ---- backdrop + calibration corners
const BACKDROP_BLOCKS = 6; // quad side: covers the screen even at 0.05 blocks from the camera
const BACKDROP_BOUNDS = 40; // visible_bounds of the backdrop geo (the quad is animated up to 16 blocks away from the entity)
const CALIB_THICK = 1.5; // px
const CALIB_ARM = 24; // px
const CALIB_COLOR = [255, 210, 60];
const BACKDROP_DEFAULT = { color: '#000000', opacity: 1 };
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function writeBackdropTexture(outPath, bd) {
  const [r, g, b] = hexRgb(bd.color);
  const a = 255; // always opaque (see bb_ui.backdrop material); `opacity` is accepted but ignored for now
  const img = new Canvas(4, 2);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      img.set(x, y, r, g, b, a);
      img.set(x + 2, y, CALIB_COLOR[0], CALIB_COLOR[1], CALIB_COLOR[2], 255);
    }
  }
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, img.toPng());
}

// bb: world bbox in px { mn, mx } of all cubes; centerYpx: vertical center of the panel (px).
function buildBackdropGeo(ID, bb, centerYpx, withBackdrop, withCalib) {
  const bones = [];
  const quad = (x0, y0, x1, y1, z, u) => ({
    origin: [round(Math.min(x0, x1)), round(Math.min(y0, y1)), round(z)],
    size: [round(Math.abs(x1 - x0)), round(Math.abs(y1 - y0)), 0],
    uv: { north: { uv: [u, 0], uv_size: [2, 2] } },
  });
  if (withBackdrop) {
    const h = (BACKDROP_BLOCKS * 16) / 2;
    // quad at the entity origin plane (z = 0); animation.bb_ui.<ID>.backdrop moves the bone along -Z (toward the viewer)
    bones.push({ name: '__bbui_backdrop', pivot: [0, round(centerYpx), 0],
      cubes: [quad(-h, centerYpx - h, h, centerYpx + h, 0, 0)] });
  }
  if (withCalib) {
    const cubes = [];
    const z = bb.mn[2] - 0.5;
    const t = CALIB_THICK;
    const L = Math.max(8, Math.min(CALIB_ARM, 0.3 * Math.min(bb.mx[0] - bb.mn[0], bb.mx[1] - bb.mn[1])));
    for (const [cx, ox] of [[bb.mn[0], -1], [bb.mx[0], 1]]) {
      for (const [cy, oy] of [[bb.mn[1], -1], [bb.mx[1], 1]]) {
        // L hugging the corner from outside; inward = -outward. Arms do not overlap.
        cubes.push(quad(cx + ox * t, cy, cx - ox * L, cy + oy * t, z, 2)); // horizontal arm (with the corner square)
        cubes.push(quad(cx, cy, cx + ox * t, cy - oy * L, z, 2)); // vertical arm
      }
    }
    bones.push({ name: 'calib', pivot: [0, round(centerYpx), round(z)], cubes });
  }
  return {
    format_version: '1.12.0',
    'minecraft:geometry': [{
      description: {
        identifier: `geometry.bb_ui.${ID}.backdrop`,
        texture_width: 4,
        texture_height: 2,
        visible_bounds_width: BACKDROP_BOUNDS,
        visible_bounds_height: BACKDROP_BOUNDS,
        visible_bounds_offset: [0, 1, 0],
      },
      bones: wrapYaw(bones),
    }],
  };
}

// ---- mouse cursor (keyboard + mouse players): own geometry/texture, drawn after the UI, moved by NS:cx / NS:cy
// Default arrow, tip at the top-left: X = outline, w = fill, s = fill shade, . = transparent.
// A UI can ship its own data/bb_ui/<ID>/cursor.png (tip at the top-left pixel).
const CURSOR_ART = [
  'X..........',
  'XX.........',
  'XwX........',
  'XwwX.......',
  'XwwwX......',
  'XwwwwX.....',
  'XwwwwwX....',
  'XwwwwwwX...',
  'XwwwwwwsX..',
  'XwwwwwsssX.',
  'XwwwwwXXXXX',
  'XwwXwwX....',
  'XwX.XwsX...',
  'XX..XwsX...',
  'X....XwsX..',
  '.....XwsX..',
  '......XX...',
];
const CURSOR_COLORS = { X: [43, 27, 18], w: [250, 243, 226], s: [214, 196, 160] };
const CURSOR_HEIGHT = 0.045; // fraction of the UI height
const CURSOR_FLIP_U = false;
// cursor hit test, as fractions of the UI height (UIs can be a few px or hundreds of px tall)
const HIT_PAD = 0.012; // margin added around every button
const HIT_MIN = 0.05; // smallest hit width/height (small page arrows) // flip if the arrow shows mirrored in game
function pngSize(file) {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
// Writes textures/bb_ui/<ID>_cursor.png; returns its [width, height].
function writeCursorTexture(ID, outPath) {
  mkdirp(path.dirname(outPath));
  const custom = path.join(DATA_DIR, ID, 'cursor.png');
  if (fs.existsSync(custom)) {
    fs.copyFileSync(custom, outPath);
    return pngSize(custom);
  }
  const w = CURSOR_ART[0].length, h = CURSOR_ART.length;
  const img = new Canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = CURSOR_COLORS[CURSOR_ART[y][x]];
      if (c) img.set(x, y, c[0], c[1], c[2], 255);
    }
  }
  fs.writeFileSync(outPath, img.toPng());
  return [w, h];
}
// bb: world bbox in px of the UI. The arrow tip sits at the bone origin; the animation moves it to (cx, cy).
function cursorPlaneZ(fronts, bb) {
  if (!fronts.length) return bb.mn[2] - 0.1;
  const z = [...fronts].sort((a, b) => a - b);
  return z[Math.floor(z.length / 2)] - 0.1; // median button front, a hair in front of it (the UI faces -Z)
}
// z: depth (px) of the plane the cursor is drawn on. It must be the buttons' plane: with perspective, a cursor drawn nearer
// the camera than the buttons looks shifted away from the centre (seen in game with a close camera).
function buildCursorGeo(ID, bb, [tw, th], z) {
  const ch = Math.max(1.5, Math.min(16, CURSOR_HEIGHT * (bb.mx[1] - bb.mn[1])));
  const cw = (ch * tw) / th;
  const uv = CURSOR_FLIP_U ? { uv: [tw, 0], uv_size: [-tw, th] } : { uv: [0, 0], uv_size: [tw, th] };
  return {
    format_version: '1.12.0',
    'minecraft:geometry': [{
      description: {
        identifier: `geometry.bb_ui.${ID}.cursor`,
        texture_width: tw,
        texture_height: th,
        visible_bounds_width: BACKDROP_BOUNDS,
        visible_bounds_height: BACKDROP_BOUNDS,
        visible_bounds_offset: [0, 1, 0],
      },
      bones: wrapYaw([{ name: '__bbui_cursor', pivot: [0, 0, 0],
        cubes: [{ origin: [0, round(-ch), round(z)], size: [round(cw), round(ch), 0], uv: { north: uv } }] }]),
    }],
  };
}

// ---- Bedrock geometry world transforms
// Convention (Blockbench's Bedrock codec uses Euler order 'ZYX'): rotation [rx,ry,rz] in degrees,
// right-handed, around the bone/cube pivot, matrix = Rz * Ry * Rx (X is applied first to a point).
// A bone's world transform = parent's world transform after its own (rotate around its pivot).
// Raw geo x is used as is (no mirroring), like nav.js (MODEL_RIGHT_SIGN = 1). A root rotation of
// [-90,0,0] maps +Y -> -Z, so a book lying flat ends up facing -Z.
// Affine matrices are flat [m00..m22, tx, ty, tz]: p' = M*p + t.
const M_ID = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function rotMatrix(rot) {
  // Bedrock geo is Blockbench space mirrored on X, so a geo rotation [rx, ry, rz] is the right-handed rotation
  // (-rx, ry, -rz) in geo space (verified in game: a book with root [90,0,0] faces -Z).
  const [bx, by, bz] = (rot || [0, 0, 0]).map((d) => (d || 0) * Math.PI / 180);
  const [ax, ay, az] = [-bx, by, -bz];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  return [ // Rz * Ry * Rx
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}
const mApply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9],
  m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11],
];
// a ∘ b (apply b first, then a)
function mMul(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    r[9 + i] = a[i * 3] * b[9] + a[i * 3 + 1] * b[10] + a[i * 3 + 2] * b[11] + a[9 + i];
  }
  return r;
}
// rotate by `rot` around `pivot`
function rotAround(rot, pivot) {
  const R = rotMatrix(rot);
  const pv = pivot || [0, 0, 0];
  const rp = mApply([...R, 0, 0, 0], pv);
  return [...R, pv[0] - rp[0], pv[1] - rp[1], pv[2] - rp[2]];
}
// Fails on duplicate bone names, unknown parents and parent cycles.
function checkBones(bones, where) {
  const byName = new Map();
  const dups = new Set();
  for (const b of bones) { if (byName.has(b.name)) dups.add(b.name); else byName.set(b.name, b); }
  if (dups.size) throw new Error(`${where}: duplicate bone names in geo.json: ${[...dups].map((n) => `"${n}"`).join(', ')}`);
  for (const b of bones) {
    if (b.parent != null && !byName.has(b.parent)) throw new Error(`${where}: bone "${b.name}" has unknown parent "${b.parent}"`);
  }
  for (const b0 of bones) {
    const chain = new Set();
    for (let b = b0; b; b = b.parent != null ? byName.get(b.parent) : null) {
      if (chain.has(b.name)) throw new Error(`${where}: parent cycle at bone "${b.name}"`);
      chain.add(b.name);
    }
  }
}
// World-space queries for a (checked) bone list: pivot(b), cubes(b) -> [{ pts: 8 corners, center }].
function geoWorld(bones) {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const world = new Map();
  const get = (b) => {
    if (world.has(b.name)) return world.get(b.name);
    const local = rotAround(b.rotation, b.pivot);
    const m = b.parent != null ? mMul(get(byName.get(b.parent)), local) : local;
    world.set(b.name, m);
    return m;
  };
  bones.forEach(get);
  const cubeInfo = (b, c) => {
    const o = c.origin;
    const sz = c.size || [0, 0, 0];
    const M = mMul(world.get(b.name), c.rotation ? rotAround(c.rotation, c.pivot) : M_ID);
    const pts = [];
    for (let i = 0; i < 8; i++) {
      pts.push(mApply(M, [o[0] + (i & 1 ? sz[0] : 0), o[1] + (i & 2 ? sz[1] : 0), o[2] + (i & 4 ? sz[2] : 0)]));
    }
    return { pts, center: mApply(M, [o[0] + sz[0] / 2, o[1] + sz[1] / 2, o[2] + sz[2] / 2]) };
  };
  return {
    pivot: (b) => mApply(world.get(b.name), b.pivot || [0, 0, 0]),
    matrix: (b) => world.get(b.name),
    cubes: (b) => (b.cubes || []).map((c) => cubeInfo(b, c)),
  };
}
const bboxOf = (pts) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  return { mn, mx };
};

// Inverse of rotMatrix: Euler [rx,ry,rz] degrees from a 3x3 rotation (flat, Rz*Ry*Rx).
function matrixToEuler(m) {
  const sy = Math.max(-1, Math.min(1, -m[6]));
  let ax;
  let ay;
  let az;
  if (Math.abs(sy) > 1 - 1e-12) { // gimbal lock (ry = +-90): rz is free, take 0
    ay = Math.sign(sy) * Math.PI / 2;
    az = 0;
    ax = Math.atan2(Math.sign(sy) * m[1], m[4]);
  } else {
    ay = Math.asin(sy);
    ax = Math.atan2(m[7], m[8]);
    az = Math.atan2(m[3], m[0]);
  }
  return [-ax, ay, -az].map((r) => r * 180 / Math.PI); // back to Bedrock geo convention (see rotMatrix)
}
const round7 = (v) => { const r = Math.round(v * 1e7) / 1e7; return r === 0 ? 0 : r; };

// Affine inverse of a rigid (rotation + translation) matrix: R' = R^T, t' = -R^T t.
function mInvRigid(m) {
  const r = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const t = [m[9], m[10], m[11]];
  return [...r, -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])];
}
// xray draws without depth test, and Bedrock does NOT draw separate bones in list order, so draw order can only be
// controlled inside one bone (cube order). Rebuild the bone list:
//  - "preserved roots" = the element/highlight bones in refBones (the runtime animates them). Every cube of a root's
//    subtree is baked INTO the root, in the root's local frame (inverse(world(root)) * world(cube), so scaling the root
//    around its pivot still works), and sorted back to front by world z. Emptied descendants are dropped. A descendant
//    whose effective visibility differs from its root's (visOf) cannot be merged: it stays a separate preserved root
//    (and a warning is printed through warn).
//  - every other cube is baked to world space into a merged bone keyed by its visibility expression (visOf, '' = always),
//    without parent/pivot/rotation.
// Cube pivot default: absent pivot = [0,0,0] of geo space (Bedrock; same as geoWorld), not the cube center.
// Returns { bones, mergedVis: Map(mergedBoneName -> expression) } ordered back to front (larger z first).
function flattenForXray(srcBones, gw, refBones, visOf, warn) {
  const byName = new Map(srcBones.map((b) => [b.name, b]));
  const kids = new Map();
  for (const b of srcBones) {
    if (b.parent == null) continue;
    if (!kids.has(b.parent)) kids.set(b.parent, []);
    kids.get(b.parent).push(b.name);
  }
  const roots = new Set(refBones.filter((n) => byName.has(n)));
  // descendants with their own extra visibility condition stay separate roots
  const scan = (n, rootName) => {
    for (const ch of kids.get(n) || []) {
      if (roots.has(ch)) { scan(ch, ch); continue; }
      if (visOf(ch) !== visOf(rootName)) {
        roots.add(ch);
        if (warn) warn(`xray: bone "${ch}" has its own visibility condition inside "${rootName}"; kept as a separate bone (draw order within it may differ)`);
        scan(ch, ch);
      } else scan(ch, rootName);
    }
  };
  [...roots].forEach((r) => scan(r, r));
  // owner root of every bone inside a root's subtree
  const ownerOf = new Map();
  const own = (n, r) => {
    ownerOf.set(n, r);
    for (const ch of kids.get(n) || []) if (!roots.has(ch)) own(ch, r);
  };
  for (const r of roots) own(r, r);
  const needed = new Set(roots);
  for (const n of roots) {
    for (let p = byName.get(n).parent; p != null && !needed.has(p); p = byName.get(p).parent) needed.add(p);
  }
  let gi = 0;
  const used = new Set(byName.keys());
  const newName = () => { let n; do { n = `__bbui_g${gi++}`; } while (used.has(n)); used.add(n); return n; };

  // bake cube c of bone b with matrix M (cube-bone frame -> target frame); returns { cube, } in the target frame
  const bake = (b, c, M, rootBone) => {
    const R = M.slice(0, 9);
    const pc = c.pivot || [0, 0, 0];
    const baked = { ...c };
    if (b.mirror !== undefined && baked.mirror === undefined) baked.mirror = b.mirror;
    if (b.inflate !== undefined && baked.inflate === undefined) baked.inflate = b.inflate;
    if (rootBone && b !== rootBone) { // do not inherit the root bone's own mirror/inflate
      if (baked.mirror === undefined && rootBone.mirror !== undefined) baked.mirror = false;
      if (baked.inflate === undefined && rootBone.inflate !== undefined) baked.inflate = 0;
    }
    const p2 = mApply(M, pc);
    const Rw = mMul([...R, 0, 0, 0], [...(c.rotation ? rotMatrix(c.rotation) : [1, 0, 0, 0, 1, 0, 0, 0, 1]), 0, 0, 0]).slice(0, 9);
    const eul = matrixToEuler(Rw).map(round7);
    baked.origin = [0, 1, 2].map((k) => round7(c.origin[k] - pc[k] + p2[k]));
    if (eul.some((v) => v !== 0)) { baked.rotation = eul; baked.pivot = p2.map(round7); } else { delete baked.rotation; delete baked.pivot; }
    return baked;
  };
  const worldZ = (b, c) => {
    const sz = c.size || [0, 0, 0];
    return mApply(mMul(gw.matrix(b), c.rotation ? rotAround(c.rotation, c.pivot) : M_ID), [0, 1, 2].map((k) => c.origin[k] + sz[k] / 2))[2];
  };

  const groups = new Map(); // key -> [{ cube, z }]
  const rootCubes = new Map(); // root name -> [{ cube, z }]
  for (const b of srcBones) {
    const owner = ownerOf.get(b.name);
    if (owner !== undefined) {
      const rb = byName.get(owner);
      const M = b === rb ? M_ID : mMul(mInvRigid(gw.matrix(rb)), gw.matrix(b));
      if (!rootCubes.has(owner)) rootCubes.set(owner, []);
      for (const c of b.cubes || []) rootCubes.get(owner).push({ cube: bake(b, c, M, rb), z: worldZ(b, c) });
      continue;
    }
    const M = gw.matrix(b);
    for (const c of b.cubes || []) {
      const key = visOf(b.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ cube: bake(b, c, M, null), z: worldZ(b, c) });
    }
  }

  const items = []; // { bone, z, parent }
  for (const b of srcBones) {
    if (!needed.has(b.name)) continue;
    const copy = { ...b };
    let z;
    if (roots.has(b.name)) {
      const list = rootCubes.get(b.name) || [];
      list.sort((p, q) => q.z - p.z); // stable: ties keep source order
      if (list.length) copy.cubes = list.map((e) => e.cube); else delete copy.cubes;
      z = list.length ? list.reduce((acc, e) => acc + e.z, 0) / list.length : gw.pivot(b)[2];
    } else {
      delete copy.cubes;
      z = gw.pivot(b)[2];
    }
    items.push({ bone: copy, z, parent: b.parent });
  }
  const mergedVis = new Map();
  for (const [key, list] of groups) {
    list.sort((p, q) => q.z - p.z); // stable: ties keep source order
    const name = newName();
    mergedVis.set(name, key);
    items.push({ bone: { name, pivot: [0, 0, 0], cubes: list.map((e) => e.cube) }, z: list.reduce((acc, e) => acc + e.z, 0) / list.length, parent: null });
  }
  items.forEach((it, i) => { it.i = i; });
  items.sort((p, q) => q.z - p.z || p.i - q.i);
  const itemOf = new Map(items.map((it) => [it.bone.name, it]));
  const out = [];
  const done = new Set();
  const emit = (it) => {
    if (done.has(it)) return;
    done.add(it);
    if (it.parent != null && itemOf.has(it.parent)) emit(itemOf.get(it.parent));
    out.push(it.bone);
  };
  items.forEach(emit);
  return { bones: out, mergedVis };
}

// Custom entity materials, merged into RP/materials/entity.material.
// bb_ui.xray: drawn over blocks and entities (no depth test), like a screen overlay.
// bb_ui.flat: normal depth test (blocks can hide the UI).
function writeEntityMaterials() {
  const file = path.join(T_RP, 'materials/entity.material');
  const doc = readJsonIfExists(file) || { materials: { version: '1.0.0' } };
  doc.materials = doc.materials || { version: '1.0.0' };
  doc.materials['bb_ui.xray:entity_alphatest'] = {
    '-defines': ['FANCY'],
    '+states': ['DisableDepthTest', 'DisableDepthWrite'],
  };
  doc.materials['bb_ui.flat:entity_alphatest'] = { '-defines': ['FANCY'] };
  // With a backdrop (alphablend, drawn in the blend pass) the UI must be drawn in the same pass, after it:
  // the same states over entity_alphablend (the UI textures only use alpha 0/255, so it looks the same).
  doc.materials['bb_ui.xray_blend:entity_alphablend'] = {
    '-defines': ['FANCY'],
    '+states': ['DisableDepthTest', 'DisableDepthWrite'],
  };
  doc.materials['bb_ui.flat_blend:entity_alphablend'] = { '-defines': ['FANCY'] };
  // backdrop: opaque, WITH depth test and depth write; drawn first (render controller order) so the UI covers it.
  // A material with DisableDepthTest does not write depth either, so clouds/water/particles drawn later showed over
  // the UI. The quad sits just in front of the camera (NS:bd), so the depth test cannot hide it behind nearby walls.
  // Not alphablend: blended parts are drawn in a later pass, over the alphatest UI (seen in game).
  doc.materials['bb_ui.backdrop:entity_alphatest'] = {
    '-defines': ['FANCY'],
  };
  writeJson(file, doc);
}

async function generateUi(uiId, ui, geo, ctx) {
  const { NS, maxButtons } = ctx;
  const plan = ctx.animPlan;
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

  // bone transforms (rotations, parent chain) are honoured, see geoWorld
  checkBones(geoDesc.bones, `ui "${uiId}"`);
  const gw = geoWorld(geoDesc.bones);
  const childrenOf = new Map();
  for (const b of geoDesc.bones) {
    if (b.parent == null) continue;
    if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
    childrenOf.get(b.parent).push(b);
  }
  // world corners of the cubes of a bone and all its descendants
  const subtreePts = (b) => {
    const pts = gw.cubes(b).flatMap((c) => c.pts);
    for (const ch of childrenOf.get(b.name) || []) pts.push(...subtreePts(ch));
    return pts;
  };

  // vertical center (blocks) of all cubes: the panel is centered on the eyes + height
  const allPts = [];
  for (const b of geoDesc.bones) for (const c of gw.cubes(b)) allPts.push(...c.pts);
  const bbPx = allPts.length ? bboxOf(allPts) : { mn: [0, 0, 0], mx: [0, 0, 0] };
  const centerY = allPts.length ? round((bbPx.mn[1] + bbPx.mx[1]) / 2 / 16) : 0;
  const bbox = { min: bbPx.mn.map((v) => round(v / 16)), max: bbPx.mx.map((v) => round(v / 16)) };

  // world-space center (pixels) of the bbox of the bone's cubes and its descendants' (fallback: world pivot)
  const bonePos = {};
  for (const b of geoDesc.bones) {
    const pts = subtreePts(b);
    if (pts.length) {
      const { mn, mx } = bboxOf(pts);
      bonePos[b.name] = [0, 1, 2].map((k) => round((mn[k] + mx[k]) / 2));
    } else {
      bonePos[b.name] = gw.pivot(b).map(round);
    }
  }

  // world-space rect [minX, minY, maxX, maxY] (px) of every button bone: mouse cursor hit test
  const cursorOn = ui.display?.cursor !== false;
  const boneRect = {};
  const buttonFronts = []; // world z (px) of the front face of every button: the cursor plane
  if (cursorOn) {
    const byName = new Map(geoDesc.bones.map((b) => [b.name, b]));
    for (const list of Object.values(buttons)) {
      for (const name of list) {
        const b = byName.get(name);
        const pts = b ? subtreePts(b) : [];
        if (!pts.length || boneRect[name]) continue;
        const { mn, mx } = bboxOf(pts);
        buttonFronts.push(mn[2]);
        // generous hit area: small buttons (page arrows) are easy to miss with a cursor
        const w = mx[0] - mn[0], h = mx[1] - mn[1];
        const uiH = bbPx.mx[1] - bbPx.mn[1];
        const pad = HIT_PAD * uiH, min = HIT_MIN * uiH;
        const px = Math.max(pad, (min - w) / 2), py = Math.max(pad, (min - h) / 2);
        boneRect[name] = [round(mn[0] - px), round(mn[1] - py), round(mx[0] + px), round(mx[1] + py)];
      }
    }
  }

  // ---- BP entity
  const props = {};
  props[`${NS}:viewer`] = { type: 'bool', default: false, client_sync: true };
  props[`${NS}:screen`] = { type: 'int', range: [0, Math.max(ui.screens.length - 1, 1)], default: screenIndex[ui.start_screen], client_sync: true };
  props[`${NS}:focus`] = { type: 'int', range: [0, Math.max(maxButtons, 1)], default: 0, client_sync: true };
  const calibrate = ui.display?.calibrate !== false;
  if (calibrate) props[`${NS}:calib`] = { type: 'bool', default: false, client_sync: true };
  // float property: Bedrock rejects integer-looking JSON numbers (0, 16) as float default/range
  props[`${NS}:yaw`] = { type: 'float', range: [-360.5, 360.5], default: 0.0001, client_sync: true };
  if (ui.display?.backdrop !== false) props[`${NS}:bd`] = { type: 'float', range: [0.0001, 16.5], default: 0.0001, client_sync: true };
  if (cursorOn) {
    props[`${NS}:cur`] = { type: 'bool', default: false, client_sync: true };
    props[`${NS}:cx`] = { type: 'float', range: [-4096.5, 4096.5], default: 0.0001, client_sync: true };
    props[`${NS}:cy`] = { type: 'float', range: [-4096.5, 4096.5], default: 0.0001, client_sync: true };
  }
  if (plan?.usesClosing) props[`${NS}:closing`] = { type: 'bool', default: false, client_sync: true };
  if (plan?.usesPress) props[`${NS}:press`] = { type: 'int', range: [0, Math.max(maxButtons, 1)], default: 0, client_sync: true };
  for (let k = 0; k < nk; k++) props[`${NS}:n${k}`] = { type: 'int', range: [0, 999999999], default: 0, client_sync: true };
  for (let k = 0; k < vk; k++) props[`${NS}:v${k}`] = { type: 'bool', default: false, client_sync: true };
  if (langActive(ui)) props[`${NS}:lang`] = { type: 'int', range: [0, Math.max(ui.languages.length - 1, 1)], default: 0, client_sync: true };
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
        'minecraft:damage_sensor': { triggers: [{ cause: 'suffocation', deals_damage: 'no' }, { cause: 'all', deals_damage: 'no' }] },
        'minecraft:health': { value: 1000000, max: 1000000 },
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
        format_version: '1.21.90',
        'minecraft:item': {
          description: { identifier: o.item, menu_category: { category: 'items' } },
          components: {
            'minecraft:icon': { textures: { default: key } },
            'minecraft:max_stack_size': 1,
            'bb_ui:open': {},
          },
        },
      });
      itemTex.texture_data[key] = { textures: o.generate.texture };
      itemTexDirty = true;
      langLines.push(`item.${o.item}=${o.generate.name}`);
      langLines.push(`item.${o.item}.name=${o.generate.name}`);
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

  const viewer = P('viewer');
  // Bedrock part_visibility does not cascade to child bones: each bone gets its own condition AND every ancestor's.
  const ownExpr = new Map();
  for (const [bone, conds] of boneConds) {
    const uniq = [...new Set(conds)];
    ownExpr.set(bone, uniq.length === 1 ? uniq[0] : uniq.map((c) => `(${c})`).join(' || '));
  }
  const parentOf = new Map(geoDesc.bones.map((b) => [b.name, b.parent]));
  // language conditions are ANDed (never OR-joined like screen conditions): bone -> expression
  const langExpr = new Map();
  if (langActive(ui) && isObj(ui.translations)) {
    for (const [bone, code] of Object.entries(ui.translations)) langExpr.set(bone, `${P('lang')} == ${ui.languages.indexOf(code)}`);
  }
  // effective condition of a bone ('' = none): its own ANDed with all ancestors'
  const visOf = (name) => {
    const chain = [];
    for (let n = name, guard = 0; n && guard < 64; n = parentOf.get(n), guard++) {
      if (ownExpr.has(n)) chain.push(ownExpr.get(n));
      if (langExpr.has(n)) chain.push(langExpr.get(n));
    }
    return chain.map((c) => `(${c})`).join(' && ');
  };
  let outBones = geoDesc.bones;
  let mergedVis = new Map();

  // ---- RP geometry / textures
  const geoOut = JSON.parse(JSON.stringify(geo));
  geoOut['minecraft:geometry'][0].description.identifier = `geometry.bb_ui.${ID}`;
  const xray = ui.display?.xray !== false;
  if (xray) {
    // Without depth test the draw order decides what is on top: draw back to front, cube by cube.
    // The UI faces -Z toward the viewer, so a larger z is further back. bonePos/centerY above were
    // computed from the original geometry. Bones used by elements/highlights keep their structure.
    const refs = [];
    for (const sc of ui.screens) for (const e of sc.elements || []) { refs.push(e.bone); if (e.highlight) refs.push(e.highlight); }
    if (plan) refs.push(...plan.animatedBones); // animated bones keep their name/pivot (preserved roots)
    const flat = flattenForXray(geoDesc.bones, gw, refs.filter(Boolean), visOf, (m) => console.warn(`[bb_ui] aviso: ${m}`));
    geoOut['minecraft:geometry'][0].bones = flat.bones;
    outBones = flat.bones;
    mergedVis = flat.mergedVis;
  }
  if (outBones.some((b) => b.name === YAW_BONE)) err(uiId, `el nombre de hueso "${YAW_BONE}" esta reservado`);
  geoOut['minecraft:geometry'][0].bones = wrapYaw(geoOut['minecraft:geometry'][0].bones);
  writeEntityMaterials();
  writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}.geo.json`), geoOut);
  mkdirp(path.join(T_RP, 'textures/bb_ui'));
  fs.copyFileSync(path.join(DATA_DIR, ID, 'texture.png'), path.join(T_RP, `textures/bb_ui/${ID}.png`));
  const hasDigits = numberList.length > 0;
  if (hasDigits) {
    writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}_digits.geo.json`), buildDigitsGeo(ID, numberList, boneMap));
  }
  // backdrop (+ calibration corners) in their own geometry/texture
  const bdOpt = ui.display?.backdrop;
  const backdrop = bdOpt === false ? null : { ...BACKDROP_DEFAULT, ...(isObj(bdOpt) ? bdOpt : {}) };
  const hasBackdropGeo = !!backdrop || calibrate;
  if (hasBackdropGeo) {
    writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}_backdrop.geo.json`),
      buildBackdropGeo(ID, bbPx, centerY * 16, !!backdrop, calibrate));
    writeBackdropTexture(path.join(T_RP, `textures/bb_ui/${ID}_backdrop.png`), backdrop || BACKDROP_DEFAULT);
  }

  if (cursorOn) {
    const cursorSize = writeCursorTexture(ID, path.join(T_RP, `textures/bb_ui/${ID}_cursor.png`));
    writeJson(path.join(T_RP, `models/entity/bb_ui/${ID}_cursor.geo.json`), buildCursorGeo(ID, bbPx, cursorSize, cursorPlaneZ(buttonFronts, bbPx)));
  }

  // ---- render controllers
  const partVis = [{ '*': viewer }];
  for (const b of outBones) {
    const e = mergedVis.has(b.name) ? mergedVis.get(b.name) : visOf(b.name);
    if (e) partVis.push({ [b.name]: `${viewer} && ${e}` });
  }
  const NO_TINT = { r: '0.0', g: '0.0', b: '0.0', a: '0.0' };
  const rcMain = {
    geometry: 'Geometry.default',
    materials: [{ '*': 'Material.default' }],
    textures: ['Texture.default'],
    ignore_lighting: true,
    // no red hurt flash / fire tint: the display entity may take suffocation hits inside blocks (damage is ignored)
    is_hurt_color: NO_TINT,
    on_fire_color: NO_TINT,
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
      is_hurt_color: NO_TINT,
      on_fire_color: NO_TINT,
      part_visibility: dv,
    };
  }
  if (hasBackdropGeo) {
    const bv = [{ '*': viewer }];
    if (calibrate) bv.push({ calib: `${viewer} && ${P('calib')}` });
    rcs[`controller.render.bb_ui.${ID}.backdrop`] = {
      geometry: 'Geometry.backdrop',
      materials: [{ '*': 'Material.backdrop' }, { calib: 'Material.calib' }], // corners ignore depth (the near backdrop would hide them)
      textures: ['Texture.backdrop'],
      ignore_lighting: true,
      is_hurt_color: NO_TINT,
      on_fire_color: NO_TINT,
      part_visibility: bv,
    };
  }
  if (cursorOn) {
    rcs[`controller.render.bb_ui.${ID}.cursor`] = {
      geometry: 'Geometry.cursor',
      materials: [{ '*': 'Material.cursor' }],
      textures: ['Texture.cursor'],
      ignore_lighting: true,
      is_hurt_color: NO_TINT,
      on_fire_color: NO_TINT,
      part_visibility: [{ '*': `${viewer} && ${P('cur')}` }],
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
  const customFocus = new Set((plan?.list || []).filter((a) => a.kind === 'focus').map((a) => a.arg));
  for (const f of focusAnims) {
    if (customFocus.has(f.bone)) continue; // replaced by focus.<bone> from animations.json
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
  // body yaw is fixed at 0; the runtime sets NS:yaw per viewer (yaw toward the camera) and this turns the root bone.
  // Bedrock bone rotation Y = +yaw (same sign as vanilla look_at, see CONTRACT 3). Runs always (the geometry is hidden anyway without viewer).
  {
    const full = `animation.bb_ui.${ID}.yaw`;
    anims[full] = { loop: true, animation_length: 1, bones: { [YAW_BONE]: { rotation: [0, `${P('yaw')}`, 0] } } };
    animRefs.yaw = full;
    animate.push('yaw');
  }
  if (backdrop) {
    // Bedrock bone position animation is in pixels (16 per block); Z uses the geo axis (only X is mirrored), and the UI
    // faces the viewer along local -Z, so -Z = toward the camera. NS:bd = blocks from the entity origin to the camera - 0.08.
    const name = 'backdrop';
    const full = `animation.bb_ui.${ID}.${name}`;
    anims[full] = {
      loop: true,
      animation_length: 1,
      bones: { __bbui_backdrop: { position: [0, 0, `-${P('bd')} * 16`] } },
    };
    animRefs[name] = full;
    animate.push({ [name]: viewer });
  }
  if (cursorOn) {
    // bone position X here matches geo X (checked in game: -cx showed the cursor mirrored)
    const full = `animation.bb_ui.${ID}.cursor`;
    anims[full] = { loop: true, animation_length: 1, bones: { __bbui_cursor: { position: [P('cx'), P('cy'), 0] } } };
    animRefs.cursor = full;
    animate.push({ cursor: `${viewer} && ${P('cur')}` });
  }
  // authored animations (animations.json): wiring by role, see CONTRACT 3.1
  const controllers = {};
  for (const a of plan?.list || []) {
    const full = `animation.bb_ui.${ID}.${a.S}`;
    anims[full] = a.def;
    animRefs[a.S] = full;
    let expr;
    if (a.kind === 'close') expr = `${viewer} && ${P('closing')}`;
    else if (a.kind === 'screen') expr = `${viewer} && ${P('screen')} == ${screenIndex[a.arg]}`;
    else if (a.kind === 'focus' || a.kind === 'press') {
      const parts = [];
      for (const f of focusAnims) {
        if (f.bone !== a.arg) continue;
        parts.push(a.kind === 'focus'
          ? `(${P('screen')} == ${f.s} && ${P('focus')} == ${f.i})`
          : `(${P('screen')} == ${f.s} && ${P('press')} == ${f.i + 1})`);
      }
      expr = parts.join(' || ');
    } else expr = viewer; // idle, open and any other name
    const loops = a.def && (a.def.loop === true || a.def.loop === 'true');
    if (!loops && ONE_SHOT_KINDS.has(a.kind)) {
      // One-shot roles go through an animation controller: a plain conditional entry in scripts.animate does not
      // restart when its condition turns true again (seen in game: an entry transition stayed on its first frame).
      // The controller enters "play" every time the condition becomes true and plays the animation from the start.
      if (a.def && a.def.loop === undefined) a.def.loop = 'hold_on_last_frame';
      const ctrl = `controller.animation.bb_ui.${ID}.${a.S}`;
      controllers[ctrl] = {
        initial_state: 'default',
        states: {
          default: { transitions: [{ play: `(${expr}) ? 1.0 : 0.0` }] },
          play: { animations: [a.S], transitions: [{ default: `(${expr}) ? 0.0 : 1.0` }] },
        },
      };
      animRefs[`${a.S}_ctrl`] = ctrl;
      animate.push(`${a.S}_ctrl`);
      continue;
    }
    animate.push({ [a.S]: expr });
  }
  if (animate.length) {
    writeJson(path.join(T_RP, `animations/bb_ui/${ID}.animation.json`), { format_version: '1.8.0', animations: anims });
  }
  if (Object.keys(controllers).length) {
    writeJson(path.join(T_RP, `animation_controllers/bb_ui/${ID}.ac.json`), { format_version: '1.10.0', animation_controllers: controllers });
  }

  // ---- client entity
  const desc = {
    identifier: entityId,
    // UI stays alphatest: alphablend parts get re-sorted by distance every frame and buttons vanish behind the pages (seen in game)
    materials: { default: xray ? 'bb_ui.xray' : 'bb_ui.flat' },
    textures: { default: `textures/bb_ui/${ID}` },
    geometry: { default: `geometry.bb_ui.${ID}` },
    render_controllers: [`controller.render.bb_ui.${ID}`],
  };
  if (hasBackdropGeo) {
    // first in the list: drawn before the UI
    desc.materials.backdrop = 'bb_ui.backdrop';
    desc.materials.calib = 'bb_ui.xray';
    desc.textures.backdrop = `textures/bb_ui/${ID}_backdrop`;
    desc.geometry.backdrop = `geometry.bb_ui.${ID}.backdrop`;
    desc.render_controllers.unshift(`controller.render.bb_ui.${ID}.backdrop`);
  }
  if (hasDigits) {
    desc.textures.digits = 'textures/bb_ui/digits';
    desc.geometry.digits = `geometry.bb_ui.${ID}.digits`;
    desc.render_controllers.push(`controller.render.bb_ui.${ID}.digits`);
  }
  if (cursorOn) {
    desc.materials.cursor = 'bb_ui.xray';
    desc.textures.cursor = `textures/bb_ui/${ID}_cursor`;
    desc.geometry.cursor = `geometry.bb_ui.${ID}.cursor`;
    desc.render_controllers.push(`controller.render.bb_ui.${ID}.cursor`);
  }
  if (animate.length) {
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
    centerY,
    bbox,
    cursor: cursorOn ? {
      sensitivity: (isObj(ui.display?.cursor) && ui.display.cursor.sensitivity) || 1,
      bounds: [round(bbPx.mn[0]), round(bbPx.mn[1]), round(bbPx.mx[0]), round(bbPx.mx[1])],
      rects: boneRect,
    } : null,
    closeTicks: plan?.closeTicks || 0,
    pressTicks: plan?.pressTicks || 0,
    pressBones: plan && plan.usesPress ? plan.list.filter((a) => a.kind === 'press').map((a) => a.arg) : [],
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
function autoImport(needsServerUi) {
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
  // the settings form ({ type: "settings" }) is a @minecraft/server-ui ModalForm
  if (needsServerUi && !manifest.dependencies.some((d) => d && d.module_name === '@minecraft/server-ui')) {
    manifest.dependencies.push({ module_name: '@minecraft/server-ui', version: SERVER_UI_VERSION });
    manifestDirty = true;
    console.log(`  manifest: added @minecraft/server-ui ${SERVER_UI_VERSION} (settings form)`);
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
  const usedGlobal = { commands: new Set(), generated: new Set(), uiIds: new Set(dirs) };
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
    if (ctx) {
      const animPath = path.join(dir, 'animations.json');
      let animDoc = null;
      if (fs.existsSync(animPath)) {
        try { animDoc = JSON.parse(fs.readFileSync(animPath, 'utf8')); } catch (e) { err(id, `animations.json no es JSON valido: ${e.message}`); }
      }
      ctx.animPlan = planAnimations(id, ui, geoBones, animDoc, ctx.propCount);
    }
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

  if (SETTINGS.autoImport) autoImport(!!usedGlobal.settings);
  else console.log(`  autoImport off: import "scripts/${SETTINGS.scriptsPath}/index.js" from your own script`);
  console.log(`=== Done: ${loaded.length} UI(s) ===`);
}

main().catch((e) => {
  console.error('[bb_ui] Filter failed:', e);
  process.exit(1);
});
