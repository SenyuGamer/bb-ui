/* BB UI Builder - Blockbench plugin: design a Minecraft Bedrock 3D UI (see docs/bb_ui/CONTRACT.md). */
(function () {
    'use strict';

    const PLUGIN_ID = 'bb_ui_builder';
    const FORMAT_ID = 'bb_ui';
    const VERSION = '0.1.0';
    const STORE_KEY = 'bb_ui_builder_export_root';

    // =====================================================================================
    // Pure core (no Blockbench globals): defaults, lookups, navigation, validation
    // =====================================================================================
    const core = {};
    core.set = (o, k, v) => { o[k] = v; };
    core.del = (o, k) => { delete o[k]; };

    const ID_RE = /^[a-z0-9_]+$/;
    const NS_ID_RE = /^[a-z0-9_]+:[a-z0-9_]+$/;
    const OPS = ['==', '!=', '>', '>=', '<', '<='];
    const ACTION_TYPES = ['goto', 'back', 'close', 'settings', 'command', 'script', 'set', 'add', 'open_ui', 'sequence'];
    const TIP_SIDES = ['derecha', 'izquierda', 'arriba', 'abajo'];
    const ROLES = ['none', 'decor', 'button', 'image', 'model', 'number'];
    const DIRS = ['up', 'down', 'left', 'right'];

    core.sanitizeId = function (s) {
        const r = String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
        return r || 'new_ui';
    };

    core.defaultData = function (name) {
        return {
            format_version: 1,
            id: core.sanitizeId(name),
            namespace: 'bbui',
            display: { fov: 70, distance: 2.5, height: 0, anchor: 'player' },
            open: [],
            start_screen: 'main',
            screens: [{ id: 'main', bones: [], elements: [] }],
            queries: {},
        };
    };

    core.getScreen = (data, id) => (data.screens || []).find((s) => s.id === id) || null;
    core.buttons = (screen) => (screen.elements || []).filter((e) => e.type === 'button');

    // Where a bone is used: {screen, element|null, decor}
    core.findBone = function (data, bone) {
        for (const s of data.screens || []) {
            if ((s.bones || []).includes(bone)) return { screen: s, element: null, decor: true };
            const el = (s.elements || []).find((e) => e.bone === bone);
            if (el) return { screen: s, element: el, decor: false };
        }
        return null;
    };

    core.removeBone = function (data, bone) {
        for (const s of data.screens || []) {
            const i = (s.bones || []).indexOf(bone);
            if (i >= 0) s.bones.splice(i, 1);
            const j = (s.elements || []).findIndex((e) => e.bone === bone);
            if (j >= 0) s.elements.splice(j, 1);
            if (s.default_focus === bone) core.del(s, 'default_focus');
            for (const e of s.elements || []) {
                if (e.highlight === bone) core.del(e, 'highlight');
                if (e.nav) for (const d of DIRS) if (e.nav[d] === bone) core.del(e.nav, d);
            }
        }
    };

    core.assignBone = function (data, screenId, bone, role, queries) {
        const s = core.getScreen(data, screenId);
        if (!s) return null;
        core.removeBone(data, bone);
        if (role === 'none') return null;
        if (!s.bones) core.set(s, 'bones', []);
        if (!s.elements) core.set(s, 'elements', []);
        if (role === 'decor') { s.bones.push(bone); return null; }
        const el = { bone, type: role };
        if (role === 'button') el.action = { type: 'close' };
        if (role === 'number') { el.query = (queries && queries[0]) || ''; el.digits = 4; el.align = 'right'; }
        s.elements.push(el);
        if (role === 'button' && !s.default_focus) core.set(s, 'default_focus', bone);
        return el;
    };

    // Rename a bone everywhere it is referenced. Returns the number of references changed.
    core.renameBone = function (data, from, to) {
        if (!data || !from || !to || from === to) return 0;
        let n = 0;
        const sw = (v) => { if (v === from) { n++; return to; } return v; };
        for (const s of data.screens || []) {
            if (Array.isArray(s.bones)) s.bones.forEach((b, i) => { s.bones[i] = sw(b); });
            if (s.default_focus === from) s.default_focus = sw(s.default_focus);
            for (const e of s.elements || []) {
                if (e.bone === from) e.bone = sw(e.bone);
                if (e.highlight === from) e.highlight = sw(e.highlight);
                if (e.nav) for (const d of DIRS) if (e.nav[d] === from) e.nav[d] = sw(e.nav[d]);
                for (const a of core.actionsOf(e.action)) if (a.bone === from) a.bone = sw(a.bone);
            }
        }
        // editor-only records keyed by bone name follow the rename (tooltips, hand-marked piece types)
        for (const key of ['tooltips', 'types', 'texts']) {
            const rec = data.editor && data.editor[key];
            if (rec && Object.prototype.hasOwnProperty.call(rec, from) && !Object.prototype.hasOwnProperty.call(rec, to)) {
                core.set(rec, to, rec[from]);
                core.del(rec, from);
                n++;
            }
        }
        const tr = data.translations; // a language-specific bone keeps its language when renamed
        if (tr && Object.prototype.hasOwnProperty.call(tr, from) && !Object.prototype.hasOwnProperty.call(tr, to)) {
            core.set(tr, to, tr[from]);
            core.del(tr, from);
            n++;
        }
        return n;
    };

    core.renameScreen = function (data, oldId, newId) {
        const s = core.getScreen(data, oldId);
        if (!s) return;
        s.id = newId;
        if (data.start_screen === oldId) data.start_screen = newId;
        const fix = (a) => {
            if (!a) return;
            if (a.type === 'goto' && a.screen === oldId) a.screen = newId;
            if (a.type === 'sequence') (a.actions || []).forEach(fix);
        };
        for (const sc of data.screens) for (const e of sc.elements || []) fix(e.action);
    };

    core.actionsOf = function (a, out) {
        out = out || [];
        if (!a) return out;
        out.push(a);
        if (a.type === 'sequence') (a.actions || []).forEach((x) => core.actionsOf(x, out));
        return out;
    };

    // Same rule as bb_ui/runtime/nav.js (nextFocus): cone of ~63 degrees, score = along + 2 * perp.
    // pos = { bone: [x,y,z] } in GEO space (the exported x = Blockbench x negated), so MODEL_RIGHT_SIGN = 1.
    const MODEL_RIGHT_SIGN = 1;
    const NAV_DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
    core.nearest = function (pos, buttons, from, dir) {
        const p0 = pos[from];
        if (!p0 || !NAV_DIRS[dir]) return null;
        const dx = NAV_DIRS[dir][0], dy = NAV_DIRS[dir][1];
        let best = null, bestScore = Infinity;
        for (const b of buttons) {
            const p = pos[b];
            if (b === from || !p) continue;
            const rx = (p[0] - p0[0]) * MODEL_RIGHT_SIGN;
            const ry = p[1] - p0[1];
            const along = rx * dx + ry * dy;
            const perp = Math.abs(rx * dy - ry * dx);
            if (along <= 1e-6 || perp > along * 2) continue; // outside the cone
            const score = along + perp * 2;
            if (score < bestScore) { bestScore = score; best = b; }
        }
        return best;
    };

    // Blockbench animation name -> role (same mapping as bb_ui/main.js): "animation.screen.x" -> "screen.x",
    // "animation.<model>.idle" -> "idle"; a name without the "animation." prefix is the role itself.
    core.animRole = function (name) {
        name = String(name || '');
        if (!name.startsWith('animation.')) return name;
        const rest = name.slice('animation.'.length);
        if (/^(screen|focus|press)\./.test(rest)) return rest;
        const i = rest.indexOf('.');
        return i >= 0 ? rest.slice(i + 1) : rest;
    };
    // Every role a UI can use: idle, open, close, screen.<id>, focus.<button>, press.<button>
    core.animRoles = function (data) {
        const out = ['idle', 'open', 'close'];
        const btns = [];
        for (const s of data.screens || []) {
            out.push('screen.' + s.id);
            for (const e of core.buttons(s)) if (!btns.includes(e.bone)) btns.push(e.bone);
        }
        for (const b of btns) out.push('focus.' + b);
        for (const b of btns) out.push('press.' + b);
        return out;
    };
    // Default Blockbench animation for a role: name, loop mode and length (CONTRACT 3.1)
    core.animSpec = function (uiId, role) {
        const loops = role === 'idle' || /^(screen|focus)\./.test(role);
        const named = role === 'idle' || role === 'open' || role === 'close';
        const length = role === 'open' ? 0.5 : role === 'close' ? 0.5 : /^press\./.test(role) ? 0.25 : /^focus\./.test(role) ? 0.5 : 2;
        return { name: named ? 'animation.' + uiId + '.' + role : 'animation.' + role, loop: loops ? 'loop' : 'once', length };
    };

    // Explicit nav (a bone name) wins; key absent = nearest neighbour; null = stay.
    core.resolveNav = function (screen, from, dir, pos) {
        const el = (screen.elements || []).find((e) => e.bone === from && e.type === 'button');
        const names = core.buttons(screen).map((e) => e.bone);
        if (el && el.nav && Object.prototype.hasOwnProperty.call(el.nav, dir)) {
            const t = el.nav[dir];
            return t && names.includes(t) ? t : null;
        }
        return core.nearest(pos, names, from, dir);
    };

    core.countProps = function (data) {
        let n = 3; // viewer, screen, focus
        for (const s of data.screens || []) for (const e of s.elements || []) {
            if (e.type === 'number') n++;
            if (e.visible_if) n++;
        }
        if (core.isMulti(data)) n++; // <ns>:lang, added by the filter when the UI has 2+ languages
        return n;
    };

    // ---- languages (CONTRACT "Idiomas"): data.languages = ['es','en',...] (first = default, active with 2+), data.translations = { bone: code }
    core.LANGS = [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'], ['ru', 'Русский']];
    core.langName = function (code) { const l = core.LANGS.find((x) => x[0] === code); return l ? l[1] : String(code); };
    core.isMulti = function (data) { return !!data && Array.isArray(data.languages) && data.languages.length > 1; };
    core.defLang = function (data) { return (data && Array.isArray(data.languages) && data.languages[0]) || 'es'; };
    // Text of a language from a { code: string } map: its own, else the default language's, else the first one that has text.
    core.textFor = function (map, code, data) {
        map = map || {};
        const v = (c) => (typeof map[c] === 'string' && map[c].trim() ? map[c] : '');
        return v(code) || v(core.defLang(data)) || Object.keys(map).map(v).find(Boolean) || '';
    };
    // Characters of text that the font cannot draw (layoutText drops them; it also tries the other letter case). Whitespace is ignored.
    core.missingChars = function (font, text) {
        const out = [], gl = (font && font.glyphs) || {};
        for (const ch of Array.from(String(text || ''))) {
            if (/\s/.test(ch)) continue;
            if (!(gl[ch] || gl[ch.toLowerCase()] || gl[ch.toUpperCase()]) && !out.includes(ch)) out.push(ch);
        }
        return out;
    };
    // Makes the exported ui.json valid for the filter (it errors on missing bones): unique languages, and translations only with
    // 2+ languages, an existing bone and a listed code. Mutates and returns ui.
    core.cleanLanguages = function (ui, boneNames) {
        const langs = Array.isArray(ui.languages) ? ui.languages.filter((c, i, a) => typeof c === 'string' && c && a.indexOf(c) === i) : [];
        if (langs.length < 2) { delete ui.languages; delete ui.translations; return ui; }
        ui.languages = langs;
        const names = new Set(boneNames || []), out = {};
        for (const k of Object.keys(ui.translations || {})) if (names.has(k) && langs.includes(ui.translations[k])) out[k] = ui.translations[k];
        if (Object.keys(out).length) ui.translations = out; else delete ui.translations;
        return ui;
    };

    core.validate = function (data, boneNames) {
        const errors = [], warnings = [];
        const bones = new Set(boneNames || []);
        const E = (m) => errors.push(m), W = (m) => warnings.push(m);
        if (!data) return { errors: ['No hay datos de UI.'], warnings };
        if (!ID_RE.test(data.id || '')) E('id invalido "' + data.id + '" (usa [a-z0-9_]+).');
        if (!ID_RE.test(data.namespace || '')) E('namespace invalido "' + data.namespace + '".');
        const screens = data.screens || [];
        if (!screens.length) E('No hay pantallas.');
        const ids = new Set();
        const used = new Map();
        // A bone may appear in several screens (shared tabs, arrows, close button: the filter shows it on each of them);
        // only a repeat inside the SAME screen is an error.
        let curScreen = '';
        const claim = (bone, where) => {
            if (!bones.has(bone)) E(where + ': el hueso "' + bone + '" no existe en el modelo.');
            const key = curScreen + '|' + bone;
            if (used.has(key)) E(where + ': el hueso "' + bone + '" ya se usa en ' + used.get(key) + '.');
            else used.set(key, where);
        };
        const queryNames = Object.keys(data.queries || {});
        for (const s of screens) {
            curScreen = s.id;
            if (!ID_RE.test(s.id || '')) E('Pantalla con id invalido "' + s.id + '".');
            if (ids.has(s.id)) E('Pantalla repetida "' + s.id + '".');
            ids.add(s.id);
            if (!(s.bones || []).length && !(s.elements || []).length) E('La pantalla "' + s.id + '" esta vacia.');
            for (const b of s.bones || []) claim(b, 'Pantalla ' + s.id);
            const btns = core.buttons(s).map((e) => e.bone);
            if (s.default_focus && !btns.includes(s.default_focus)) E('Pantalla ' + s.id + ': default_focus "' + s.default_focus + '" no es un boton de la pantalla.');
            if (btns.length && !s.default_focus) W('Pantalla ' + s.id + ': sin default_focus (se usara el primer boton).');
            const aq = (s.actionbar || '').match(/\{(\w+)\}/g) || [];
            for (const m of aq) { const q = m.slice(1, -1); if (q !== 'player' && !queryNames.includes(q)) E('Pantalla ' + s.id + ': actionbar usa {' + q + '} sin query.'); }
            for (const e of s.elements || []) {
                const w = 'Pantalla ' + s.id + ' / ' + e.bone;
                claim(e.bone, w);
                if (!['button', 'image', 'model', 'number'].includes(e.type)) E(w + ': tipo "' + e.type + '" desconocido.');
                if (e.highlight) { if (e.type !== 'button') E(w + ': highlight solo en botones.'); claim(e.highlight, w + ' (highlight)'); }
                if (e.nav) for (const d of DIRS) { const t = e.nav[d]; if (t && !btns.includes(t)) E(w + ': nav.' + d + ' "' + t + '" no es un boton de la pantalla.'); }
                if (e.visible_if) {
                    if (!queryNames.includes(e.visible_if.query)) E(w + ': visible_if usa query "' + e.visible_if.query + '" inexistente.');
                    if (!OPS.includes(e.visible_if.op)) E(w + ': visible_if op invalido.');
                    if (typeof e.visible_if.value !== 'number') E(w + ': visible_if value debe ser numero.');
                }
                if (e.type === 'number') {
                    if (!queryNames.includes(e.query)) E(w + ': number con query "' + e.query + '" inexistente.');
                    if (!Number.isInteger(e.digits) || e.digits < 1 || e.digits > 9) E(w + ': digits debe ser un entero 1-9.');
                }
                if (e.type === 'button') {
                    if (!e.action) E(w + ': boton sin accion.');
                    for (const a of core.actionsOf(e.action)) {
                        if (!ACTION_TYPES.includes(a.type)) E(w + ': accion "' + a.type + '" desconocida.');
                        if (a.type === 'goto' && !screens.some((x) => x.id === a.screen)) E(w + ': goto a pantalla inexistente "' + a.screen + '".');
                        if (a.type === 'command' && !String(a.command || '').trim()) E(w + ': command vacio.');
                        if (a.type === 'command' && /^\s*\//.test(a.command || '')) W(w + ': el comando no debe llevar "/".');
                        if (a.type === 'script' && !String(a.fn || '').trim()) E(w + ': script sin fn.');
                        if ((a.type === 'set' || a.type === 'add') && !String(a.key || '').trim()) E(w + ': ' + a.type + ' sin key.');
                        if (a.type === 'add' && typeof a.amount !== 'number') E(w + ': add sin amount numerico.');
                        if (a.type === 'open_ui') {
                            if (!String(a.ui || '').trim()) E(w + ': open_ui sin ui.');
                            else if (!ID_RE.test(a.ui)) E(w + ': open_ui con id invalido "' + a.ui + '" (usa [a-z0-9_]+).');
                            else if (a.ui === data.id) W(w + ': open_ui apunta a esta misma UI.');
                        }
                        if (a.type === 'sequence' && !(a.actions || []).length) W(w + ': sequence vacia.');
                    }
                }
            }
        }
        if (screens.length && !ids.has(data.start_screen)) E('start_screen "' + data.start_screen + '" no existe.');
        const d = data.display || {};
        if (!(d.fov > 0 && d.fov < 180)) E('display.fov fuera de rango.');
        if (!(d.distance > 0)) E('display.distance debe ser > 0.');
        if (!['player', 'trigger'].includes(d.anchor)) E('display.anchor debe ser player o trigger.');
        const open = data.open || [];
        if (!open.length) W('Sin metodos de apertura (open).');
        const cmdNames = new Set();
        for (const o of open) {
            const w = 'open ' + o.type;
            if (o.type === 'item' && !NS_ID_RE.test(o.item || '')) E(w + ': item "' + o.item + '" no es namespace:id.');
            else if (o.type === 'block' && !NS_ID_RE.test(o.block || '')) E(w + ': block "' + o.block + '" no es namespace:id.');
            else if (o.type === 'entity' && !NS_ID_RE.test(o.entity || '')) E(w + ': entity "' + o.entity + '" no es namespace:id.');
            else if (o.type === 'command') {
                if (!NS_ID_RE.test(o.name || '')) E(w + ': nombre "' + o.name + '" no es namespace:nombre.');
                if (cmdNames.has(o.name)) E(w + ': comando repetido "' + o.name + '".');
                cmdNames.add(o.name);
                if (!['any', 'gamedirectors', 'admin'].includes(o.permission)) E(w + ': permission invalido.');
            } else if (!['item', 'block', 'entity', 'command'].includes(o.type)) E('open: tipo "' + o.type + '" desconocido.');
            if (o.generate && !String(o.generate.name || '').trim()) E(w + ': generate sin name.');
        }
        for (const [k, q] of Object.entries(data.queries || {})) {
            if (!ID_RE.test(k)) E('Query "' + k + '": nombre invalido.');
            if (q.source === 'dynamic_property' && !q.key) E('Query ' + k + ': falta key.');
            else if (q.source === 'scoreboard' && !q.objective) E('Query ' + k + ': falta objective.');
            else if (q.source === 'script' && !q.fn) E('Query ' + k + ': falta fn.');
            else if (!['dynamic_property', 'scoreboard', 'script'].includes(q.source)) E('Query ' + k + ': source invalido.');
        }
        if (data.languages !== undefined) {
            if (!Array.isArray(data.languages)) E('languages debe ser una lista de codigos.');
            else {
                const seen = new Set();
                for (const c of data.languages) {
                    if (!ID_RE.test(String(c))) E('Idioma con codigo invalido "' + c + '" (usa [a-z0-9_]+).');
                    else if (seen.has(c)) E('Idioma repetido "' + c + '".');
                    seen.add(c);
                }
            }
        }
        const props = core.countProps(data);
        if (props > 32) E('Demasiadas propiedades de entidad: ' + props + ' (max 32).');
        return { errors, warnings };
    };

    // Node smoke tests load the file directly.
    if (typeof BBPlugin === 'undefined') {
        if (typeof module !== 'undefined') module.exports = core;
        return;
    }

    // =====================================================================================
    // Blockbench integration
    // =====================================================================================
    core.set = (o, k, v) => Vue.set(o, k, v);
    core.del = (o, k) => Vue.delete(o, k);

    const state = { data: null, activeScreen: '', showAll: false, showTips: true, safe: true, showSettings: false, showAnims: false, sel: '', grp: '', rev: 0, groups: [], textures: [], animNames: [], profile: 'default', building: false, dev: false, piece: '', lang: '', preview: { on: false, focus: '', stack: [] } };
    const MODE_ID = 'bb_ui_mode';
    const DEV_KEY = 'bb_ui_builder_dev';
    const COMUNES = 'comunes';
    // Camera preset (id in DefaultCameraPresets) used to look at the UI "like the game". Change it here if text reads mirrored/backwards.
    const VIEW_PRESET = 'north';
    // Built-in panels that also show in the UI mode: none. The artist picks pieces from the "Piezas" list of the UI panel, so
    // the outliner (bones/cubes) and the textures panel stay out of the UI mode. (Their condition gets MODE_ID if listed here.)
    const SHARED_PANELS = [];
    let panels = [], actions = [], listeners = [], selListener = null, styleEl = null, formatObj = null, pollTimer = null, keyHandler = null, modeObj = null;
    const patchedPanels = [];
    const menus = [];

    const isUi = () => typeof Format !== 'undefined' && Format && Format.id === FORMAT_ID && typeof Project !== 'undefined' && Project;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const touch = () => { try { Project.saved = false; } catch (e) {} state.rev++; };
    const getData = () => (isUi() ? Project.bbui || null : null);

    function boneNames() { try { return (Group.all || []).map((g) => g.name); } catch (e) { return []; } }
    // Every cube under a group (any depth).
    function subtreeCubes(g, out) {
        out = out || [];
        for (const c of g.children || []) {
            if (c instanceof Group) subtreeCubes(c, out);
            else if (c instanceof Cube) out.push(c);
        }
        return out;
    }
    // Bounds {mn,mx} of a group's cubes. world=true: rendered (world) space, like the exported geo; world=false: raw from/to
    // (the coordinates new children are created in, correct for unrotated groups).
    function subtreeBounds(g, world) {
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        let any = false;
        const cubes = subtreeCubes(g);
        let box = null;
        if (world) { try { box = new THREE.Box3(); } catch (e) { world = false; } }
        for (const c of cubes) {
            if (world) {
                if (!c.mesh) continue;
                try { c.mesh.updateMatrixWorld(true); box.expandByObject(c.mesh); any = true; } catch (e) {}
            } else {
                for (let k = 0; k < 3; k++) {
                    mn[k] = Math.min(mn[k], c.from[k], c.to[k]);
                    mx[k] = Math.max(mx[k], c.from[k], c.to[k]);
                }
                any = true;
            }
        }
        if (world) { if (!any || box.isEmpty()) return null; return { mn: [box.min.x, box.min.y, box.min.z], mx: [box.max.x, box.max.y, box.max.z] }; }
        return any ? { mn, mx } : null;
    }
    // Bone positions the way the filter computes them (bb_ui/main.js bonePos): centre of the bbox of the bone's cubes and its
    // descendants', in GEO space = Blockbench x negated. Fallback: the group origin.
    function bonePositions() {
        const out = {};
        try {
            for (const g of Group.all || []) {
                const b = subtreeBounds(g, true);
                if (b) out[g.name] = [-(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2];
                else { const o = g.origin || [0, 0, 0]; out[g.name] = [-o[0], o[1], o[2]]; }
            }
        } catch (e) {}
        return out;
    }
    // Editor-only data (never exported to ui.json), created lazily.
    function editorData() {
        const d = needProject();
        if (!d.editor) core.set(d, 'editor', {});
        return d.editor;
    }

    function ensureData() {
        if (!isUi()) return null;
        if (!Project.bbui) Project.bbui = core.defaultData(Project.name || Project.geometry_name);
        return Project.bbui;
    }

    // ------------------------------------------------------------------ selection ownership / click-to-select
    let selGuard = 0;
    const inUiMode = () => { try { return typeof Modes !== 'undefined' && !!Modes.selected && Modes.selected.id === MODE_ID; } catch (e) { return false; } };
    function selectGroup(g) { selGuard++; try { g.select(); } catch (e) {} finally { selGuard--; } }
    function currentSelectionNode() {
        try {
            const g = (typeof Group !== 'undefined') ? (Group.first_selected || null) : null;
            if (g) return g;
            const c = (typeof Cube !== 'undefined' && Cube.selected) ? Cube.selected[0] : null;
            return c || null;
        } catch (e) { return null; }
    }
    // Bone of the active window that owns `bone` (element, its highlight, or a decor bone), or ''.
    function ownerBone(screen, name) {
        if (!screen) return '';
        const el = (screen.elements || []).find((e) => e.bone === name || e.highlight === name);
        if (el) return el.bone;
        return (screen.bones || []).includes(name) ? name : '';
    }
    // Walks up from a cube/group. -> { sel, group, hit } : hit = an element/decor of the active window; otherwise the top-level group.
    function resolveOwner(start) {
        const d = state.data || getData();
        if (!d || !start) return { sel: '', group: null, hit: false };
        const s = core.getScreen(d, state.activeScreen);
        let g = start instanceof Group ? start : start.parent, top = null;
        for (; g instanceof Group; g = g.parent) {
            const b = ownerBone(s, g.name);
            if (b) return { sel: b, group: b === g.name ? g : ((Group.all || []).find((x) => x.name === b) || g), hit: true };
            top = g;
        }
        return { sel: top ? top.name : '', group: top, hit: false };
    }
    // Viewport clicks select cubes: promote that to the owning element's group so moving drags the whole element.
    function onSelection() {
        if (selGuard > 0 || !isUi() || !inUiMode()) return;
        try {
            syncState();
            if (Group.first_selected) return; // groups picked in the outliner stay as picked (the Inspector still follows)
            const cubes = Cube.selected || [];
            if (cubes.length !== 1) return;
            { // select the piece = the group directly inside the window folder (or comunes); old-style windows fall through
                const p = artistPiece(cubes[0]);
                if (p) { selectGroup(p); syncState(); return; }
            }
            const r = resolveOwner(cubes[0]);
            if (r.group) { selectGroup(r.group); syncState(); }
        } catch (e) { console.warn('BB UI Builder: selection', e); }
    }

    // ------------------------------------------------------------------ game-like view (ortho + front preset, framed on the visible UI)
    let savedView = null;
    function mainPreview() { try { return Preview.selected || null; } catch (e) { return null; } }
    function saveView(p) {
        if (savedView) return;
        try {
            savedView = { p, ortho: !!(p.camera && p.camera.isOrthographicCamera), pos: p.camera.position.clone(), target: p.controls.target.clone(), zoom: p.camera.zoom };
        } catch (e) { savedView = null; }
    }
    function restoreView() {
        const v = savedView; savedView = null;
        if (!v) return;
        try {
            const p = v.p;
            try { if (p.setNormalCamera) p.setNormalCamera(); } catch (e) {}
            p.setProjectionMode(v.ortho);
            p.camera.position.copy(v.pos);
            p.controls.target.copy(v.target);
            if (v.ortho) { p.camera.zoom = v.zoom; p.camera.updateProjectionMatrix(); }
            p.controls.update();
            p.render();
        } catch (e) { console.warn('BB UI Builder: restore view', e); }
    }
    function fitView(p) {
        const b = cubeBounds();
        if (!b || !p.camera || !p.controls) return;
        const cam = p.camera, ctl = p.controls;
        const c = new THREE.Vector3((b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2);
        const delta = c.clone().sub(ctl.target);
        cam.position.add(delta);
        ctl.target.copy(c);
        ctl.update();
        if (cam.isOrthographicCamera) {
            cam.zoom = 1; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
            let m = 0;
            for (const x of [b.mn[0], b.mx[0]]) for (const y of [b.mn[1], b.mx[1]]) for (const z of [b.mn[2], b.mx[2]]) {
                const v = new THREE.Vector3(x, y, z).project(cam);
                m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
            }
            if (m > 0) { cam.zoom = Math.max(0.01, 0.85 / m); cam.updateProjectionMatrix(); }
        }
        try { p.render(); } catch (e) {}
    }
    // force = true: used from the mode's onSelect, where Modes.selected may not be updated yet.
    function applyGameView(force) {
        if (!force && !inUiMode()) return;
        const p = mainPreview();
        if (!p) return;
        saveView(p);
        try { p.setProjectionMode(true); } catch (e) { console.warn('BB UI Builder: ortho', e); }
        try {
            const pr = (typeof DefaultCameraPresets !== 'undefined' ? DefaultCameraPresets : []).find((x) => x.id === VIEW_PRESET);
            if (pr) p.loadAnglePreset(pr);
        } catch (e) { console.warn('BB UI Builder: angle preset', e); }
        try { fitView(p); } catch (e) { console.warn('BB UI Builder: fit', e); }
        setTimeout(() => { try { const q = mainPreview(); if (q && (force || inUiMode())) fitView(q); } catch (e) {} }, 60);
    }
    function refreshPanels() {
        try { if (typeof updateInterfacePanels === 'function') updateInterfacePanels(); } catch (e) {}
        try { for (const id of ['bb_ui_artist2', 'bb_ui_pieces', 'bb_ui_screens', 'bb_ui_element', 'bb_ui_settings', 'bb_ui_animations']) { const p = Panels[id]; if (p && p.updateSlot) p.updateSlot(); } } catch (e) {}
    }
    function setPanelFlag(key, on) { state[key] = !!on; refreshPanels(); }

    function syncState() {
        if (!isUi()) { state.data = null; return; }
        const d = ensureData();
        if (state.data !== d) {
            state.data = d;
            if (!core.getScreen(d, state.activeScreen)) state.activeScreen = d.start_screen || (d.screens[0] && d.screens[0].id) || '';
            state.preview.on = false;
        }
        const name = resolveOwner(currentSelectionNode()).sel;
        if (state.sel !== name) state.sel = name;
        try { const pc = artistPiece(currentSelectionNode()), pn = pc ? pc.name : ''; if (state.piece !== pn) state.piece = pn; } catch (e) {}
        try { const nd = currentSelectionNode(), gn = nd instanceof Group ? nd.name : (nd && nd.parent instanceof Group ? nd.parent.name : ''); if (state.grp !== gn) state.grp = gn; } catch (e) {}
        const names = boneNames();
        if (names.join('|') !== state.groups.join('|')) state.groups = names;
        try {
            const main = mainTexture();
            const tn = (Texture.all || []).filter((t) => t !== main).map((t) => t.name);
            if (tn.join('|') !== state.textures.join('|')) state.textures = tn;
            const an = (typeof Animation !== 'undefined' && Animation.all ? Animation.all : []).map((a) => a.name);
            if (an.join('|') !== state.animNames.join('|')) state.animNames = an;
        } catch (e) {}
    }

    // ------------------------------------------------------------------ visibility per screen
    function applyVisibility() {
        const d = getData();
        if (!d) return;
        // a bone may belong to several screens (shared buttons like the page arrows)
        const owner = {};
        const add = (b, id) => { (owner[b] = owner[b] || new Set()).add(id); };
        for (const s of d.screens) {
            for (const b of s.bones || []) add(b, s.id);
            for (const e of s.elements || []) { add(e.bone, s.id); if (e.highlight) add(e.highlight, s.id); }
        }
        const tipGroups = new Set();
        for (const s of d.screens) for (const e of s.elements || []) {
            const tg = e.type === 'button' ? findTipGroup(e.bone) : null;
            if (tg) tipGroups.add(tg);
        }
        // highlight bone -> its button, to show it only while that button is selected (like focus in game)
        const hlOwner = {};
        for (const s of d.screens) for (const e of s.elements || []) if (e.highlight) hlOwner[e.highlight] = e.bone;
        const multiLang = core.isMulti(d), langNow = curLang(d), trMap = d.translations || {};
        const artist = !state.dev && !state.showAll;
        const notExported = (g) => { for (let p = g; p instanceof Group; p = p.parent) if (p.export === false) return true; return false; };
        for (const g of Group.all || []) {
            const o = owner[g.name];
            g.visibility = state.showAll || !o || o.has(state.activeScreen);
            if (tipGroups.has(g)) g.visibility = state.showTips !== false; // tooltips: editor toggle (they only show while focused in game)
            if (artist) {
                if (hlOwner[g.name] && g.visibility) g.visibility = state.sel === hlOwner[g.name];
                if (notExported(g)) g.visibility = false; // editor-only pieces (font sheets, parts not exported) stay out of the way
            }
            // a piece of another language is hidden too (it must pass the window rule AND the language rule)
            if (multiLang) { const lc = trMap[g.name]; if (lc && d.languages.includes(lc) && lc !== langNow) g.visibility = false; }
        }
        // Blockbench does not hide a group's cubes with the group: propagate to every cube from its ancestors.
        for (const c of Cube.all || []) {
            let v = true;
            for (let p = c.parent; p && p !== 'root' && p instanceof Group; p = p.parent) if (p.visibility === false) { v = false; break; }
            c.visibility = v;
        }
        try { Canvas.updateVisibility(); } catch (e) {}
        try { Canvas.updateAllBones(); } catch (e) {}
    }
    function showAllTemporarily(fn) {
        const prevG = (Group.all || []).map((g) => [g, g.visibility]);
        const prevC = (Cube.all || []).map((c) => [c, c.visibility]);
        for (const [g] of prevG) g.visibility = true;
        for (const [c] of prevC) c.visibility = true;
        try { return fn(); } finally {
            for (const [g, v] of prevG) g.visibility = v;
            for (const [c, v] of prevC) c.visibility = v;
            try { Canvas.updateVisibility(); } catch (e) {}
        }
    }

    // ------------------------------------------------------------------ preview navigation
    function previewButtons() {
        const s = core.getScreen(state.data, state.activeScreen);
        return s ? core.buttons(s).map((e) => e.bone) : [];
    }
    function previewFocus(bone) {
        state.preview.focus = bone;
        const g = (Group.all || []).find((x) => x.name === bone);
        if (g) selectGroup(g);
    }
    function previewStart() {
        const d = getData();
        if (!d) return;
        syncState();
        const btns = previewButtons();
        if (!btns.length) return Blockbench.showQuickMessage('La pantalla activa no tiene botones.', 2000);
        const s = core.getScreen(d, state.activeScreen);
        state.preview.on = true;
        state.preview.stack = [];
        previewFocus(btns.includes(s.default_focus) ? s.default_focus : btns[0]);
    }
    function previewStop() { state.preview.on = false; }
    function previewMove(dir) {
        if (!state.preview.on) return;
        const s = core.getScreen(state.data, state.activeScreen);
        const to = s && core.resolveNav(s, state.preview.focus, dir, bonePositions());
        if (to) previewFocus(to);
    }
    function previewAccept() {
        const s = core.getScreen(state.data, state.activeScreen);
        const el = s && (s.elements || []).find((e) => e.bone === state.preview.focus);
        if (!el || !el.action) return;
        let msg = '';
        for (const a of el.action.type === 'sequence' ? el.action.actions || [] : [el.action]) {
            if (a.type === 'goto') { state.preview.stack.push(state.activeScreen); gotoScreen(a.screen); }
            else if (a.type === 'back') { const p = state.preview.stack.pop(); if (p) gotoScreen(p); else { previewStop(); msg = 'close'; } }
            else if (a.type === 'close') { previewStop(); msg = 'close'; }
            else if (a.type === 'settings') Blockbench.showQuickMessage('Abre el formulario de ajustes', 1500);
            else msg += (msg ? ', ' : '') + a.type;
        }
        if (msg) Blockbench.showQuickMessage('Accion: ' + msg, 1500);
    }
    function gotoScreen(id) {
        const s = core.getScreen(state.data, id);
        if (!s) return;
        const changed = state.activeScreen !== id;
        state.activeScreen = id;
        applyVisibility();
        if (changed && !state.preview.on) { selGuard++; try { unselectAllElements(); } catch (e) {} finally { selGuard--; } syncState(); }
        if (inUiMode()) applyGameView();
        if (state.preview.on) {
            const btns = previewButtons();
            if (btns.length) previewFocus(btns.includes(s.default_focus) ? s.default_focus : btns[0]);
        }
    }

    // ------------------------------------------------------------------ add elements
    function nextName(prefix) {
        const names = new Set(boneNames());
        let n = 1;
        while (names.has(prefix + '_' + n)) n++;
        return prefix + '_' + n;
    }
    // Flat plane facing -Z (north face). Viewer is on the -Z side; "behind" = larger Z.
    // uv = [u0,v0,u1,v1] in TEXTURE PIXELS (defaults to [0,0,w,h]); parent = Group to nest the new group in.
    // d.editor.mainTexture (set by the templates) names the texture the UI is drawn with; otherwise Blockbench's default.
    function mainTexture() {
        try {
            const d = getData(), nm = d && d.editor && d.editor.mainTexture;
            if (nm) { const t = Texture.all.find((x) => x.name === nm); if (t) return t; }
            return (Texture.getDefault && Texture.getDefault()) || Texture.all[0] || null;
        } catch (e) { return null; }
    }
    function uvScale(tex) { return tex && tex.width && tex.uv_width ? tex.uv_width / tex.width : 1; }
    function flatGroup(name, cx, cy, z, w, h, uv, parent) {
        const group = new Group({ name, origin: [cx, cy, z] }).init();
        if (parent) group.addTo(parent);
        const cube = new Cube({ name: name + '_plane', from: [cx - w / 2, cy - h / 2, z], to: [cx + w / 2, cy + h / 2, z] });
        try { cube.box_uv = false; } catch (e) {}
        cube.init();
        cube.addTo(group);
        try {
            const tex = mainTexture(), k = uvScale(tex);
            const u = uv || [0, 0, w, h];
            cube.faces.north.uv = u.map((n) => n * k);
            if (tex) cube.faces.north.texture = tex.uuid;
            for (const f of ['south', 'east', 'west', 'up', 'down']) { cube.faces[f].uv = [0, 0, 0, 0]; cube.faces[f].texture = null; } // untextured faces are not exported: with xray (no culling) a textured back face drew the atlas corner over the front
        } catch (e) {}
        return { group, cube };
    }
    const SIZES = { button: [24, 8], image: [16, 8], number: [8, 4], model: [8, 8] };
    const TEMPLATE_HL_UV = [64, 0, 66, 2];
    function isTemplateAtlas(d) { return !!(d.fonts && d.fonts.ui_font && d.editor && /^ui_atlas/.test(d.editor.mainTexture || '')); }
    // Texture region used as the highlight colour: the last one picked, or the template atlas frame; null = ask the user.
    function defaultHlRegion(d) {
        const r = d.editor && d.editor.hlRegion;
        if (Array.isArray(r) && r.length === 4) return r.slice();
        return isTemplateAtlas(d) ? TEMPLATE_HL_UV.slice() : null;
    }
    function preferredFont(d) {
        const names = Object.keys(d.fonts || {});
        if (!names.length) return null;
        return d.fonts.ui_font ? 'ui_font' : names[0];
    }
    // Four thin bars around the button's bounds, in a group `<bone>_hl` (sibling of the button). No Undo.
    function buildHighlight(d, bone, region, acc) {
        const f = core.findBone(d, bone), el = f && f.element;
        const btn = (Group.all || []).find((g) => g.name === bone);
        if (!el || !btn) throw new Error('"' + bone + '" no es un boton.');
        const bb = subtreeBounds(btn, false);
        if (!bb) throw new Error('El boton "' + bone + '" no tiene cubos.');
        const hn = uniqueName(bone + '_hl');
        const hl = new Group({ name: hn, origin: btn.origin ? btn.origin.slice() : [0, 0, 0] }).init();
        if (btn.parent instanceof Group) hl.addTo(btn.parent);
        acc.groups.push(hl);
        const M = 1, T = 1, z = bb.mn[2] + 0.2;
        const x0 = bb.mn[0] - M, x1 = bb.mx[0] + M, y0 = bb.mn[1] - M, y1 = bb.mx[1] + M, W = x1 - x0, H = y1 - y0;
        const bars = [['t', (x0 + x1) / 2, y1 - T / 2, W, T], ['b', (x0 + x1) / 2, y0 + T / 2, W, T], ['l', x0 + T / 2, (y0 + y1) / 2, T, H - 2 * T], ['r', x1 - T / 2, (y0 + y1) / 2, T, H - 2 * T]];
        for (const [k, cx, cy, w, h] of bars) {
            const q = flatGroup(hn + '_' + k, cx, cy, z, w, h, region, hl);
            acc.groups.push(q.group); acc.cubes.push(q.cube);
        }
        core.set(el, 'highlight', hn);
        return hn;
    }
    // region = [u0,v0,u1,v1] (texture px). Without one, asks the user to pick it (then builds). Returns the highlight name or null.
    function createHighlight(bone, region) {
        const d = needProject();
        const f = core.findBone(d, bone);
        if (!f || !f.element || f.element.type !== 'button') throw new Error('"' + bone + '" no es un boton.');
        region = region || defaultHlRegion(d);
        if (!region) {
            imageDialog({ title: 'Elige el color del resaltado (una zona de la textura)', onPick: (uv) => { try { createHighlight(bone, uv.map((n) => Math.round(n))); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } } });
            return null;
        }
        const acc = { groups: [], cubes: [] };
        let name = '';
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        try { name = buildHighlight(d, bone, region, acc); }
        finally { Undo.finishEdit('Create UI highlight', { outliner: true, elements: acc.cubes, groups: acc.groups }); }
        core.set(editorData(), 'hlRegion', region.slice());
        try { Canvas.updateAll(); } catch (e) {}
        touch(); applyVisibility(); applyRoleColors(); syncState();
        return name;
    }
    function addElement(kind, o) {
        const d = ensureData();
        if (!d) return Blockbench.showQuickMessage('Abre un proyecto "Minecraft UI".', 2000);
        syncState();
        const screen = core.getScreen(d, state.activeScreen);
        const prefix = { button: 'btn', image: 'img', number: 'num', model: 'mdl' }[kind];
        const name = nextName(prefix);
        const tpl = kind === 'button' && isTemplateAtlas(d);
        const [w, h] = tpl ? [40, 10] : SIZES[kind];
        const artist = !!(o && o.artist) || !state.dev;
        const parent = artist ? ensureFolder(screen) : null;
        const at = placement(screen, parent);
        const acc = { groups: [], cubes: [] };
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        try {
            const main = flatGroup(name, at.x, at.y, at.z, w, h, tpl ? TPL_UV.button : null, parent);
            acc.groups.push(main.group); acc.cubes.push(main.cube);
            const fn = kind === 'button' ? preferredFont(d) : null;
            if (fn) {
                const font = d.fonts[fn], lay = core.layoutText(font, 'BOTON', 'center');
                if (lay.glyphs.length) {
                    const sc = Math.min(1, (w - 2) / lay.width, (h * 0.8) / lay.height);
                    const t = buildTextGroup({ name: name + '_txt', font, text: 'BOTON', scale: sc, align: 'center', cx: at.x, cy: at.y - lay.height / 1.25 * 0.125 * sc, z: at.z - 0.4, parent: main.group });
                    if (t) { acc.groups.push(t.group); acc.cubes.push(...t.cubes); }
                }
            }
        } finally { Undo.finishEdit('Add UI ' + kind, { outliner: true, elements: acc.cubes, groups: acc.groups }); }
        try { Canvas.updateAll(); } catch (e) {}
        core.assignBone(d, screen.id, name, kind, Object.keys(d.queries));
        touch();
        applyVisibility();
        applyRoleColors();
        if (kind === 'button' && state.dev) { // artist mode: the runtime's default focus effect is enough
            try { const r = defaultHlRegion(d); if (r) createHighlight(name, r); } catch (e) { console.warn('BB UI Builder: highlight', e); }
        }
        const g = (Group.all || []).find((x) => x.name === name);
        if (g) selectGroup(g);
        syncState();
        frame();
        return name;
    }

    // ------------------------------------------------------------------ placement helpers
    function selectedGroup() {
        try {
            const g = Group.first_selected || null, d = getData();
            if (!g || !d) return g;
            if (core.findBone(d, g.name)) return null; // elements are never containers
            for (const s of d.screens || []) if ((s.elements || []).some((e) => e.highlight === g.name)) return null;
            return g;
        } catch (e) { return null; }
    }
    // Where a new element goes: inside the selected group (at its origin, a bit in front) or stacked at the root.
    function placement(screen, parent) {
        if (parent && parent.origin && !isFolderGroup(parent)) return { x: parent.origin[0], y: parent.origin[1], z: parent.origin[2] - 0.2 };
        const used = (screen.elements || []).length + (screen.bones || []).length;
        // centre of what is visible now (world space), just in front of it, staggered so new items don't stack
        const b = cubeBounds();
        if (b) {
            const k = used % 6;
            return { x: (b.mn[0] + b.mx[0]) / 2 + (k % 3 - 1) * 3, y: (b.mn[1] + b.mx[1]) / 2 + (1 - Math.floor(k / 3)) * 3, z: b.mn[2] - 0.4 };
        }
        return { x: -Math.floor(used / 3) * 10, y: 14 - 6 * (used % 3), z: -0.4 };
    }
    function finishNewElement(d, screen, name, group, role, plain) {
        if (!plain) core.assignBone(d, screen.id, name, role, Object.keys(d.queries)); // artist pieces live inside the window folder: no role of their own
        touch();
        try { Canvas.updateAll(); } catch (e) {} // new cubes need their meshes/UVs built before they show
        applyVisibility();
        applyRoleColors();
        selectGroup(group);
        syncState();
        frame();
    }
    function needProject() {
        const d = ensureData();
        if (!d) throw new Error('Abre un proyecto "Minecraft UI".');
        syncState();
        return d;
    }

    // ------------------------------------------------------------------ Add Image (texture rectangle picker)
    // opts = { uv: [u0,v0,u1,v1] (texture pixels), height (model units), name? }
    function addImage(opts) {
        const d = needProject();
        const screen = core.getScreen(d, state.activeScreen);
        const uv = (opts.uv || []).map((n) => Math.round(n));
        const uw = uv[2] - uv[0], vh = uv[3] - uv[1];
        if (!(uw > 0 && vh > 0)) throw new Error('Rectangulo de UV vacio.');
        const h = opts.height > 0 ? opts.height : vh;
        const w = h * uw / vh;
        const artist = !!opts.artist || !state.dev;
        const parent = artist ? ensureFolder(screen) : selectedGroup();
        const name = opts.name && !boneNames().includes(opts.name) ? opts.name : nextName('img');
        const p = placement(screen, parent);
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        const q = flatGroup(name, p.x, p.y, p.z, w, h, uv, parent);
        Undo.finishEdit('Add UI image', { outliner: true, elements: [q.cube], groups: [q.group] });
        if (artist) markStoredType(d, name, 'image');
        finishNewElement(d, screen, name, q.group, 'image', artist);
        return name;
    }
    function textureImageSource(tex) { return tex ? (tex.img && tex.img.naturalWidth ? tex.img : tex.canvas) : null; }

    // opts (optional) = { title, onPick(uv [u0,v0,u1,v1]) , initial [u0,v0,u1,v1] }: with onPick the dialog only picks a region
    // (no height/name) and hands it to the callback instead of adding an image.
    function imageDialog(opts) {
        opts = opts || {};
        needProject();
        const tex = mainTexture();
        if (!tex || !tex.width) throw new Error('El proyecto no tiene textura.');
        const tw = tex.width, th = tex.height;
        const ini = Array.isArray(opts.initial) && opts.initial.length === 4 ? opts.initial : null;
        const pk = { zoom: Math.max(1, Math.min(32, Math.floor(480 / tw))), u0: ini ? ini[0] : 0, v0: ini ? ini[1] : 0, u1: ini ? ini[2] : Math.min(8, tw), v1: ini ? ini[3] : Math.min(8, th), height: 8, name: '', drag: null, pickOnly: typeof opts.onPick === 'function' };
        const component = {
            data() { return { pk }; },
            computed: {
                width() { const vh = this.pk.v1 - this.pk.v0, uw = this.pk.u1 - this.pk.u0; return vh > 0 ? Math.round(this.pk.height * uw / vh * 100) / 100 : 0; },
            },
            mounted() { this.$nextTick(() => this.draw()); },
            watch: { 'pk.zoom'() { this.$nextTick(() => this.draw()); } },
            methods: {
                draw() {
                    const cv = this.$refs.cv;
                    if (!cv) return;
                    const z = this.pk.zoom;
                    cv.width = tw * z; cv.height = th * z;
                    const c = cv.getContext('2d');
                    c.imageSmoothingEnabled = false;
                    const sq = Math.max(4, Math.min(z, 8));
                    for (let y = 0; y < cv.height; y += sq) for (let x = 0; x < cv.width; x += sq) { c.fillStyle = ((x / sq + y / sq) & 1) ? '#555' : '#777'; c.fillRect(x, y, sq, sq); }
                    const src = textureImageSource(tex);
                    if (src) c.drawImage(src, 0, 0, tw * z, th * z);
                    const p = this.pk;
                    c.fillStyle = 'rgba(255,210,60,0.25)';
                    c.fillRect(p.u0 * z, p.v0 * z, (p.u1 - p.u0) * z, (p.v1 - p.v0) * z);
                    c.strokeStyle = '#ffd23c'; c.lineWidth = 2;
                    c.strokeRect(p.u0 * z + 1, p.v0 * z + 1, (p.u1 - p.u0) * z - 2, (p.v1 - p.v0) * z - 2);
                },
                px(e) {
                    const r = this.$refs.cv.getBoundingClientRect(), z = this.pk.zoom;
                    return [Math.max(0, Math.min(tw - 1, Math.floor((e.clientX - r.left) / z))), Math.max(0, Math.min(th - 1, Math.floor((e.clientY - r.top) / z)))];
                },
                rect(a, b) {
                    const p = this.pk;
                    p.u0 = Math.min(a[0], b[0]); p.v0 = Math.min(a[1], b[1]);
                    p.u1 = Math.max(a[0], b[0]) + 1; p.v1 = Math.max(a[1], b[1]) + 1;
                    this.draw();
                },
                down(e) { this.pk.drag = this.px(e); this.rect(this.pk.drag, this.pk.drag); },
                move(e) { if (this.pk.drag) this.rect(this.pk.drag, this.px(e)); },
                up() { this.pk.drag = null; },
                wheel(e) { this.pk.zoom = Math.max(1, Math.min(48, this.pk.zoom + (e.deltaY < 0 ? 1 : -1))); },
                num(k, v) {
                    const p = this.pk, n = Math.round(Number(v) || 0);
                    p[k] = k[0] === 'u' ? Math.max(0, Math.min(tw, n)) : Math.max(0, Math.min(th, n));
                    this.draw();
                },
            },
            template: '<div class="bbui-picker">' +
                '<div class="bbui-row"><label>Zoom</label><input type="range" min="1" max="48" v-model.number="pk.zoom"><span>{{pk.zoom}}x</span></div>' +
                '<div class="bbui-pkwrap"><canvas ref="cv" @mousedown.prevent="down" @mousemove="move" @mouseup="up" @mouseleave="up" @wheel.prevent="wheel"></canvas></div>' +
                '<div class="bbui-row"><label>UV (px)</label>' +
                '<input type="number" :value="pk.u0" @change="num(\'u0\', $event.target.value)"><input type="number" :value="pk.v0" @change="num(\'v0\', $event.target.value)">' +
                '<input type="number" :value="pk.u1" @change="num(\'u1\', $event.target.value)"><input type="number" :value="pk.v1" @change="num(\'v1\', $event.target.value)"></div>' +
                '<div class="bbui-row" v-if="!pk.pickOnly"><label>Alto</label><input type="number" min="0.5" step="0.5" v-model.number="pk.height"><span>ancho = {{width}}</span></div>' +
                '<div class="bbui-row" v-if="!pk.pickOnly"><label>Nombre</label><input type="text" v-model="pk.name" placeholder="(auto)"></div></div>',
        };
        const dlg = new Dialog({
            id: 'bb_ui_add_image', title: opts.title || 'Añadir imagen', width: 640, component,
            buttons: [pk.pickOnly ? 'Elegir' : 'Añadir', 'Cancelar'], confirmIndex: 0, cancelIndex: 1,
            onConfirm() {
                if (pk.pickOnly) {
                    if (!(pk.u1 > pk.u0 && pk.v1 > pk.v0)) { Blockbench.showQuickMessage('Rectangulo de UV vacio', 1500); return false; }
                    try { opts.onPick([pk.u0, pk.v0, pk.u1, pk.v1]); } catch (e) { console.error(e); }
                    return;
                }
                try { addImage({ uv: [pk.u0, pk.v0, pk.u1, pk.v1], height: pk.height, name: pk.name, artist: opts.artist }); }
                catch (e) { Blockbench.showMessageBox({ title: 'UI: Add Image', message: esc(e.message), icon: 'error' }); return false; }
            },
        });
        dlg.show();
        return dlg;
    }

    // ------------------------------------------------------------------ Fonts and text
    // Project.bbui.fonts = { name: { glyphs: { "<char>": [u0,v0,u1,v1] (texture px) }, size: [w,h] and advance in BLOCKS }  (editor-only, never in ui.json)
    function addFont(o) {
        const d = needProject();
        const tex = mainTexture();
        if (!tex || !tex.width) throw new Error('El proyecto no tiene textura.');
        const name = String(o.name || '').trim().replace(/[^A-Za-z0-9_]+/g, '_');
        if (!name) throw new Error('Nombre de fuente vacio.');
        const cw = Math.round(o.cw), chh = Math.round(o.ch), x0 = Math.round(o.x || 0), y0 = Math.round(o.y || 0);
        if (!(cw > 0 && chh > 0)) throw new Error('Tamano de celda invalido.');
        const chars = Array.from(String(o.chars || '').replace(/[\r\n]/g, ''));
        if (!chars.length) throw new Error('Sin caracteres.');
        const cols = Math.round(o.cols) > 0 ? Math.round(o.cols) : Math.max(1, Math.floor((tex.width - x0) / cw));
        const glyphs = {};
        chars.forEach((c, i) => {
            if (c === ' ') return;
            const u0 = x0 + (i % cols) * cw, v0 = y0 + Math.floor(i / cols) * chh;
            if (u0 + cw > tex.width || v0 + chh > tex.height) throw new Error('El caracter "' + c + '" (#' + (i + 1) + ') cae fuera de la textura (' + tex.width + 'x' + tex.height + ').');
            glyphs[c] = [u0, v0, u0 + cw, v0 + chh];
        });
        if (!d.fonts) core.set(d, 'fonts', {});
        core.set(d.fonts, name, { glyphs, size: [cw, chh], advance: o.advance > 0 ? o.advance : 0 }); // model units (1 texture px = 1 model unit)
        touch();
        return name;
    }
    function removeFont(name) { const d = getData(); if (d && d.fonts) { core.del(d.fonts, name); touch(); } }

    // Pure layout in model units at scale 1 (screen space: x right, y down, relative to the top-left of the block).
    // font.size = [w,h] of the largest glyph and font.advance = pen step, both in MODEL UNITS; glyph rects are texture pixels
    // (inverted rects are normalised). Glyph quads are scaled so the largest glyph measures font.size.
    core.layoutText = function (font, text, align) {
        const norm = (g) => [Math.min(g[0], g[2]), Math.min(g[1], g[3]), Math.max(g[0], g[2]), Math.max(g[1], g[3])];
        let refW = 0, refH = 0;
        for (const g of Object.values(font.glyphs || {})) { const n = norm(g); refW = Math.max(refW, n[2] - n[0]); refH = Math.max(refH, n[3] - n[1]); }
        refW = refW || 8; refH = refH || 8;
        // font.size / font.advance are MODEL UNITS (pixels of the model), like every other coordinate in the UI;
        // without a size, one texture pixel = one model unit
        const sz = font.size && font.size[0] > 0 && font.size[1] > 0 ? font.size : [refW, refH];
        const kx = sz[0] / refW, ky = sz[1] / refH;
        const adv = font.advance > 0 ? font.advance : 0;
        const lineH = sz[1] * 1.25;
        const lines = String(text).split('\n').map((ln) => {
            let pen = 0, right = 0;
            const items = [];
            for (const ch of Array.from(ln)) {
                // fonts often have only one case (the guide book's are lowercase): fall back to the other case
                const key = font.glyphs[ch] ? ch : font.glyphs[ch.toLowerCase()] ? ch.toLowerCase() : font.glyphs[ch.toUpperCase()] ? ch.toUpperCase() : ch;
                const g = font.glyphs[key] && norm(font.glyphs[key]);
                if (g) { const w = (g[2] - g[0]) * kx; items.push({ ch, x: pen, w, h: (g[3] - g[1]) * ky, uv: g }); right = pen + w; }
                pen += adv || (g ? (g[2] - g[0]) * kx + kx : sz[0]);
            }
            return { items, width: right };
        });
        const W = Math.max(0, ...lines.map((l) => l.width));
        const out = [];
        lines.forEach((l, r) => {
            const off = align === 'right' ? W - l.width : align === 'center' ? (W - l.width) / 2 : 0;
            for (const it of l.items) out.push({ ch: it.ch, x: it.x + off, y: r * lineH, w: it.w, h: it.h, uv: it.uv });
        });
        return { glyphs: out, width: W, height: lines.length * lineH };
    };

    // opts = { text, font, scale (model units per texture px), align: left|center|right, name? }
    function addText(opts) {
        const d = needProject();
        const font = d.fonts && d.fonts[opts.font];
        if (!font) throw new Error('Fuente "' + opts.font + '" no definida.');
        const text = String(opts.text || '');
        if (!text.trim()) throw new Error('Texto vacio.');
        if (!core.layoutText(font, text, 'left').glyphs.length) throw new Error('Ningun caracter del texto existe en la fuente.');
        const screen = core.getScreen(d, state.activeScreen);
        const artist = !!opts.artist || !state.dev;
        const parent = artist ? ensureFolder(screen) : selectedGroup();
        const name = opts.name && !boneNames().includes(opts.name) ? opts.name : nextName('txt');
        const p = placement(screen, parent);
        // the source is kept in editor.texts so the text can be edited / translated later (each language gets its own child group)
        const rec = { font: opts.font, scale: opts.scale > 0 ? opts.scale : 1, align: opts.align || 'left', cx: p.x, cy: p.y, z: p.z, text: { [editLang(d)]: text } };
        const acc = { groups: [], cubes: [] };
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        let t;
        if (core.isMulti(d)) {
            const g = new Group({ name, origin: [p.x, p.y, p.z] }).init();
            if (parent) g.addTo(parent);
            acc.groups.push(g);
            textBuild(d, g, rec, acc);
            t = { group: g, cubes: acc.cubes };
        } else {
            t = buildTextGroup({ name, font, text, scale: opts.scale, align: opts.align, cx: p.x, cy: p.y, z: p.z, parent });
            acc.groups.push(t.group);
        }
        Undo.finishEdit('Add UI text', { outliner: true, elements: t.cubes, groups: acc.groups });
        setTextRec(d, name, rec);
        markStoredType(d, name, 'text'); // an element of type image in Modo programador; the stored type tells text from image
        finishNewElement(d, screen, name, t.group, 'image', artist);
        return name;
    }
    // Builds a text group (glyph planes) without Undo or roles. o = { name, font (object), text, scale, align, cx, cy, z, parent }.
    // The block is centred on (cx, cy); screen-left = model +X. Returns { group, cubes, width, height } or null when nothing renders.
    function buildTextGroup(o) {
        const scale = o.scale > 0 ? o.scale : 1;
        const lay = core.layoutText(o.font, o.text, o.align || 'left');
        if (!lay.glyphs.length) return null;
        const tex = mainTexture(), k = uvScale(tex);
        const W = lay.width * scale, H = lay.height * scale;
        const cubes = [];
        const group = o.into || new Group({ name: o.name, origin: [o.cx, o.cy, o.z] }).init(); // o.into = an existing (empty) group to fill
        if (!o.into && o.parent) group.addTo(o.parent);
        lay.glyphs.forEach((g, i) => {
            const xl = o.cx + W / 2 - g.x * scale; // screen-left = model +X
            const yt = o.cy + H / 2 - g.y * scale;
            const cube = new Cube({ name: o.name + '_' + (i + 1), from: [xl - g.w * scale, yt - g.h * scale, o.z], to: [xl, yt, o.z] });
            try { cube.box_uv = false; } catch (e) {}
            cube.init();
            cube.addTo(group);
            try {
                cube.faces.north.uv = g.uv.map((n) => n * k);
                if (tex) cube.faces.north.texture = tex.uuid;
                for (const f of ['south', 'east', 'west', 'up', 'down']) { cube.faces[f].uv = [0, 0, 0, 0]; cube.faces[f].texture = null; } // untextured faces are not exported: with xray (no culling) a textured back face drew the atlas corner over the front
            } catch (e) {}
            cubes.push(cube);
        });
        return { group, cubes, width: W, height: H };
    }

    function textDialog(opts) {
        opts = opts || {};
        const d = needProject();
        const fonts = Object.keys(d.fonts || {});
        if (!fonts.length) throw new Error('No hay fuentes de texto: empieza con una plantilla (trae una fuente) o crea una en el Modo programador (Ajustes > Fuentes).');
        new Dialog({
            id: 'bb_ui_add_text', title: 'Añadir texto', width: 480,
            form: {
                text: { label: 'Texto', type: 'textarea', value: 'Hello' },
                font: { label: 'Fuente', type: 'select', options: Object.fromEntries(fonts.map((f) => [f, f])), value: fonts[0] },
                scale: { label: 'Escala (unidades por pixel)', type: 'number', value: 1, min: 0.05, step: 0.05 },
                align: { label: 'Alineacion', type: 'select', options: { left: 'left', center: 'center', right: 'right' }, value: 'center' },
            },
            onConfirm(f) {
                try { addText({ text: f.text, font: f.font, scale: f.scale, align: f.align, artist: opts.artist }); }
                catch (e) { Blockbench.showMessageBox({ title: 'UI: Add Text', message: esc(e.message), icon: 'error' }); return false; }
            },
        }).show();
    }
    function fontDialog() {
        needProject();
        new Dialog({
            id: 'bb_ui_add_font', title: 'UI: Create Font', width: 520,
            form: {
                name: { label: 'Nombre', type: 'text', value: 'main' },
                x: { label: 'Inicio X (px)', type: 'number', value: 0, min: 0 },
                y: { label: 'Inicio Y (px)', type: 'number', value: 0, min: 0 },
                cw: { label: 'Celda ancho (px)', type: 'number', value: 8, min: 1 },
                ch: { label: 'Celda alto (px)', type: 'number', value: 8, min: 1 },
                cols: { label: 'Columnas (0 = hasta el borde)', type: 'number', value: 0, min: 0 },
                advance: { label: 'Avance (px, 0 = ancho del glifo + 1)', type: 'number', value: 0, min: 0 },
                chars: { label: 'Caracteres (fila a fila; un espacio deja la celda vacia)', type: 'textarea', value: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
            },
            onConfirm(f) {
                try { addFont(f); Blockbench.showQuickMessage('Fuente "' + f.name + '" creada', 1500); }
                catch (e) { Blockbench.showMessageBox({ title: 'UI: Create Font', message: esc(e.message), icon: 'error' }); return false; }
            },
        }).show();
    }

    // ------------------------------------------------------------------ Tooltips (a `<highlight>_tip` group inside the highlight bone)
    // Editor-only record: Project.bbui.editor.tooltips[bone] = { text, font, side: derecha|izquierda|arriba|abajo, bg: [u0,v0,u1,v1] | null, uuid? }.
    // The runtime only shows highlight bones while their button is focused, so a group inside the highlight is the whole feature.
    const TIP_PAD = 2, TIP_GAP = 1.5;
    const tipTimers = {};
    function uniqueName(base) {
        const names = new Set(boneNames());
        if (!names.has(base)) return base;
        let n = 2;
        while (names.has(base + '_' + n)) n++;
        return base + '_' + n;
    }
    function collectTree(g, groups, cubes) {
        groups.push(g);
        for (const c of g.children || []) { if (c instanceof Group) collectTree(c, groups, cubes); else cubes.push(c); }
    }
    function removeGroupTree(g) {
        for (const c of (g.children || []).slice()) {
            if (c instanceof Group) removeGroupTree(c);
            else { try { c.remove(false); } catch (e) {} }
        }
        try { g.remove(false); } catch (e) {}
    }
    function tooltipRec(bone, create) {
        const d = getData();
        if (!d) return null;
        const t = d.editor && d.editor.tooltips && d.editor.tooltips[bone];
        if (t || !create) return t || null;
        const ed = editorData();
        if (!ed.tooltips) core.set(ed, 'tooltips', {});
        const fonts = Object.keys(d.fonts || {});
        core.set(ed.tooltips, bone, { text: '', font: fonts[0] || '', side: 'derecha', bg: null });
        return ed.tooltips[bone];
    }
    // The generated group of a tooltip (by uuid, or by the name `<highlight>_tip`), or null.
    function findTipGroup(bone) {
        try {
            const d = getData(), rec = d && d.editor && d.editor.tooltips && d.editor.tooltips[bone];
            if (!rec) return null;
            const groups = Group.all || [];
            let g = rec.uuid ? groups.find((x) => x.uuid === rec.uuid) : null;
            if (!g) {
                const f = core.findBone(d, bone), hl = f && f.element && f.element.highlight;
                if (hl) g = groups.find((x) => x.name === hl + '_tip') || null;
            }
            return g || null;
        } catch (e) { return null; }
    }
    // Builds the tip group (no Undo). acc = { groups: [], cubes: [] } receives everything created.
    function tipBuild(d, bone, rec, acc) {
        const f = core.findBone(d, bone), el = f && f.element;
        if (!el || el.type !== 'button') throw new Error('"' + bone + '" no es un boton.');
        const btn = (Group.all || []).find((g) => g.name === bone);
        if (!btn) throw new Error('No existe el grupo "' + bone + '".');
        const font = d.fonts && d.fonts[rec.font];
        if (!font) throw new Error('Tooltip de ' + bone + ': fuente "' + rec.font + '" no definida.');
        // one text per language (the background is shared and sized for the biggest one); no languages: the single text
        const multi = core.isMulti(d), map = tipMap(d, rec);
        const items = (multi ? d.languages.map((code) => ({ code, text: core.textFor(map, code, d) })) : [{ code: '', text: String(rec.text || '') }])
            .map((it) => Object.assign(it, { lay: core.layoutText(font, it.text, 'center') })).filter((it) => it.text.trim() && it.lay.glyphs.length);
        if (!items.length) throw new Error('Tooltip de ' + bone + ': ningun caracter existe en la fuente.');
        const lay = { width: Math.max(...items.map((it) => it.lay.width)), height: Math.max(...items.map((it) => it.lay.height)) };
        // Buttons inside rotated groups (e.g. the guide book, laid down and turned -90 deg): measure in model space
        // (world bounds) and build the tip inside counter-rotated wrappers, where the axes are the upright model's again.
        const rotAnc = [];
        for (let p = btn.parent; p instanceof Group; p = p.parent) if (Array.isArray(p.rotation) && p.rotation.some((v) => Math.abs(v) > 1e-6)) rotAnc.push(p);
        if (rotAnc.some((p) => p.rotation.filter((v) => Math.abs(v) > 1e-6).length > 1)) throw new Error('El botón está dentro de un grupo girado en varios ejes: el texto de ayuda no se puede colocar.');
        const bb = subtreeBounds(btn, rotAnc.length > 0);
        if (!bb) throw new Error('El boton "' + bone + '" no tiene cubos.');
        let hl = el.highlight ? (Group.all || []).find((g) => g.name === el.highlight) : null;
        if (!hl) {
            const hn = el.highlight && !boneNames().includes(el.highlight) ? el.highlight : uniqueName(bone + '_hl');
            hl = new Group({ name: hn, origin: btn.origin ? btn.origin.slice() : [0, 0, 0] }).init();
            if (btn.parent instanceof Group) hl.addTo(btn.parent);
            acc.groups.push(hl);
            core.set(el, 'highlight', hn);
        }
        // margins proportional to the letter size (UIs range from 0.5-unit to 7-unit letters)
        const pad = Math.min(TIP_PAD, lay.height * 0.45), gap = Math.min(TIP_GAP, lay.height * 0.8);
        const tw = lay.width + 2.5 * pad, th = lay.height + 2 * pad;
        let cx = (bb.mn[0] + bb.mx[0]) / 2, cy = (bb.mn[1] + bb.mx[1]) / 2;
        // screen-right = model -X
        if (rec.side === 'izquierda') cx = bb.mx[0] + gap + tw / 2;
        else if (rec.side === 'arriba') cy = bb.mx[1] + gap + th / 2;
        else if (rec.side === 'abajo') cy = bb.mn[1] - gap - th / 2;
        else cx = bb.mn[0] - gap - tw / 2;
        const z = bb.mn[2] - 0.4; // in front of the button (the viewer is on the -Z side)
        const tipName = hl.name + '_tip';
        // wrappers: the outermost (child of the highlight) undoes the innermost rotated ancestor, and so on outwards
        let holder = hl, outer = null;
        rotAnc.forEach((anc, i) => {
            const w = new Group({ name: i === 0 ? tipName : tipName + '_rot' + i, origin: anc.origin.slice(), rotation: anc.rotation.map((v) => -v) }).init();
            w.addTo(holder);
            acc.groups.push(w);
            if (!outer) outer = w;
            holder = w;
        });
        const tip = new Group({ name: outer ? tipName + '_in' : tipName, origin: [cx, cy, z] }).init();
        tip.addTo(holder);
        acc.groups.push(tip);
        if (Array.isArray(rec.bg) && rec.bg.length === 4) {
            const q = flatGroup(tipName + '_bg', cx, cy, z, tw, th, rec.bg, tip);
            acc.groups.push(q.group); acc.cubes.push(q.cube);
        }
        for (const it of items) {
            const t = buildTextGroup({ name: tipName + (it.code ? '_txt_' + it.code : '_txt'), font, text: it.text, scale: 1, align: 'center', cx, cy, z: z - 0.2, parent: tip });
            if (!t) continue;
            acc.groups.push(t.group); acc.cubes.push(...t.cubes);
            if (it.code) regTr(d, t.group.name, it.code);
        }
        core.set(rec, 'uuid', (outer || tip).uuid);
        return tip;
    }
    // Removes and rebuilds the tooltip group of a button (no Undo). og = its current group (or null). -> true when a tooltip exists afterwards.
    function tipRegen(d, bone, og, acc) {
        const rec = tooltipRec(bone);
        if (og) { dropTr(d, og); removeGroupTree(og); }
        if (rec && rec.uuid) core.del(rec, 'uuid');
        const has = tipHasText(d, rec);
        if (has) tipBuild(d, bone, rec, acc);
        return has;
    }
    // Rebuilds (or removes, when the text is empty) the tooltip of a button. Returns true when a tooltip group exists afterwards.
    function generateTooltip(bone) {
        const d = needProject();
        const f = core.findBone(d, bone);
        if (!f || !f.element || f.element.type !== 'button') throw new Error('"' + bone + '" no es un boton.');
        const old = findTipGroup(bone);
        const oldG = [], oldC = [];
        if (old) collectTree(old, oldG, oldC);
        const acc = { groups: [], cubes: [] };
        let has = false;
        Undo.initEdit({ outliner: true, elements: oldC, groups: oldG });
        try {
            has = tipRegen(d, bone, old, acc);
        } finally {
            Undo.finishEdit('Generate UI tooltip', { outliner: true, elements: acc.cubes, groups: acc.groups });
            try { Canvas.updateAll(); } catch (e) {}
            touch(); applyVisibility(); applyRoleColors(); syncState();
        }
        return has;
    }
    function scheduleTooltip(bone) {
        clearTimeout(tipTimers[bone]);
        tipTimers[bone] = setTimeout(() => {
            delete tipTimers[bone];
            try { if (getData() && core.findBone(getData(), bone)) generateTooltip(bone); }
            catch (e) { console.warn('BB UI Builder: tooltip', e); Blockbench.showQuickMessage(e.message, 2500); }
        }, 700);
    }
    // patch = { text?, font?, side?, bg? }. Regenerates the group after a short pause (or at once with now = true).
    function setTooltip(bone, patch, now) {
        needProject();
        const rec = tooltipRec(bone, true);
        for (const k of Object.keys(patch || {})) {
            if (k === 'side' && !TIP_SIDES.includes(patch[k])) continue;
            core.set(rec, k, patch[k]);
        }
        touch();
        if (now) { clearTimeout(tipTimers[bone]); return generateTooltip(bone); }
        scheduleTooltip(bone);
        return null;
    }
    function pickTooltipBg(bone) {
        needProject();
        const rec = tooltipRec(bone, true);
        imageDialog({ title: 'UI: fondo del tooltip', initial: rec.bg, onPick: (uv) => setTooltip(bone, { bg: uv.map((n) => Math.round(n)) }) });
    }

    // ------------------------------------------------------------------ Languages (CONTRACT "Idiomas")
    // d.languages = ['es','en',...] (first = default, active with 2+) and d.translations = { bone: code } are exported (core.cleanLanguages drops stale
    // entries). Editor-only sources: editor.texts[bone] = { font, scale, align, cx, cy, z, text: { code: string } } for text pieces and
    // editor.tooltips[bone] = { text (default language), texts: { code: string }, ... } for tooltips. Generated groups: a text piece `<bone>` holds one
    // `<bone>_<code>` child per language (single language: the glyphs directly), a tooltip holds `<tip>_txt_<code>` next to its shared background.
    function curLang(d) { d = d || getData(); const l = d && Array.isArray(d.languages) ? d.languages : []; return l.includes(state.lang) ? state.lang : (l[0] || ''); }
    function editLang(d) { return curLang(d) || core.defLang(d); } // key the text edits go to
    function regTr(d, name, code) { if (!d.translations) core.set(d, 'translations', {}); core.set(d.translations, name, code); }
    function dropTr(d, g) {
        if (!d.translations) return;
        const walk = (x) => {
            if (Object.prototype.hasOwnProperty.call(d.translations, x.name)) core.del(d.translations, x.name);
            for (const c of x.children || []) if (c instanceof Group) walk(c);
        };
        walk(g);
    }
    function textRec(bone) { const d = getData(); return (d && d.editor && d.editor.texts && d.editor.texts[bone]) || null; }
    function setTextRec(d, bone, rec) {
        const ed = editorData();
        if (!ed.texts) core.set(ed, 'texts', {});
        core.set(ed.texts, bone, rec);
    }
    // tooltip texts by language: rec.text is the default language, rec.texts the others
    function tipMap(d, rec) { const m = Object.assign({}, rec && rec.texts); m[core.defLang(d)] = String((rec && rec.text) || ''); return m; }
    function tipHasText(d, rec) {
        if (!rec) return false;
        if (!core.isMulti(d)) return !!String(rec.text || '').trim();
        return Object.values(tipMap(d, rec)).some((v) => String(v || '').trim());
    }
    // Fills the (empty) group g of a text piece from its record; no Undo. acc receives what is created.
    function textBuild(d, g, rec, acc) {
        const font = d.fonts && d.fonts[rec.font];
        if (!font) throw new Error('Texto «' + g.name + '»: la letra "' + rec.font + '" no existe.');
        const o = Array.isArray(g.origin) && g.origin.length >= 3 ? g.origin : [rec.cx, rec.cy, rec.z]; // the group origin follows the piece when it is moved
        const base = { font, scale: rec.scale, align: rec.align, cx: o[0], cy: o[1], z: o[2] };
        if (core.isMulti(d)) {
            for (const code of d.languages) {
                const text = core.textFor(rec.text, code, d);
                if (!text.trim()) continue;
                const t = buildTextGroup(Object.assign({ name: g.name + '_' + code, text, parent: g }, base));
                if (t) { acc.groups.push(t.group); acc.cubes.push(...t.cubes); regTr(d, t.group.name, code); }
            }
        } else {
            const text = core.textFor(rec.text, core.defLang(d), d);
            if (!text.trim()) return;
            const t = buildTextGroup(Object.assign({ name: g.name, text, into: g }, base));
            if (t) acc.cubes.push(...t.cubes);
        }
    }
    // Empties the group of a text piece and builds it again; no Undo.
    function textFill(d, bone, acc) {
        const rec = textRec(bone), g = findGroup(bone);
        if (!rec || !g) return;
        for (const c of (g.children || []).slice()) {
            if (c instanceof Group) { dropTr(d, c); removeGroupTree(c); }
            else { try { c.remove(false); } catch (e) {} }
        }
        textBuild(d, g, rec, acc);
    }
    // Rebuilds text pieces and tooltips in ONE Undo step. -> array of error messages (a failing item does not stop the others)
    function regenMany(textBones, tipBones, label) {
        const d = needProject();
        const tbs = (textBones || []).filter((b) => textRec(b) && findGroup(b));
        const pbs = (tipBones || []).filter((b) => { const f = core.findBone(d, b); return f && f.element && f.element.type === 'button'; });
        if (!tbs.length && !pbs.length) return [];
        const oldG = [], oldC = [], acc = { groups: [], cubes: [] }, errs = [];
        for (const b of tbs) for (const c of findGroup(b).children || []) { if (c instanceof Group) collectTree(c, oldG, oldC); else oldC.push(c); }
        const tipOld = pbs.map((b) => { const og = findTipGroup(b); if (og) collectTree(og, oldG, oldC); return og; });
        Undo.initEdit({ outliner: true, elements: oldC, groups: oldG });
        try {
            for (const b of tbs) { try { textFill(d, b, acc); } catch (e) { errs.push(e.message); } }
            pbs.forEach((b, i) => { try { tipRegen(d, b, tipOld[i], acc); } catch (e) { errs.push(e.message); } });
        } finally {
            Undo.finishEdit(label || 'Update UI texts', { outliner: true, elements: acc.cubes, groups: acc.groups });
            try { Canvas.updateAll(); } catch (e) {}
            touch(); applyVisibility(); applyRoleColors(); syncState();
        }
        return errs;
    }
    function regenText(bone) {
        const errs = regenMany([bone], [], 'Edit UI text');
        if (errs.length) throw new Error(errs[0]);
    }
    const textTimers = {};
    function scheduleText(bone) {
        clearTimeout(textTimers[bone]);
        textTimers[bone] = setTimeout(() => {
            delete textTimers[bone];
            try { if (getData() && textRec(bone)) regenText(bone); }
            catch (e) { console.warn('BB UI Builder: text', e); Blockbench.showQuickMessage(e.message, 2500); }
        }, 600);
    }
    // patch = { text?, lang? (default: the editing language), font?, scale?, align? }. Rebuilds after a short pause (at once with now = true).
    function setTextPiece(bone, patch, now) {
        const d = needProject();
        const rec = textRec(bone);
        if (!rec) throw new Error('Este texto se dibujó antes de que existieran los idiomas: se trata como una imagen.');
        patch = patch || {};
        if (typeof patch.text === 'string') {
            if (!rec.text) core.set(rec, 'text', {});
            core.set(rec.text, patch.lang || editLang(d), patch.text);
        }
        if (typeof patch.font === 'string' && d.fonts && d.fonts[patch.font]) core.set(rec, 'font', patch.font);
        if (patch.scale > 0) core.set(rec, 'scale', patch.scale);
        if (['left', 'center', 'right'].includes(patch.align)) core.set(rec, 'align', patch.align);
        touch();
        if (now) { clearTimeout(textTimers[bone]); return regenText(bone); }
        scheduleText(bone);
        return null;
    }
    // d.translations[bone] = code (that piece is only visible in that language); '' = every language
    function setPieceLang(bone, code) {
        const d = needProject();
        if (!findGroup(bone)) return;
        if (!code) { if (d.translations && Object.prototype.hasOwnProperty.call(d.translations, bone)) core.del(d.translations, bone); }
        else {
            if (!(d.languages || []).includes(code)) throw new Error('El idioma «' + code + '» no está en el proyecto.');
            regTr(d, bone, code);
        }
        touch(); applyVisibility(); syncState();
    }
    function setLang(code) {
        const d = getData();
        if (!d || !(d.languages || []).includes(code)) return;
        state.lang = code;
        applyVisibility(); syncState();
        try { Canvas.updateAll(); } catch (e) {}
    }
    function regenAll(label) {
        const d = getData();
        const tb = Object.keys((d.editor && d.editor.texts) || {});
        const pb = Object.keys((d.editor && d.editor.tooltips) || {});
        return regenMany(tb, pb, label);
    }
    function languagesChanged(label) {
        const d = getData();
        const errs = regenAll(label);
        const list = d.languages || [];
        if (d.translations) for (const k of Object.keys(d.translations)) if (!list.includes(d.translations[k])) core.del(d.translations, k);
        touch(); applyVisibility(); applyRoleColors(); syncState();
        if (errs.length) Blockbench.showQuickMessage(errs[0], 3500);
    }
    function addLanguage(code) {
        const d = needProject();
        code = String(code || '').trim().toLowerCase();
        if (!/^[a-z]{2,3}(_[a-z0-9]+)?$/.test(code)) throw new Error('Código de idioma no válido: «' + code + '».');
        const list = Array.isArray(d.languages) ? d.languages.slice() : [];
        if (list.includes(code)) return setLang(code);
        if (!list.length && code !== 'es') list.push('es'); // what is already drawn is Spanish
        list.push(code);
        core.set(d, 'languages', list);
        state.lang = code;
        languagesChanged('Add UI language');
    }
    function removeLanguage(code) {
        const d = needProject();
        const old = Array.isArray(d.languages) ? d.languages : [];
        const list = old.filter((c) => c !== code);
        if (list.length === old.length) return;
        if (old[0] === code && list[0]) { // the default language changes: the next one's tooltip texts become the main ones
            for (const rec of Object.values((d.editor && d.editor.tooltips) || {})) {
                const nt = rec.texts && rec.texts[list[0]];
                if (nt) { core.set(rec, 'text', nt); core.del(rec.texts, list[0]); }
            }
        }
        core.set(d, 'languages', list);
        if (!list.includes(state.lang)) state.lang = list[0] || '';
        languagesChanged('Remove UI language');
    }

    // ---- translation table
    function winLabel(d, g) {
        for (let x = g; x instanceof Group; x = x.parent) if (x.name === COMUNES) return 'Todas las ventanas';
        const sc = screenForGroup(d, g);
        return sc ? nice(sc.id) : '';
    }
    // rows: every text piece with a record and every tooltip, with one cell per language
    function translationItems(d) {
        const items = [], ed = d.editor || {}, langs = d.languages || [], def = core.defLang(d);
        for (const bone of Object.keys(ed.texts || {})) {
            const g = findGroup(bone), rec = ed.texts[bone];
            if (!g || !rec) continue;
            const cells = {};
            for (const c of langs) cells[c] = String((rec.text && rec.text[c]) || '');
            items.push({ key: 't:' + bone, kind: 'text', bone, win: winLabel(d, g), name: nice(bone), font: rec.font, cells, orig: Object.assign({}, cells) });
        }
        for (const bone of Object.keys(ed.tooltips || {})) {
            const g = findGroup(bone), rec = ed.tooltips[bone], f = core.findBone(d, bone);
            if (!g || !rec || !f || !f.element || !tipHasText(d, rec)) continue;
            const map = tipMap(d, rec), cells = {};
            for (const c of langs) cells[c] = String(map[c] || '');
            items.push({ key: 'p:' + bone, kind: 'tip', bone, win: nice(f.screen.id), name: 'Ayuda de ' + nice(bone), font: rec.font, cells, orig: Object.assign({}, cells) });
        }
        return items;
    }
    function applyTranslations(d, items) {
        const def = core.defLang(d), textB = [], tipB = [];
        for (const it of items) {
            if (!Object.keys(it.cells).some((c) => it.cells[c] !== it.orig[c])) continue;
            if (it.kind === 'text') {
                const rec = textRec(it.bone);
                if (!rec) continue;
                if (!rec.text) core.set(rec, 'text', {});
                for (const c of Object.keys(it.cells)) core.set(rec.text, c, it.cells[c]);
                textB.push(it.bone);
            } else {
                const rec = tooltipRec(it.bone);
                if (!rec) continue;
                for (const c of Object.keys(it.cells)) {
                    if (c === def) core.set(rec, 'text', it.cells[c]);
                    else { if (!rec.texts) core.set(rec, 'texts', {}); core.set(rec.texts, c, it.cells[c]); }
                }
                tipB.push(it.bone);
            }
        }
        if (!textB.length && !tipB.length) return;
        touch();
        const errs = regenMany(textB, tipB, 'Edit UI translations');
        if (errs.length) Blockbench.showMessageBox({ title: 'Traducciones', message: errs.map(esc).join('<br>'), icon: 'warning' });
    }
    function translationsDialog() {
        const d = needProject();
        if (!core.isMulti(d)) throw new Error('Añade al menos dos idiomas para traducir.');
        const items = translationItems(d);
        if (!items.length) throw new Error('Todavía no hay textos que traducir: añade un «Texto» o escribe el texto al pasar el ratón de un botón.');
        const def = core.defLang(d), fonts = d.fonts || {};
        const tr = { rows: items, langs: d.languages.map((c) => ({ code: c, name: core.langName(c) })), def, defName: core.langName(def) };
        const component = {
            data() { return { tr }; },
            computed: {
                pending() { let n = 0; for (const r of this.tr.rows) for (const l of this.tr.langs) if (!String(r.cells[l.code] || '').trim()) n++; return n; },
            },
            methods: {
                miss(r, code) { const f = fonts[r.font]; return f ? core.missingChars(f, r.cells[code]) : []; },
                hint(r, code) { return code === this.tr.def ? '(vacío)' : '(se ve en ' + this.tr.defName + ')'; },
            },
            template: '<div class="bbui-tr"><div class="bba-dim">Escribe cada texto en cada idioma. Una casilla vacía se ve en ' + esc(core.langName(def)) + '. <b v-if="pending">{{pending}} sin rellenar.</b></div>' +
                '<div class="bbui-trscroll"><table class="bbui-trtab"><thead><tr><th>Pieza</th><th v-for="l in tr.langs" :key="l.code">{{l.name}}</th></tr></thead><tbody>' +
                '<tr v-for="r in tr.rows" :key="r.key"><td class="bbui-trname"><small>{{r.win}}</small>{{r.name}}</td>' +
                '<td v-for="l in tr.langs" :key="l.code"><textarea rows="2" :class="{\'bbui-trempty\': !String(r.cells[l.code] || \'\').trim()}" :placeholder="hint(r, l.code)" v-model="r.cells[l.code]"></textarea>' +
                '<div v-if="miss(r, l.code).length" class="bbui-trwarn">La letra no tiene: {{miss(r, l.code).join(\' \')}}</div></td></tr></tbody></table></div></div>',
        };
        const dlg = new Dialog({
            id: 'bb_ui_translations', title: 'Traducciones', width: 900, component,
            buttons: ['Aplicar', 'Cancelar'], confirmIndex: 0, cancelIndex: 1,
            onConfirm() {
                try { applyTranslations(d, tr.rows); }
                catch (e) { Blockbench.showMessageBox({ title: 'Traducciones', message: esc(e.message), icon: 'error' }); return false; }
            },
        });
        dlg.show();
        return dlg;
    }

    // ------------------------------------------------------------------ UI animations (Blockbench Animation <-> role)
    function findAnimation(role) {
        try { return (Animation.all || []).find((a) => core.animRole(a.name) === role) || null; } catch (e) { return null; }
    }
    function createUiAnimation(role) {
        const d = needProject();
        if (!core.animRoles(d).includes(role)) throw new Error('Rol de animacion desconocido: ' + role);
        const prev = findAnimation(role);
        if (prev) { try { prev.select(); } catch (e) {} return prev.name; }
        const spec = core.animSpec(d.id, role);
        if ((Animation.all || []).some((a) => a.name === spec.name)) throw new Error('Ya existe una animacion llamada ' + spec.name + '.');
        const anim = new Animation({ name: spec.name, loop: spec.loop, length: spec.length });
        anim.add(true);
        try { anim.select(); } catch (e) {}
        touch(); syncState();
        return spec.name;
    }
    function editUiAnimation(role) {
        needProject();
        const anim = findAnimation(role);
        if (!anim) throw new Error('No hay animacion para "' + role + '": usa Crear.');
        try { Modes.options.animate.select(); } catch (e) { console.warn('BB UI Builder: no se pudo cambiar a modo Animate', e); }
        try { anim.select(); } catch (e) {}
        return anim.name;
    }
    // Rows for the panel: known roles with their animation (or null), and animations whose role the filter does not know.
    function animationReport() {
        const d = getData();
        if (!d) return { rows: [], extras: [] };
        const roles = core.animRoles(d);
        const names = state.animNames;
        const rows = roles.map((r) => ({ role: r, anim: names.find((n) => core.animRole(n) === r) || '' }));
        const known = new Set(roles);
        const extras = [];
        for (const n of names) {
            const r = core.animRole(n);
            if (known.has(r)) continue;
            const m = /^(screen|focus|press)\.(.+)$/.exec(r);
            if (m) extras.push({ name: n, msg: 'el build falla: ' + (m[1] === 'screen' ? 'la pantalla "' + m[2] + '" no existe' : '"' + m[2] + '" no es un boton') });
            else if (!r) extras.push({ name: n, msg: 'nombre vacio: el build falla' });
            else extras.push({ name: n, msg: 'no es un rol conocido: se reproduce siempre mientras la UI esta abierta (como idle)' });
        }
        return { rows, extras };
    }

    // ------------------------------------------------------------------ Templates
    const ATLAS = 128;
    const FONT_Y = 64, FONT_COLS = 16, FONT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?:-';
    // 5x7 bitmap font: one row of 7 five-bit values (MSB = leftmost pixel) per glyph.
    const FONT_ROWS = [
        'A 0E 11 11 1F 11 11 11', 'B 1E 11 11 1E 11 11 1E', 'C 0E 11 10 10 10 11 0E', 'D 1C 12 11 11 11 12 1C',
        'E 1F 10 10 1E 10 10 1F', 'F 1F 10 10 1E 10 10 10', 'G 0E 11 10 17 11 11 0F', 'H 11 11 11 1F 11 11 11',
        'I 0E 04 04 04 04 04 0E', 'J 07 02 02 02 02 12 0C', 'K 11 12 14 18 14 12 11', 'L 10 10 10 10 10 10 1F',
        'M 11 1B 15 15 11 11 11', 'N 11 11 19 15 13 11 11', 'O 0E 11 11 11 11 11 0E', 'P 1E 11 11 1E 10 10 10',
        'Q 0E 11 11 11 15 12 0D', 'R 1E 11 11 1E 14 12 11', 'S 0F 10 10 0E 01 01 1E', 'T 1F 04 04 04 04 04 04',
        'U 11 11 11 11 11 11 0E', 'V 11 11 11 11 11 0A 04', 'W 11 11 11 15 15 15 0A', 'X 11 11 0A 04 0A 11 11',
        'Y 11 11 11 0A 04 04 04', 'Z 1F 01 02 04 08 10 1F',
        '0 0E 11 13 15 19 11 0E', '1 04 0C 04 04 04 04 0E', '2 0E 11 01 02 04 08 1F', '3 1F 02 04 02 01 11 0E',
        '4 02 06 0A 12 1F 02 02', '5 1F 10 1E 01 01 11 0E', '6 06 08 10 1E 11 11 0E', '7 1F 01 02 04 08 08 08',
        '8 0E 11 11 0E 11 11 0E', '9 0E 11 11 0F 01 02 0C',
        '. 00 00 00 00 00 0C 0C', ', 00 00 00 00 0C 04 08', '! 04 04 04 04 04 00 04', '? 0E 11 01 02 04 00 04',
        ': 00 0C 0C 00 0C 0C 00', '- 00 00 00 1F 00 00 00',
    ];
    const TPL_UV = { panel: [0, 0, 32, 32], button: [32, 0, 64, 12], frame: [64, 0, 104, 16], arrowL: [0, 40, 12, 52], arrowR: [16, 40, 28, 52] };
    function hexColor(v, fallback) {
        let s = v && typeof v === 'object' && v.toHexString ? v.toHexString() : String(v || '');
        if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback;
    }
    // amt > 0 mixes towards white, < 0 towards black
    function shade(hex, amt) {
        const t = amt < 0 ? 0 : 255, a = Math.abs(amt);
        const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.substr(i, 2), 16) * (1 - a) + t * a));
        return '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
    }
    // The atlas: panel, button, highlight frame, arrows and the pixel font. Opaque except the glyph pixels and the frame centre.
    function drawAtlas(col) {
        const cv = document.createElement('canvas');
        cv.width = ATLAS; cv.height = ATLAS;
        const g = cv.getContext('2d');
        const box = (r, fill, border, bw) => {
            g.fillStyle = border; g.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
            g.fillStyle = fill; g.fillRect(r[0] + bw, r[1] + bw, r[2] - r[0] - 2 * bw, r[3] - r[1] - 2 * bw);
        };
        box(TPL_UV.panel, col.panel, shade(col.panel, 0.4), 2);
        box(TPL_UV.button, col.button, shade(col.button, 0.4), 1);
        // hollow frame: highlight bones are drawn after (over) their button, so the centre must be transparent
        g.fillStyle = col.highlight; g.fillRect(TPL_UV.frame[0], TPL_UV.frame[1], TPL_UV.frame[2] - TPL_UV.frame[0], TPL_UV.frame[3] - TPL_UV.frame[1]);
        g.clearRect(TPL_UV.frame[0] + 2, TPL_UV.frame[1] + 2, TPL_UV.frame[2] - TPL_UV.frame[0] - 4, TPL_UV.frame[3] - TPL_UV.frame[1] - 4);
        for (const [r, dir] of [[TPL_UV.arrowL, -1], [TPL_UV.arrowR, 1]]) {
            box(r, col.button, shade(col.button, 0.4), 1);
            const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
            g.fillStyle = col.text;
            g.beginPath();
            g.moveTo(cx + dir * 3, cy); g.lineTo(cx - dir * 2, cy - 4); g.lineTo(cx - dir * 2, cy + 4);
            g.closePath(); g.fill();
        }
        g.fillStyle = col.text;
        const rows = {};
        for (const l of FONT_ROWS) { const p = l.split(' '); rows[p[0]] = p.slice(1).map((h) => parseInt(h, 16)); }
        Array.from(FONT_CHARS).forEach((ch, i) => {
            const r = rows[ch];
            if (!r) return;
            const x0 = (i % FONT_COLS) * 5, y0 = FONT_Y + Math.floor(i / FONT_COLS) * 7;
            for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if ((r[y] >> (4 - x)) & 1) g.fillRect(x0 + x, y0 + y, 1, 1);
        });
        return cv;
    }
    function waitTexture(tex, ms) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => { if ((tex.width > 0 && tex.height > 0) || Date.now() - t0 > (ms || 5000)) return resolve(); setTimeout(tick, 50); };
            tick();
        });
    }
    function cleanText(s, fallback) {
        const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 .,!?:-]/g, '').trim();
        return t || fallback;
    }
    // o = { template: 'menu'|'book'|'confirm', count, title, panel, button, text, highlight (#rrggbb) }
    async function applyTemplate(o) {
        const d = needProject();
        o = o || {};
        try { removeEmptyFolders(); } catch (e) { console.warn('BB UI Builder: empty folders', e); } // the empty default window must not stay behind
        const kind = ['menu', 'book', 'confirm'].includes(o.template) ? o.template : 'menu';
        const col = { panel: hexColor(o.panel, '#2e3040'), button: hexColor(o.button, '#4a5070'), text: hexColor(o.text, '#ffffff'), highlight: hexColor(o.highlight, '#ffd23c') };
        const title = cleanText(o.title, kind === 'menu' ? 'MENU' : kind === 'book' ? 'LIBRO' : 'SEGURO?');
        const count = Math.max(kind === 'book' ? 2 : 1, Math.min(kind === 'book' ? 8 : 6, Math.round(Number(o.count) || 3)));

        // texture + font
        let tn = 'ui_atlas', n = 2;
        while ((Texture.all || []).some((t) => t.name === tn)) tn = 'ui_atlas_' + n++;
        const tex = new Texture({ name: tn });
        tex.fromDataURL(drawAtlas(col).toDataURL('image/png'));
        tex.add(false);
        await waitTexture(tex);
        if (!tex.width) { tex.width = ATLAS; tex.height = ATLAS; }
        try { tex.uv_width = ATLAS; tex.uv_height = ATLAS; } catch (e) {}
        try { Project.texture_width = ATLAS; Project.texture_height = ATLAS; } catch (e) {}
        try { tex.select(); } catch (e) {}
        core.set(editorData(), 'mainTexture', tn);
        const fontName = 'ui_font';
        addFont({ name: fontName, x: 0, y: FONT_Y, cw: 5, ch: 7, cols: FONT_COLS, advance: 6, chars: FONT_CHARS });

        // groups. Screen space: x to the right, y up; Blockbench x is mirrored (screen-right = model -X).
        const CY = 24, Z = -0.4;
        const acc = { groups: [], cubes: [] };
        const used = new Set(boneNames());
        const uname = (base) => { let nm = base, i = 2; while (used.has(nm)) nm = base + '_' + i++; used.add(nm); return nm; };
        let cur = null; // folder of the window being built (pieces without an explicit parent go inside it)
        const mkFolder = (base) => {
            const nm = uname(base);
            const g = new Group({ name: nm, origin: [0, 0, 0] }).init();
            acc.groups.push(g);
            return g;
        };
        const flat = (name, sx, sy, z, w, h, uv, parent) => {
            const q = flatGroup(name, -sx, CY + sy, z, w, h, uv, parent || cur);
            acc.groups.push(q.group); acc.cubes.push(q.cube);
            return q.group;
        };
        const label = (name, text, sx, sy, z, scale, parent) => {
            // the 7px glyphs sit in a block 1.25 lines tall: nudge down to centre them
            const t = buildTextGroup({ name, font: d.fonts[fontName], text, scale, align: 'center', cx: -sx, cy: CY + sy - 0.875 * scale, z, parent: parent || cur });
            if (!t) return null;
            acc.groups.push(t.group); acc.cubes.push(...t.cubes);
            return t.group;
        };
        const tips = [];
        const button = (base, text, sx, sy, w, h, action, tip, side) => {
            const name = uname(base), hl = state.dev ? uname(name + '_hl') : null; // artist mode: the runtime's default focus effect, no highlight bones
            const g = flat(name, sx, sy, Z, w, h, TPL_UV.button);
            // fit the label inside the button (5px glyphs, 6px advance)
            const tw = text.length * 6 - 1;
            label(name + '_txt', text, sx, sy, Z - 0.4, Math.min(1, (w - 4) / tw, (h - 2) / 7), g);
            if (hl) flat(hl, sx, sy, Z + 0.2, w + 4, h + 4, TPL_UV.frame);
            if (tip && state.dev) tips.push({ bone: name, text: tip, side: side || 'derecha' });
            return hl ? { bone: name, type: 'button', highlight: hl, action } : { bone: name, type: 'button', action };
        };
        const arrow = (base, uv, sx, sy, action, tip) => {
            const name = uname(base), hl = state.dev ? uname(name + '_hl') : null;
            flat(name, sx, sy, Z, 12, 12, uv);
            if (hl) flat(hl, sx, sy, Z + 0.2, 16, 16, TPL_UV.frame);
            if (tip && state.dev) tips.push({ bone: name, text: tip, side: 'arriba' });
            return hl ? { bone: name, type: 'button', highlight: hl, action } : { bone: name, type: 'button', action };
        };
        const heading = (base, text, W, H, scale) => {
            const name = uname(base);
            // never wider than the panel (W) minus its border
            const g = label(name, text, 0, H / 2 - 9, Z, Math.min(scale, (W - 12) / (text.length * 6 - 1)), null);
            return g ? g.name : null;
        };

        // shared folder (always visible): panel background. Reused if the project already has one.
        let comun = null;
        const common = () => {
            if (!comun) { const ex = (Group.all || []).find((g) => g.name === COMUNES && g.parent === 'root'); comun = ex || mkFolder(COMUNES); }
            return comun;
        };
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        let screens = [], start = 'inicio', H = 48, W = 104;
        try {
            if (kind === 'menu') {
                const rows = count + 1;
                H = 16 + rows * 12 + 6;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel, common());
                const scr = { id: 'inicio', bones: [], elements: [] };
                cur = mkFolder('ventana_inicio'); scr.bones.push(cur.name);
                heading('ui_title', title, W, H, 1.5);
                const y0 = H / 2 - 22;
                for (let i = 1; i <= count; i++) scr.elements.push(button('btn_' + i, 'OPCION ' + i, -26, y0 - (i - 1) * 12, 40, 10, { type: 'goto', screen: 'opcion_' + i }, 'IR A ' + i));
                scr.elements.push(button('btn_close', 'SALIR', -26, y0 - count * 12, 40, 10, { type: 'close' }, 'CERRAR'));
                scr.default_focus = scr.elements[0].bone;
                screens.push(scr);
                for (let i = 1; i <= count; i++) {
                    const s = { id: 'opcion_' + i, bones: [], elements: [] };
                    cur = mkFolder('ventana_opcion_' + i); s.bones.push(cur.name);
                    heading('opt_' + i + '_title', 'OPCION ' + i, W, H, 1.5);
                    heading('opt_' + i + '_info', 'EDITA ESTA PANTALLA', W, H - 22, 1);
                    const back = button('opt_' + i + '_back', 'ATRAS', 0, -H / 2 + 14, 40, 10, { type: 'goto', screen: 'inicio' });
                    s.elements.push(back); s.default_focus = back.bone;
                    screens.push(s);
                }
            } else if (kind === 'book') {
                W = 104; H = 64;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel, common());
                const by = -H / 2 + 10;
                for (let i = 1; i <= count; i++) {
                    const s = { id: 'pagina_' + i, bones: [], elements: [] };
                    cur = mkFolder('ventana_pagina_' + i); s.bones.push(cur.name);
                    heading('p' + i + '_title', title, W, H, 1.5);
                    heading('p' + i + '_body', 'PAGINA ' + i, W, H - 34, 1);
                    if (i > 1) s.elements.push(arrow('p' + i + '_prev', TPL_UV.arrowL, -36, by, { type: 'goto', screen: 'pagina_' + (i - 1) }, 'ATRAS'));
                    const close = button('p' + i + '_close', 'CERRAR', 0, by, 40, 10, { type: 'close' }, 'SALIR', 'arriba');
                    s.elements.push(close);
                    if (i < count) s.elements.push(arrow('p' + i + '_next', TPL_UV.arrowR, 36, by, { type: 'goto', screen: 'pagina_' + (i + 1) }, 'SIGUE'));
                    s.default_focus = i < count ? s.elements[s.elements.length - 1].bone : close.bone;
                    screens.push(s);
                }
                start = 'pagina_1';
            } else {
                W = 88; H = 48;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel, common());
                const scr = { id: 'inicio', bones: [], elements: [] };
                cur = mkFolder('ventana_inicio'); scr.bones.push(cur.name);
                heading('ui_title', title, W, H, 1.5);
                scr.elements.push(button('btn_yes', 'SI', -18, -6, 28, 10, { type: 'sequence', actions: [{ type: 'command', command: 'say Confirmado' }, { type: 'close' }] }, 'ACEPTAR', 'abajo'));
                scr.elements.push(button('btn_no', 'NO', 18, -6, 28, 10, { type: 'close' }, 'CANCELAR', 'abajo'));
                scr.default_focus = scr.elements[1].bone;
                screens.push(scr);
            }

            // data
            core.set(d, 'screens', screens);
            core.set(d, 'start_screen', start);
            core.set(d.display, 'distance', Math.max(2.5, Math.ceil(H * 1.2 / 22.4 * 10) / 10));
            if (!(d.open || []).length) core.set(d, 'open', [{ type: 'command', name: d.namespace + ':' + d.id + '_ui', permission: 'any' }]);
            const ed = editorData();
            if (!ed.tooltips) core.set(ed, 'tooltips', {});
            core.set(ed, 'transitions', {});
            for (const t of tips) {
                core.set(ed.tooltips, t.bone, { text: t.text, font: fontName, side: t.side, bg: TPL_UV.button.slice() });
                tipBuild(d, t.bone, ed.tooltips[t.bone], acc);
            }
        } finally {
            Undo.finishEdit('Create UI from template', { outliner: true, elements: acc.cubes, groups: acc.groups });
        }
        try { Canvas.updateAll(); } catch (e) {}
        state.activeScreen = start;
        touch(); applyVisibility(); applyRoleColors(); syncState();
        frame();
        return { screens: screens.map((s) => s.id), texture: tn, font: fontName };
    }
    function templateDialog() {
        needProject();
        const run = (f) => {
            applyTemplate(f).then(() => Blockbench.showQuickMessage('Plantilla creada', 1500))
                .catch((e) => { console.error(e); Blockbench.showMessageBox({ title: 'UI: plantilla', message: esc(e.message), icon: 'error' }); });
        };
        new Dialog({
            id: 'bb_ui_template', title: 'UI: Nueva UI desde plantilla', width: 480,
            form: {
                template: { label: 'Plantilla', type: 'select', options: { menu: 'Menu con botones', book: 'Libro con paginas', confirm: 'Confirmacion Si/No' }, value: 'menu' },
                count: { label: 'Botones / paginas', type: 'number', value: 3, min: 1, max: 8 },
                title: { label: 'Titulo (A-Z, 0-9)', type: 'text', value: 'MENU' },
                panel: { label: 'Color del panel', type: 'color', value: '#2e3040' },
                button: { label: 'Color del boton', type: 'color', value: '#4a5070' },
                text: { label: 'Color del texto', type: 'color', value: '#ffffff' },
                highlight: { label: 'Color del resaltado', type: 'color', value: '#ffd23c' },
            },
            onConfirm(f) {
                if ((Group.all || []).some((g) => !isEmptyFolder(g))) {
                    Blockbench.showMessageBox({
                        title: 'UI: plantilla', icon: 'warning', buttons: ['Continuar', 'Cancelar'], confirm: 0, cancel: 1,
                        message: 'El proyecto ya tiene grupos. La plantilla anade los suyos, reemplaza las pantallas y puede dejar huesos sueltos. Continuar?',
                    }, (i) => { if (i === 0) run(f); });
                } else run(f);
            },
        }).show();
    }

    // ------------------------------------------------------------------ piece types (panel / button / image / text / character ...)
    // Derived from what already exists, stored only when it cannot be derived:
    //   button = element of type button in a screen; number/model = elements of those types; character = name `personaje_*`;
    //   decor = listed in screen.bones; image = element of type image or `editor.types[bone] === 'image'`;
    //   panel / text / (hand-marked) image = editor.types[bone] (editor-only, stripped on export, follows renames).
    const PIECE_TYPES = {
        panel: { label: 'Panel', icon: 'dashboard', color: 3 },
        button: { label: 'Botón', icon: 'smart_button', color: 6 },
        image: { label: 'Imagen', icon: 'image', color: 5 },
        text: { label: 'Texto', icon: 'text_fields', color: 2 },
        character: { label: 'Personaje', icon: 'pets', color: 7 },
        number: { label: 'Número', icon: 'pin', color: 1 },
        model: { label: 'Modelo', icon: 'view_in_ar', color: 4 },
        decor: { label: 'Decoración', icon: 'category', color: 9 },
        highlight: { label: 'Resaltado', icon: 'highlight', color: 8 },
        tip: { label: 'Texto emergente', icon: 'chat_bubble_outline', color: 8 },
    };
    const MARKABLE = ['panel', 'image', 'text']; // the types kept in editor.types
    function markStoredType(d, name, type) {
        const ed = editorData();
        if (!ed.types) { if (!type) return; core.set(ed, 'types', {}); }
        if (type) { if (ed.types[name] !== type) core.set(ed.types, name, type); }
        else if (Object.prototype.hasOwnProperty.call(ed.types, name)) core.del(ed.types, name);
    }
    // bone name -> type for every bone the data knows about (not window specific). Names that do not exist are simply never looked up.
    function derivedTypes(d) {
        const t = {};
        const stored = (d.editor && d.editor.types) || {};
        for (const s of d.screens || []) {
            for (const b of s.bones || []) t[b] = 'decor';
            for (const e of s.elements || []) {
                t[e.bone] = e.type === 'image' && stored[e.bone] === 'text' ? 'text' : e.type;
                if (e.highlight) t[e.highlight] = 'highlight';
            }
        }
        for (const k of Object.keys(stored)) if (MARKABLE.includes(stored[k]) && (!t[k] || t[k] === 'decor')) t[k] = stored[k];
        return t;
    }
    // type of a bone by name, '' when it has none
    function typeOfName(types, name) {
        const t = types[name];
        if (/^personaje_/.test(name) && t !== 'button') return 'character';
        return t || '';
    }
    // The screen a group belongs to when it becomes a button: its window folder, else the screen listing it (or an ancestor), else the active one.
    function screenForGroup(d, g) {
        const chain = [];
        for (let x = g; x instanceof Group; x = x.parent) chain.push(x.name);
        for (const x of chain) if (/^ventana_/.test(x)) { const s = d.screens.find((sc) => (sc.bones || []).includes(x)); if (s) return s; }
        const hit = d.screens.filter((s) => chain.some((n) => (s.bones || []).includes(n) || (s.elements || []).some((e) => e.bone === n)));
        if (hit.length) return hit.find((s) => s.id === state.activeScreen) || hit[0];
        return core.getScreen(d, state.activeScreen);
    }
    const insideFolder = (g) => { for (let x = g.parent; x instanceof Group; x = x.parent) if (isFolderGroup(x)) return true; return false; };
    // kind: panel | button | image | text | decor (= no type)
    function setPieceType(name, kind) {
        const d = needProject();
        const g = findGroup(name);
        if (!g) return;
        if (isFolderGroup(g)) throw new Error('«' + nice(name) + '» es una ventana, no una pieza.');
        if (/^personaje_/.test(name)) throw new Error('Los personajes se añaden con «Personaje»; no cambian de tipo.');
        if (d.screens.some((s) => (s.elements || []).some((e) => e.highlight === name))) throw new Error('«' + nice(name) + '» es el resaltado de un botón.');
        const f = core.findBone(d, name), el = f && f.element;
        if (el && el.type !== 'button' && el.type !== 'image') throw new Error('Esta pieza es de tipo «' + el.type + '»: cámbiala en Modo programador.');
        if (kind === 'button') {
            if (!(el && el.type === 'button')) {
                if (g.parent instanceof Group && g.parent.name === COMUNES) throw new Error('Un botón debe estar en su ventana: usa «Poner solo en esta ventana».');
                const scr = screenForGroup(d, g);
                if (!scr) throw new Error('No hay ventana donde poner el botón.');
                core.assignBone(d, scr.id, name, 'button', []);
                markStoredType(d, name, null);
            }
        } else {
            const keepImageEl = !!el && el.type === 'image' && kind === 'image';
            if (el && !keepImageEl) {
                core.removeBone(d, name);
                // no window folder to hold it: keep the piece listed in its window instead of letting it float over every window
                if (!insideFolder(g) && f.screen) core.assignBone(d, f.screen.id, name, 'decor');
            }
            markStoredType(d, name, MARKABLE.includes(kind) && !keepImageEl ? kind : null);
        }
        touch(); applyVisibility(); applyRoleColors(); syncState();
    }
    // The type a piece shows as in the marking menu (decor = none for anything not markable)
    function markedKind(name) {
        const d = getData();
        if (!d) return 'decor';
        const t = typeOfName(derivedTypes(d), name);
        return ['panel', 'button', 'image', 'text', 'character'].includes(t) ? t : 'decor';
    }

    // Tree of the pieces of one window: typed groups (derived or stored) nested under their nearest typed ancestor; untyped
    // groups and cubes are skipped. Visibility is the one of applyVisibility (a group listed only in other windows hides its subtree).
    // -> { roots: [row], parentOf: {name: parentName}, names: Set, types: {name: type}, btn: {name: button of a highlight/tip row} }
    function buildPieceTree(d, activeId) {
        const out = { roots: [], parentOf: {}, names: new Set(), types: {}, btn: {} };
        const scr = d && core.getScreen(d, activeId);
        if (!scr) return out;
        const types = derivedTypes(d);
        const owner = {};
        const add = (b, id) => { (owner[b] = owner[b] || new Set()).add(id); };
        for (const s of d.screens) {
            for (const b of s.bones || []) add(b, s.id);
            for (const e of s.elements || []) { add(e.bone, s.id); if (e.highlight) add(e.highlight, s.id); }
        }
        const hlOf = {}, tipOf = new Map();
        for (const e of scr.elements || []) {
            if (e.highlight) hlOf[e.highlight] = e.bone;
            const tg = e.type === 'button' ? findTipGroup(e.bone) : null;
            if (tg) tipOf.set(tg, e);
        }
        const artist = !state.dev && !state.showAll;
        const rows = {};
        const walk = (nodes, parentRow) => {
            for (const g of nodes || []) {
                if (!(g instanceof Group)) continue;
                const o = owner[g.name];
                if (!state.showAll && o && !o.has(activeId)) continue;
                if (artist && g.export === false) continue;
                let type = '';
                if (tipOf.has(g)) type = 'tip';
                else if (hlOf[g.name]) type = 'highlight';
                else if (!isFolderGroup(g)) {
                    type = typeOfName(types, g.name);
                    if (type === 'highlight') type = ''; // highlight of an element of another window
                    if (!type && g.parent instanceof Group && isFolderGroup(g.parent) && subtreeCubes(g).length) type = 'decor';
                }
                let row = parentRow;
                if (type) {
                    row = { name: g.name, type, kids: [] };
                    rows[g.name] = row;
                    (parentRow ? parentRow.kids : out.roots).push(row);
                    out.parentOf[g.name] = parentRow ? parentRow.name : '';
                    out.names.add(g.name);
                    out.types[g.name] = type;
                }
                walk(g.children, row);
            }
        };
        walk(Outliner.root, null);
        // highlights hang from their button, tooltips from their highlight (or the button)
        const move = (row, target) => {
            if (!row || !target || row === target) return;
            for (let x = target.name; x; x = out.parentOf[x]) if (x === row.name) return; // never under its own descendant
            const list = out.parentOf[row.name] ? rows[out.parentOf[row.name]].kids : out.roots;
            const i = list.indexOf(row);
            if (i >= 0) list.splice(i, 1);
            target.kids.push(row);
            out.parentOf[row.name] = target.name;
        };
        for (const nm of Object.keys(hlOf)) if (rows[nm]) { out.btn[nm] = hlOf[nm]; move(rows[nm], rows[hlOf[nm]]); }
        for (const [g, e] of tipOf) if (rows[g.name]) { out.btn[g.name] = e.bone; move(rows[g.name], rows[e.highlight] || rows[e.bone]); }
        return out;
    }

    // ------------------------------------------------------------------ role colours (outliner)
    let colorSig = '';
    function applyRoleColors() {
        const d = getData();
        if (!d) return;
        const types = derivedTypes(d);
        for (const g of Group.all || []) {
            const r = typeOfName(types, g.name);
            const info = r && PIECE_TYPES[r];
            if (info) { if (g.color !== info.color) g.color = info.color; g.bbui_colored = true; }
            else if (g.bbui_colored) { g.color = 0; g.bbui_colored = false; }
        }
    }

    // ------------------------------------------------------------------ rename tracking
    const nameMaps = new WeakMap();
    function trackRenames() {
        const d = getData();
        if (!d) return;
        let m = nameMaps.get(Project);
        const first = !m;
        if (first) { m = new Map(); nameMaps.set(Project, m); }
        const alive = new Set();
        for (const g of Group.all || []) {
            alive.add(g.uuid);
            const old = m.get(g.uuid);
            if (!first && old !== undefined && old !== g.name) {
                if (core.renameBone(d, old, g.name)) touch();
                if (state.preview.focus === old) state.preview.focus = g.name;
                colorSig = '';
            }
            m.set(g.uuid, g.name);
        }
        for (const k of Array.from(m.keys())) if (!alive.has(k)) m.delete(k);
    }

    // ------------------------------------------------------------------ texture UV space (face UVs are TEXTURE PIXELS)
    const pendingTex = [];
    function onAddTexture(e) { const t = e && (e.texture || e); if (t && isUi()) pendingTex.push({ tex: t, at: Date.now() }); }
    function processTextures() {
        for (let i = pendingTex.length - 1; i >= 0; i--) {
            const { tex, at } = pendingTex[i];
            if (Date.now() - at < 700) continue;
            if (!tex.width) { if (Date.now() - at > 8000) pendingTex.splice(i, 1); continue; }
            pendingTex.splice(i, 1);
            let used = false;
            try { for (const c of Cube.all) for (const f in c.faces) if (c.faces[f].texture === tex.uuid && (c.faces[f].uv || []).some((n) => n)) used = true; } catch (er) {}
            if (!used && (tex.uv_width !== tex.width || tex.uv_height !== tex.height)) { tex.uv_width = tex.width; tex.uv_height = tex.height; }
        }
    }

    // ------------------------------------------------------------------ safe-zone guide (three.js overlay, never exported)
    let safeObj = null, safeKey = '';
    function removeSafe() {
        if (!safeObj) return;
        try { Canvas.scene.remove(safeObj); safeObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } catch (e) {}
        safeObj = null; safeKey = '';
        try { Preview.all.forEach((p) => p.render()); } catch (e) {}
    }
    // Bounds of every cube (model units), used as the "UI centre".
    function cubeBounds() {
        // world-space bounds of the rendered cubes (honours rotated/nested groups, e.g. a book rotated to face -Z)
        const box = new THREE.Box3();
        let any = false;
        for (const c of Cube.all || []) {
            if (!c.mesh || c.visibility === false) continue;
            try { c.mesh.updateMatrixWorld(true); box.expandByObject(c.mesh); any = true; } catch (e) {}
        }
        if (!any || box.isEmpty()) return null;
        return { mn: [box.min.x, box.min.y, box.min.z], mx: [box.max.x, box.max.y, box.max.z] };
    }
    function safeZone() {
        const d = getData();
        if (!state.safe || !d) return removeSafe();
        const b = cubeBounds();
        if (!b) return removeSafe();
        const disp = d.display || {};
        const fov = disp.fov > 0 && disp.fov < 180 ? disp.fov : 70, dist = disp.distance > 0 ? disp.distance : 2.5, hgt = disp.height || 0;
        const key = JSON.stringify([fov, dist, hgt, b.mn, b.mx]);
        if (safeObj && key === safeKey) return;
        removeSafe();
        const H = 2 * dist * Math.tan(fov * Math.PI / 360) * 16, W = H * 16 / 9;
        const cx = (b.mn[0] + b.mx[0]) / 2, cy = (b.mn[1] + b.mx[1]) / 2 - hgt * 16, z = b.mn[2] - 0.5; // just in front of the UI (it faces -Z)
        const pts = [];
        const rect = (w, h) => {
            const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
            pts.push(x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z);
        };
        rect(W, H);
        rect(W * 0.9, H * 0.9);
        pts.push(cx - 2, cy, z, cx + 2, cy, z, cx, cy - 2, z, cx, cy + 2, z);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffd23c, depthTest: false, transparent: true }));
        obj.renderOrder = 999;
        obj.frustumCulled = false;
        safeObj = new THREE.Group();
        safeObj.name = 'bb_ui_safe_zone';
        safeObj.add(obj);
        safeObj.bbui_info = { width: W, height: H, cx, cy };
        Canvas.scene.add(safeObj);
        safeKey = key;
        try { Preview.all.forEach((p) => p.render()); } catch (e) {}
    }
    function setSafe(on) { state.safe = !!on; safeZone(); }

    // ------------------------------------------------------------------ validate / export
    function exportedBoneNames() { try { return (Group.all || []).filter((g) => g.export !== false).map((g) => g.name); } catch (e) { return []; } }
    function validate() { return core.validate(getData(), exportedBoneNames()); }
    function showValidation(res, title) {
        const lines = [];
        res.errors.forEach((m) => lines.push('<b>Error:</b> ' + esc(m)));
        res.warnings.forEach((m) => lines.push('Aviso: ' + esc(m)));
        if (!lines.length) lines.push('Todo correcto.');
        Blockbench.showMessageBox({ title: title || 'Validar UI', message: lines.join('<br>'), icon: res.errors.length ? 'error' : 'check_circle' });
    }

    let fsMod = null;
    function getFs() {
        if (fsMod) return fsMod;
        if (typeof requireNativeModule === 'function') fsMod = requireNativeModule('fs', { message: 'BB UI Builder writes the UI into your Regolith data/bb_ui folder.' });
        else if (typeof require === 'function') fsMod = require('fs');
        return fsMod;
    }
    function getExportRoot(forcePick) {
        let root = '';
        try { root = localStorage.getItem(STORE_KEY) || ''; } catch (e) {}
        if (!root || forcePick) {
            const dir = Blockbench.pickDirectory({ title: '<your Regolith project>/packs/data/bb_ui', resource_id: 'bb_ui_export_root', startpath: root || undefined });
            if (!dir) return '';
            root = dir.replace(/\\/g, '/');
            try { localStorage.setItem(STORE_KEY, root); } catch (e) {}
        }
        return root;
    }
    function toObject(compiled) { return typeof compiled === 'string' ? JSON.parse(compiled) : compiled; }

    function exportTo(root, opts) {
        opts = opts || {};
        const d = ensureData();
        if (!d) throw new Error('No hay un proyecto Minecraft UI abierto.');
        const res = validate();
        if (res.errors.length && !opts.force) { const err = new Error('Validacion fallida: ' + res.errors.join(' | ')); err.validation = res; throw err; }
        const fs = getFs();
        if (!fs) throw new Error('Se necesita Blockbench de escritorio para exportar.');
        let dir;
        if (opts.dir) dir = String(opts.dir).replace(/\\/g, '/').replace(/\/$/, ''); // exact folder (artist mode: the folder the .bbmodel lives in)
        else {
            root = String(root || getExportRoot(false)).replace(/\\/g, '/').replace(/\/$/, '');
            if (!root) throw new Error('No hay carpeta de exportacion.');
            dir = root + '/' + d.id;
        }
        fs.mkdirSync(dir, { recursive: true });

        // geo.json: Codecs.bedrock writes the project as a single minecraft:geometry.
        try { if (!Project.geometry_name) Project.geometry_name = 'bb_ui_' + d.id + '_src'; } catch (e) {}
        const geo = toObject(showAllTemporarily(() => Codecs.bedrock.compile()));
        const geos = geo['minecraft:geometry'];
        if (!Array.isArray(geos) || geos.length !== 1) throw new Error('geo.json debe tener exactamente una geometria (tiene ' + (geos ? geos.length : 0) + ').');
        // the Bedrock codec ignores the group "Export" toggle: drop those groups and everything under them
        const skip = new Set();
        for (const g of Group.all || []) {
            for (let p = g; p instanceof Group; p = p.parent) if (p.export === false) { skip.add(g.name); break; }
        }
        if (skip.size) geos[0].bones = (geos[0].bones || []).filter((b) => !skip.has(b.name));
        const tex = mainTexture();
        if (!tex) throw new Error('El proyecto no tiene textura.');
        geoToTexturePixels(geos[0], tex);
        fs.writeFileSync(dir + '/geo.json', JSON.stringify(geo, null, 2));
        const files = ['ui.json', 'geo.json', 'texture.png'];
        const b64 = textureBase64(tex);
        if (!b64) throw new Error('No se pudo leer la textura.');
        fs.writeFileSync(dir + '/texture.png', Buffer.from(b64, 'base64'));

        // custom mouse cursor image (editor setting d.editor.cursorTexture) -> cursor.png; a stale one is removed
        const curName = d.editor && d.editor.cursorTexture;
        const curFile = dir + '/cursor.png';
        const curTex = curName ? (Texture.all || []).find((t) => t.name === curName && t !== tex) : null;
        if (curTex && textureBase64(curTex)) {
            fs.writeFileSync(curFile, Buffer.from(textureBase64(curTex), 'base64'));
            files.push('cursor.png');
        } else {
            if (curName) res.warnings.push('La textura del cursor "' + curName + '" no existe (o es la principal): se usa la flecha por defecto.');
            try { if (fs.existsSync(curFile)) fs.unlinkSync(curFile); } catch (e) {}
        }

        // fonts and other editor-only data stay in the .bbmodel (key bbui), never in ui.json
        const ui = clone(d);
        delete ui.fonts;
        delete ui.editor;
        { // languages: the filter errors on translations of bones that no longer exist, and ignores them with a single language
            const nTr = Object.keys(ui.translations || {}).length;
            core.cleanLanguages(ui, (geos[0].bones || []).map((b) => b.name));
            const left = Object.keys(ui.translations || {}).length;
            if (nTr > left && core.isMulti(ui)) res.warnings.push('Se quitaron ' + (nTr - left) + ' marca(s) de idioma de piezas que ya no existen.');
        }
        fs.writeFileSync(dir + '/ui.json', JSON.stringify(ui, null, 2));

        // Bedrock animations (same codec as File > Export > Bedrock animations), only when the project has some
        try {
            const anims = (typeof Animation !== 'undefined' && Animation.all) ? Animation.all.slice() : [];
            const animFile = dir + '/animations.json';
            if (anims.length) {
                fs.writeFileSync(animFile, typeof AnimationCodec !== 'undefined' ? toJsonText(AnimationCodec.codecs.bedrock.compileFile(anims)) : '{}');
                files.push('animations.json');
            } else if (fs.existsSync(animFile)) fs.unlinkSync(animFile);
        } catch (e) { res.warnings.push('animations.json no se pudo escribir: ' + e.message); }

        if (!opts.skipModel) {
            const proj = Codecs.project.compile();
            fs.writeFileSync(dir + '/model.bbmodel', typeof proj === 'string' ? proj : JSON.stringify(proj));
            files.push('model.bbmodel');
        }
        return { dir, files, warnings: res.warnings };
    }
    function textureBase64(tex) {
        let b64 = '';
        try { b64 = tex.getBase64(); } catch (e) {}
        if (!b64 && tex.canvas) { try { b64 = tex.canvas.toDataURL('image/png'); } catch (e) {} }
        return String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
    }
    function toJsonText(v) { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
    // Make geo UVs and texture_width/height refer to the real texture size (face UVs are texture pixels).
    function geoToTexturePixels(g, tex) {
        const desc = g.description || {};
        const from = desc.texture_width || Project.texture_width || tex.width;
        const fromH = desc.texture_height || Project.texture_height || tex.height;
        const sx = tex.width / from, sy = tex.height / fromH;
        desc.texture_width = tex.width; desc.texture_height = tex.height;
        if (sx === 1 && sy === 1) return;
        const sc = (a) => Array.isArray(a) ? [a[0] * sx, a[1] * sy].concat(a.slice(2)) : a;
        for (const b of g.bones || []) for (const c of b.cubes || []) {
            if (Array.isArray(c.uv)) c.uv = sc(c.uv);
            else if (c.uv) for (const f of Object.keys(c.uv)) { const fc = c.uv[f]; if (fc.uv) fc.uv = sc(fc.uv); if (fc.uv_size) fc.uv_size = sc(fc.uv_size); }
        }
    }
    function hasExportRoot() { try { return !!localStorage.getItem(STORE_KEY); } catch (e) { return false; } }
    function exportAction() {
        try {
            const root = getExportRoot(false);
            if (!root) return;
            const r = exportTo(root);
            Blockbench.showMessageBox({ title: 'Exportar UI', message: 'Escrito en <code>' + esc(r.dir) + '</code><br>' + r.files.join(', ') + (r.warnings.length ? '<br><br>' + r.warnings.map(esc).join('<br>') : '') + '<br><br>Ahora: <code>regolith run build</code>.', icon: 'check_circle' });
        } catch (e) {
            if (e.validation) showValidation(e.validation, 'Exportar UI: corrige esto primero');
            else Blockbench.showMessageBox({ title: 'Exportar UI', message: esc(e.message), icon: 'error' });
        }
    }


    // ------------------------------------------------------------------ Export & Build (regolith run <profile>)
    const PROFILE_KEY = 'bb_ui_builder_profile';
    function loadProfile() { try { state.profile = localStorage.getItem(PROFILE_KEY) || 'default'; } catch (e) { state.profile = 'default'; } }
    function setProfile(p) {
        state.profile = String(p || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '') || 'default';
        try { localStorage.setItem(PROFILE_KEY, state.profile); } catch (e) {}
    }
    // Folder containing config.json, walking up from `from`.
    function findRegolithRoot(from) {
        const fs = getFs();
        let dir = String(from || '').replace(/\\/g, '/').replace(/\/+$/, '');
        for (let i = 0; i < 12 && dir; i++) {
            if (fs.existsSync(dir + '/config.json')) return dir;
            const up = dir.replace(/\/[^/]*$/, '');
            if (!up || up === dir) break;
            dir = up;
        }
        return '';
    }
    function showOutput(title, ok, text) {
        try { const old = Dialog.open; if (old && old.id === 'bb_ui_build_output') old.close(); } catch (e) {}
        new Dialog({
            id: 'bb_ui_build_output', title, width: 760,
            lines: ['<div style="font-weight:bold;margin-bottom:6px;color:' + (ok ? '#00ce71' : '#fa565d') + '">' + (ok ? 'OK' : 'FALLO') + '</div>' +
                '<pre style="max-height:420px;overflow:auto;white-space:pre-wrap;user-select:text;font-size:12px;background:var(--color-back);padding:8px;border-radius:4px">' + esc(text || '(sin salida)') + '</pre>'],
            buttons: ['Cerrar'],
        }).show();
    }
    // Resolves { ok, code, output, cwd, profile }. Never rejects (errors go in output).
    // Regolith (Go) cannot create folders through a Windows junction: launchers like Amethyst turn
    // %APPDATA%/Minecraft Bedrock into one, and exporting to com.mojang then fails with "No se puede crear un archivo que ya
    // existe". Give this process the real path (COM_MOJANG, or the default location) with the junctions resolved.
    function resolveLinks(p) {
        const fs = getFs();
        if (!fs || !p) return p;
        try { if (fs.realpathSync && fs.realpathSync.native) { const r = fs.realpathSync.native(p); if (r) return r; } } catch (e) {}
        // walk the path and replace every junction/symlink prefix by its target ("/" works on Windows too)
        const parts = String(p).split(/[\\/]+/).filter((x, i) => x || i === 0);
        let cur = parts[0];
        for (let i = 1; i < parts.length; i++) {
            cur = cur + '/' + parts[i];
            try {
                const st = fs.lstatSync(cur);
                if (st.isSymbolicLink()) cur = String(fs.readlinkSync(cur)).replace(/^[\\/][\\/]\?[\\/]/, '').replace(/[\\/]+$/, '').split(/[\\/]+/).join('/');
            } catch (e) { break; }
        }
        return cur;
    }
    const normPath = (x) => String(x || '').split(/[\\/]+/).join('/').toLowerCase();
    // Blockbench's renderer has no usable process.env, so the values come from a Windows shell and the child process keeps
    // inheriting the real environment; only COM_MOJANG is overridden, with `set` in front of the command.
    function comMojangOverride(cp) {
        lastComMojang = '';
        try {
            if (!/^win/i.test((typeof navigator !== 'undefined' && navigator.platform) || 'win')) return '';
            const raw = String(cp.execSync('echo %COM_MOJANG%^|%APPDATA%', { windowsHide: true, shell: true })).trim();
            const [cm, appdata] = raw.split('|').map((x) => x.trim());
            const cur = cm && cm !== '%COM_MOJANG%' ? cm : (appdata && appdata !== '%APPDATA%' ? appdata + '/Minecraft Bedrock/Users/Shared/games/com.mojang' : '');
            if (!cur) return '';
            // Blockbench's fs is sandboxed and cannot walk system folders: resolve the junctions with PowerShell
            let real = '';
            try {
                const ps = "$c=$null; foreach($x in ('" + cur.replace(/'/g, "''") + "' -split '[\\\\/]+')){ if($c -eq $null){$c=$x}else{$c=$c+'\\'+$x; $i=Get-Item -LiteralPath $c -Force -ErrorAction Stop; if($i.LinkType){$c=[string]$i.Target[0]}} }; $c";
                real = String(cp.execSync('powershell -NoProfile -NonInteractive -Command "' + ps.replace(/"/g, '\\"') + '"', { windowsHide: true })).trim();
            } catch (e) { real = ''; }
            if (!real) real = resolveLinks(cur);
            lastComMojang = real || cur;
            if (real && normPath(real) !== normPath(cur)) return 'set "COM_MOJANG=' + real.split('/').join('\\') + '" && ';
        } catch (e) { console.warn('BB UI Builder: COM_MOJANG', e); lastComMojang = 'error: ' + e.message; }
        return '';
    }
    let lastComMojang = '';
    function runRegolith(cwd, profile) {
        return new Promise((resolve) => {
            let cp = null;
            try {
                cp = typeof requireNativeModule === 'function' ? requireNativeModule('child_process', { message: 'BB UI Builder runs "regolith run" after exporting.' }) : require('child_process');
            } catch (e) {}
            if (!cp) return resolve({ ok: false, code: -1, output: 'No se pudo cargar child_process (se necesita Blockbench de escritorio).', cwd, profile });
            let out = '', done = false, timer = null;
            const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ cwd, profile }, r, { output: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') })); };
            let child;
            try { child = cp.spawn(comMojangOverride(cp) + 'regolith run' + (profile ? ' ' + profile : ''), [], { cwd, shell: true, windowsHide: true }); }
            catch (e) { out += String(e.message); return finish({ ok: false, code: -1 }); }
            const add = (b) => { out += b.toString(); if (out.length > 200000) out = out.slice(-200000); };
            child.stdout && child.stdout.on('data', add);
            child.stderr && child.stderr.on('data', add);
            child.on('error', (e) => { out += '\n' + e.message; finish({ ok: false, code: -1 }); });
            child.on('close', (code) => finish({ ok: code === 0, code }));
            timer = setTimeout(() => { out += '\n[timeout 10 min, proceso cancelado]'; try { child.kill(); } catch (e) {} finish({ ok: false, code: -2 }); }, 600000);
        });
    }
    // Export, then `regolith run <profile>` in the Regolith project root. opts: { root, profile, silent }
    async function exportAndBuild(opts) {
        opts = opts || {};
        if (state.building) throw new Error('Ya hay un build en curso.');
        const root = opts.dir ? '' : (opts.root || getExportRoot(false));
        if (!root && !opts.dir) throw new Error('No hay carpeta de exportacion.');
        const r = exportTo(root, opts);
        const proj = findRegolithRoot(r.dir);
        if (!proj) {
            const msg = 'Exportado a ' + r.dir + ', pero no se encontro config.json (raiz del proyecto Regolith) subiendo desde esa carpeta.';
            if (!opts.silent) showOutput('Export & Build', false, msg);
            return { ok: false, exported: r, output: msg };
        }
        const profile = opts.profile !== undefined ? opts.profile : (state.profile || 'default');
        state.building = true;
        if (!opts.silent) Blockbench.showQuickMessage(('regolith run ' + profile).trim() + '...', 3000);
        let res;
        try { res = await runRegolith(proj, profile); } finally { state.building = false; }
        const head = '$ ' + ('regolith run ' + profile).trim() + '   (en ' + proj + ')\ncom.mojang: ' + (lastComMojang || '(por defecto)') + '\nExportado: ' + r.dir + '\nCodigo de salida: ' + res.code + '\n\n';
        if (!opts.silent) showOutput('Export & Build', res.ok, head + res.output);
        return Object.assign(res, { exported: r, cwd: proj });
    }
    function exportAndBuildAction() {
        exportAndBuild().catch((e) => {
            if (e.validation) showValidation(e.validation, 'Export & Build: corrige esto primero');
            else showOutput('Export & Build', false, e.message);
        });
    }

    // =====================================================================================
    // Artist mode: windows = top-level folders `ventana_<id>`, shared folder `comunes`, characters, transitions, test in game
    // =====================================================================================
    const findGroup = (name) => (Group.all || []).find((g) => g.name === name) || null;
    const slug = (s) => core.sanitizeId(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
    const nice = (id) => {
        // a window can carry a display name (screens[].name, ignored by the filter)
        try { const sc = (getData() || {}).screens || []; const w = sc.find((x) => x.id === id); if (w && w.name) return String(w.name); } catch (e) {}
        const t = String(id || '').replace(/^ventana_/, '').replace(/_+/g, ' ').replace(/^opcion\b/, 'opción').replace(/^pagina\b/, 'página').trim();
        return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
    };
    const isFolderGroup = (g) => g instanceof Group && g.parent === 'root' && (g.name === COMUNES || /^ventana_/.test(g.name));
    // The folder of a window: the `ventana_*` top-level group listed in screen.bones (null for old-style windows).
    function windowFolder(screen) {
        if (!screen) return null;
        for (const b of screen.bones || []) {
            if (!/^ventana_/.test(b)) continue;
            const g = findGroup(b);
            if (g && g.parent === 'root') return g;
        }
        return null;
    }
    // Creates the folder when the window has none: existing top-level pieces of the window are wrapped into it.
    function ensureFolder(screen) {
        let f = windowFolder(screen);
        if (f) return f;
        const d = needProject();
        const name = uniqueName('ventana_' + screen.id);
        const uses = {};
        for (const s of d.screens) {
            for (const b of s.bones || []) uses[b] = (uses[b] || 0) + 1;
            for (const e of s.elements || []) { uses[e.bone] = (uses[e.bone] || 0) + 1; if (e.highlight) uses[e.highlight] = (uses[e.highlight] || 0) + 1; }
        }
        const moved = new Set();
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        try {
            f = new Group({ name, origin: [0, 0, 0] }).init();
            const mine = (screen.bones || []).concat((screen.elements || []).reduce((a, e) => a.concat([e.bone], e.highlight ? [e.highlight] : []), []));
            for (const nm of mine) {
                const g = findGroup(nm);
                if (g && g !== f && g.parent === 'root' && uses[nm] === 1) { g.addTo(f); moved.add(nm); }
            }
        } finally { Undo.finishEdit('Create UI window folder', { outliner: true, elements: [], groups: [f] }); }
        core.set(screen, 'bones', [name].concat((screen.bones || []).filter((b) => !moved.has(b))));
        touch(); applyVisibility(); applyRoleColors(); syncState();
        return f;
    }
    // A window/common folder with no cubes inside is just the empty default: it counts as nothing.
    function isEmptyFolder(g) { return isFolderGroup(g) && !subtreeCubes(g).length; }
    function removeEmptyFolders() {
        for (const g of (Group.all || []).slice()) if (isEmptyFolder(g)) deleteGroupTree(g, 'Remove empty UI folder');
    }
    function ensureComunes() {
        let g = findGroup(COMUNES);
        if (g && g.parent === 'root') return g;
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        try { g = new Group({ name: uniqueName(COMUNES), origin: [0, 0, 0] }).init(); }
        finally { Undo.finishEdit('Create UI common folder', { outliner: true, elements: [], groups: [g] }); }
        return g;
    }
    // The piece of the selection: the group directly inside a window folder or comunes (null if none).
    function artistPiece(node) {
        let g = node instanceof Group ? node : (node && node.parent);
        let prev = null;
        const start = g;
        for (; g instanceof Group; prev = g, g = g.parent) if (isFolderGroup(g)) return prev;
        // UIs made without window folders (e.g. the guide book): the nearest ancestor that is an element (or its highlight)
        // or a listed piece of the active window
        try {
            const d = getData();
            const sc = d && core.getScreen(d, state.activeScreen);
            if (sc) {
                const names = new Set(sc.bones || []);
                const hl = {};
                for (const e of sc.elements || []) { names.add(e.bone); if (e.highlight) hl[e.highlight] = e.bone; }
                for (let x = start; x instanceof Group; x = x.parent) {
                    if (hl[x.name]) return findGroup(hl[x.name]) || x;
                    if (names.has(x.name)) return x;
                }
            }
        } catch (e) {}
        return null;
    }
    function frame() {
        try { if (inUiMode()) setTimeout(() => { try { applyGameView(true); } catch (e) {} }, 40); } catch (e) {}
    }
    function loadDev() { try { state.dev = localStorage.getItem(DEV_KEY) === '1'; } catch (e) { state.dev = false; } }
    function setDev(on) {
        state.dev = !!on;
        try { localStorage.setItem(DEV_KEY, on ? '1' : '0'); } catch (e) {}
        if (!on) { state.showSettings = false; state.showAnims = false; state.showAll = false; try { applyVisibility(); } catch (e) {} }
        refreshPanels();
    }
    function deleteGroupTree(g, label) {
        const gs = [], cs = [];
        collectTree(g, gs, cs);
        Undo.initEdit({ outliner: true, elements: cs, groups: gs });
        try { removeGroupTree(g); }
        finally { Undo.finishEdit(label || 'Delete UI group', { outliner: true, elements: [], groups: [] }); }
    }
    function deleteAnimation(a) {
        try { a.remove(false); } catch (e) { try { Animation.all.remove(a); } catch (e2) {} }
    }
    // Animations whose animators all belong to the given groups (a removed character takes its animations with it).
    function removeAnimationsOf(groups) {
        const ids = new Set(groups.map((g) => g.uuid));
        for (const a of (Animation.all || []).slice()) {
            const keys = Object.keys(a.animators || {});
            if (keys.length && keys.every((k) => ids.has(k))) deleteAnimation(a);
        }
    }

    // ------------------------------------------------------------------ windows
    function uniqueScreenId(base) {
        const d = needProject();
        let id = base, n = 2;
        while (core.getScreen(d, id)) id = base + '_' + n++;
        return id;
    }
    function createWindow(name) {
        const d = needProject();
        const id = uniqueScreenId(slug(name));
        d.screens.push({ id, bones: [], elements: [] });
        const screen = core.getScreen(d, id);
        const f = ensureFolder(screen);
        touch();
        gotoScreen(id);
        selectGroup(f); syncState();
        frame();
        return id;
    }
    function renameWindow(id, name) {
        const d = needProject();
        const nid = slug(name);
        if (nid === id) return;
        if (core.getScreen(d, nid)) throw new Error('Ya existe una ventana con ese nombre.');
        const screen = core.getScreen(d, id);
        const f = windowFolder(screen);
        core.renameScreen(d, id, nid);
        if (state.activeScreen === id) state.activeScreen = nid;
        if (f && f.name === 'ventana_' + id) {
            const nn = uniqueName('ventana_' + nid);
            core.renameBone(d, f.name, nn);
            Undo.initEdit({ groups: [f] });
            f.name = nn;
            Undo.finishEdit('Rename UI window', { groups: [f] });
            for (const a of Animation.all || []) { const an = (a.animators || {})[f.uuid]; if (an) an.name = nn; }
        }
        const an = findAnimation('screen.' + id);
        if (an) an.name = 'animation.screen.' + nid;
        const tr = d.editor && d.editor.transitions;
        if (tr && tr[id]) { core.set(tr, nid, tr[id]); core.del(tr, id); }
        trackRenames(); touch(); syncState();
    }
    function deleteWindow(id) {
        const d = needProject();
        if (d.screens.length < 2) throw new Error('Debe quedar al menos una ventana.');
        const k = d.screens.findIndex((s) => s.id === id);
        if (k < 0) return;
        const screen = d.screens[k];
        const folder = windowFolder(screen);
        const gs = [], cs = [];
        if (folder) collectTree(folder, gs, cs);
        d.screens.splice(k, 1);
        if (d.start_screen === id) d.start_screen = d.screens[0].id;
        for (const s of d.screens) for (const e of s.elements || []) for (const a of core.actionsOf(e.action)) {
            if (a.type === 'goto' && a.screen === id) { core.set(a, 'type', 'close'); core.del(a, 'screen'); }
        }
        const an = findAnimation('screen.' + id);
        if (an) deleteAnimation(an);
        const tr = d.editor && d.editor.transitions;
        if (tr && tr[id]) core.del(tr, id);
        if (folder) { removeAnimationsOf(gs); deleteGroupTree(folder, 'Delete UI window'); }
        if (state.activeScreen === id) state.activeScreen = d.start_screen;
        touch(); applyVisibility(); applyRoleColors(); syncState();
        gotoScreen(state.activeScreen);
        frame();
    }

    // ------------------------------------------------------------------ pieces (decoration / button / common)
    function pieceScreen() { const d = getData(); return d ? core.getScreen(d, state.activeScreen) : null; }
    function setPieceTarget(name, value) {
        const scr = pieceScreen();
        const el = scr && (scr.elements || []).find((e) => e.bone === name && e.type === 'button');
        if (!el || value === 'custom') return;
        if (value.indexOf('goto:') === 0) core.set(el, 'action', { type: 'goto', screen: value.slice(5) });
        else if (value === 'back') core.set(el, 'action', { type: 'back' });
        else core.set(el, 'action', { type: 'close' });
        touch();
    }
    function movePiece(name, toCommon) {
        const d = needProject(), scr = pieceScreen();
        const g = findGroup(name);
        if (!g || !scr) return;
        const dest = toCommon ? ensureComunes() : ensureFolder(scr);
        const f = core.findBone(d, name);
        if (toCommon && f && !f.decor) core.removeBone(d, name); // a button must stay in its window
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        try { g.addTo(dest); } finally { Undo.finishEdit('Move UI piece', { outliner: true, elements: [], groups: [g] }); }
        touch(); applyVisibility(); applyRoleColors(); syncState();
    }

    // ------------------------------------------------------------------ entry transitions (animation.screen.<id>)
    const TRANSITIONS = { none: 'Ninguna', top: 'Deslizar desde arriba', bottom: 'Deslizar desde abajo', left: 'Deslizar desde la izquierda', zoom: 'Aparecer con zoom', custom: 'Personalizada' };
    // Blockbench position keyframes: +x moves the piece to screen-right (the preview subtracts x), +y up. Flip a sign here if a slide looks mirrored.
    const SLIDE = { top: [0, 1], bottom: [0, -1], left: [-1, 0] };
    function addKeyframe(an, channel, time, v) {
        const dp = { x: v[0], y: v[1], z: v[2] };
        try { return an.addKeyframe({ time, channel, interpolation: 'linear', data_points: [dp] }); }
        catch (e) { return an.createKeyframe(dp, time, channel, false, false); }
    }
    function setTransition(kind) {
        const d = needProject();
        const screen = core.getScreen(d, state.activeScreen);
        if (!screen) return;
        const id = screen.id, name = 'animation.screen.' + id;
        const old = findAnimation('screen.' + id);
        const ed = editorData();
        if (!ed.transitions) core.set(ed, 'transitions', {});
        if (kind === 'none') {
            if (old) deleteAnimation(old);
            if (ed.transitions[id]) core.del(ed.transitions, id);
            touch(); syncState();
            return;
        }
        if (kind === 'custom' && old) {
            core.set(ed.transitions, id, 'custom'); touch();
            editUiAnimation('screen.' + id);
            return;
        }
        const folder = ensureFolder(screen);
        if (old) deleteAnimation(old);
        const anim = new Animation({ name, loop: 'once', length: 0.5 });
        anim.add(true);
        if (kind !== 'custom') {
            const b = subtreeBounds(folder, false);
            const w = b ? b.mx[0] - b.mn[0] : 40, h = b ? b.mx[1] - b.mn[1] : 40;
            const an = anim.getBoneAnimator(folder);
            if (kind === 'zoom') {
                if (b && (folder.origin || []).every((n) => !n)) folder.origin = [(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2]; // scale around the window centre
                for (const [t, s] of [[0, 0.05], [0.25, 0.8], [0.5, 1]]) addKeyframe(an, 'scale', t, [s, s, s]);
            } else {
                const dir = SLIDE[kind];
                const span = Math.max(24, (dir[0] ? w : h) * 1.15);
                for (const [t, f] of [[0, 1], [0.25, 0.25], [0.5, 0]]) addKeyframe(an, 'position', t, [dir[0] * span * f, dir[1] * span * f, 0]);
            }
        }
        core.set(ed.transitions, id, kind);
        touch(); syncState();
        if (kind === 'custom') editUiAnimation('screen.' + id);
    }

    // ------------------------------------------------------------------ characters (.bbmodel merged into the window)
    let merging = 0;
    function texReady(tex) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                const s = textureImageSource(tex);
                if ((s && (s.naturalWidth || s.width) > 0 && tex.width > 0) || Date.now() - t0 > 6000) return resolve();
                setTimeout(tick, 60);
            };
            tick();
        });
    }
    function mergeModel(model, path) {
        if (Codecs.project && typeof Codecs.project.merge === 'function') {
            merging++;
            try { Codecs.project.merge(model, path); } catch (e) { console.warn('BB UI Builder: Codecs.project.merge', e); } finally { merging--; }
        }
    }
    // Fallback when Codecs.project.merge did nothing: rebuild groups/cubes/animations from the bbmodel JSON (textures are not read).
    function manualMerge(model) {
        const map = {};
        const els = {};
        for (const e of model.elements || []) els[e.uuid] = e;
        const build = (node, parent) => {
            if (typeof node === 'string') {
                const e = els[node];
                if (!e || (e.type && e.type !== 'cube')) return;
                const c = new Cube(Object.assign({}, e, { uuid: undefined })).init();
                if (parent) c.addTo(parent);
                return;
            }
            const gd = Object.assign({}, node); delete gd.children; delete gd.uuid;
            const g = new Group(gd).init();
            map[node.uuid] = g.uuid;
            if (parent) g.addTo(parent);
            for (const ch of node.children || []) build(ch, g);
        };
        for (const n of model.outliner || []) build(n, null);
        for (const ad of model.animations || []) {
            const a = clone(ad);
            delete a.uuid;
            const an = {};
            for (const k of Object.keys(a.animators || {})) if (map[k]) an[map[k]] = a.animators[k];
            a.animators = an;
            try { new Animation().extend(a).add(false); } catch (e) { console.warn('BB UI Builder: animation', e); }
        }
    }
    // Merges every imported texture into the main UI texture (imported ones go below it) and moves the UVs. Returns a note.
    async function foldTextures(d, main, imported, model, boxCubes, importedCubes) {
        if (!imported.length) return 'sin textura propia';
        const srcs = [];
        let W = 0, H = 0;
        const uvW = (t) => { try { return Project.getUVWidth(t) || t.uv_width || t.width; } catch (e) { return t.uv_width || t.width; } };
        const uvH = (t) => { try { return Project.getUVHeight(t) || t.uv_height || t.height; } catch (e) { return t.uv_height || t.height; } };
        if (main) { await texReady(main); srcs.push({ tex: main, x: 0, y: 0, uw: uvW(main), uh: uvH(main) }); W = main.width; H = main.height; }
        const res = (model && model.resolution) || {};
        const mt = (model && model.textures) || [];
        for (let i = 0; i < imported.length; i++) {
            const t = imported[i];
            await texReady(t);
            srcs.push({ tex: t, x: 0, y: H, uw: uvW(t), uh: uvH(t), bw: res.width || t.width, bh: res.height || t.height });
            W = Math.max(W, t.width); H += t.height;
        }
        if (!(W > 0 && H > 0)) throw new Error('La textura del personaje no se pudo leer.');
        const byUuid = {};
        for (const s of srcs) byUuid[s.tex.uuid] = s;
        // single-texture formats: the merge points the character's faces at the UI texture and rescales their UVs into the
        // project's UV space, so the character's cubes are recognised by identity, not by face texture
        const impSet = new Set((importedCubes || []).map((c) => c.uuid));
        const impSrc = srcs.find((x) => x.tex !== main) || null;
        const projUw = main ? uvW(main) : 0, projUh = main ? uvH(main) : 0;
        // face UVs of every cube -> texture pixels in the combined image
        const faces = [];
        for (const c of Cube.all || []) for (const fk of Object.keys(c.faces || {})) {
            const f = c.faces[fk];
            const own = impSet.has(c.uuid) && impSrc;
            const s = own ? impSrc : byUuid[f.texture];
            if (!s || !Array.isArray(f.uv) || f.texture === null || f.texture === false) continue;
            const box = boxCubes && boxCubes.has(c.uuid);
            let kx = s.tex.width / (box ? s.bw : s.uw), ky = s.tex.height / (box ? s.bh : s.uh);
            if (own && !box && projUw && projUh && byUuid[f.texture] === srcs[0]) { kx = s.bw / projUw; ky = s.bh / projUh; }
            f.uv = [f.uv[0] * kx + s.x, f.uv[1] * ky + s.y, f.uv[2] * kx + s.x, f.uv[3] * ky + s.y];
            faces.push(f);
        }
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const g2 = cv.getContext('2d');
        for (const s of srcs) { try { g2.drawImage(textureImageSource(s.tex), s.x, s.y); } catch (e) { console.warn('BB UI Builder: draw texture', e); } }
        const keep = main ? main.name : 'ui_texture';
        const nt = new Texture({ name: keep + '__nuevo' });
        nt.fromDataURL(cv.toDataURL('image/png'));
        nt.add(false);
        const t0 = Date.now();
        await new Promise((resolve) => { const tick = () => { if ((nt.width === W && nt.height === H) || Date.now() - t0 > 5000) return resolve(); setTimeout(tick, 50); }; tick(); });
        if (nt.width !== W || nt.height !== H) { nt.width = W; nt.height = H; }
        for (const s of srcs) { try { s.tex.remove(true); } catch (e) { try { Texture.all.remove(s.tex); } catch (e2) {} } }
        nt.name = keep;
        try { nt.uv_width = W; nt.uv_height = H; } catch (e) {}
        try { Project.texture_width = W; Project.texture_height = H; } catch (e) {}
        for (const f of faces) f.texture = nt.uuid;
        core.set(editorData(), 'mainTexture', keep);
        try { nt.select(); } catch (e) {}
        return 'textura unida a la principal (' + W + 'x' + H + ')';
    }
    async function importCharacter(file) {
        const d = needProject();
        const screen = core.getScreen(d, state.activeScreen);
        if (!screen) throw new Error('No hay ventana activa.');
        const notes = [], gaps = [];
        let model;
        try { model = JSON.parse(typeof file.content === 'string' ? file.content : String(file.content)); }
        catch (e) { throw new Error('El archivo no es un .bbmodel valido.'); }
        const base = slug(String(file.name || 'personaje').replace(/\.[^.]+$/, '')) || 'personaje';
        const main = mainTexture();
        const folder = ensureFolder(screen);
        const ui = cubeBounds();
        const before = {
            g: new Set((Group.all || []).map((g) => g.uuid)), c: new Set((Cube.all || []).map((c) => c.uuid)),
            t: new Set((Texture.all || []).map((t) => t.uuid)), a: new Set((Animation.all || []).map((a) => a.uuid)),
        };
        mergeModel(model, file.path);
        let nGroups = (Group.all || []).filter((g) => !before.g.has(g.uuid));
        let nCubes = (Cube.all || []).filter((c) => !before.c.has(c.uuid));
        if (!nCubes.length) { // Codecs.project.merge unavailable or ignored
            merging++;
            try { manualMerge(model); } finally { merging--; }
            nGroups = (Group.all || []).filter((g) => !before.g.has(g.uuid));
            nCubes = (Cube.all || []).filter((c) => !before.c.has(c.uuid));
            if (nCubes.length) gaps.push('se uso el importador de emergencia: sin textura propia');
        }
        if (!nCubes.length) throw new Error('No se pudo importar el personaje (el modelo no tiene cubos).');
        const nTex = (Texture.all || []).filter((t) => !before.t.has(t.uuid));
        const nAnims = (Animation.all || []).filter((a) => !before.a.has(a.uuid));
        // cubes with box UV -> per-face UVs (the UI uses per-face UVs in texture pixels)
        // (updateUV writes the box layout into the faces; those UVs are in the character's own resolution, not the project's)
        const boxCubes = new Set();
        for (const c of nCubes) if (c.box_uv) { boxCubes.add(c.uuid); try { c.preview_controller.updateUV(c); } catch (e) {} try { c.box_uv = false; } catch (e) {} }
        // unique bone names
        const used = new Set((Group.all || []).filter((g) => !nGroups.includes(g)).map((g) => g.name));
        for (const g of nGroups) {
            let nm = g.name;
            if (used.has(nm)) { nm = base + '_' + g.name; let i = 2; while (used.has(nm)) nm = base + '_' + g.name + '_' + i++; g.name = nm; }
            used.add(nm);
        }
        // place it in front of the window, centred
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const c of nCubes) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c.from[k], c.to[k]); mx[k] = Math.max(mx[k], c.from[k], c.to[k]); }
        const tgt = ui ? [(ui.mn[0] + ui.mx[0]) / 2, (ui.mn[1] + ui.mx[1]) / 2, ui.mn[2] - 0.4] : [0, 24, -0.4];
        const dx = tgt[0] - (mn[0] + mx[0]) / 2, dy = tgt[1] - (mn[1] + mx[1]) / 2, dz = tgt[2] - mx[2];
        const sh = (a) => (Array.isArray(a) ? [a[0] + dx, a[1] + dy, a[2] + dz] : a);
        for (const g of nGroups) g.origin = sh(g.origin);
        for (const c of nCubes) { c.from = sh(c.from); c.to = sh(c.to); if (c.origin) c.origin = sh(c.origin); }
        const wrap = new Group({ name: uniqueName('personaje_' + base), origin: tgt.slice() }).init();
        wrap.addTo(folder);
        for (const n of [].concat(nGroups, nCubes)) if (n.parent === 'root') n.addTo(wrap);
        // textures
        if (!nTex.length && (model.textures || []).length) gaps.push('el personaje trae textura pero Blockbench no la cargo (su aspecto no se unio a la textura de la UI)');
        try { notes.push(await foldTextures(d, main, nTex, model, boxCubes, nCubes)); }
        catch (e) { console.error(e); gaps.push('textura: ' + e.message); }
        // animations: keep them (they play always); rename if they would clash with a UI role or another animation
        const roles = new Set(core.animRoles(d));
        const anNames = new Set((Animation.all || []).filter((a) => !nAnims.includes(a)).map((a) => a.name));
        for (const a of nAnims) {
            let nm = a.name;
            if (anNames.has(nm) || roles.has(core.animRole(nm))) {
                const tail = String(nm).replace(/^animation\./, '').replace(/\./g, '_');
                nm = 'animation.' + d.id + '.' + base + '_' + tail;
                let i = 2; while (anNames.has(nm)) nm = 'animation.' + d.id + '.' + base + '_' + tail + '_' + i++;
                a.name = nm;
            }
            anNames.add(nm);
            for (const k of Object.keys(a.animators || {})) { const g = (Group.all || []).find((x) => x.uuid === k); if (g && a.animators[k]) a.animators[k].name = g.name; }
        }
        notes.push(nAnims.length + ' animacion(es)');
        try { Canvas.updateAll(); } catch (e) {}
        touch(); applyVisibility(); applyRoleColors();
        selectGroup(wrap); syncState(); frame();
        const winH = ui ? ui.mx[1] - ui.mn[1] : 0, chH = mx[1] - mn[1];
        let hint = '';
        if (winH > 0 && chH > 0 && chH < winH * 0.2) {
            // tiny next to the window (a mob model is ~10 px, a UI ~70 px): scale it up to about a third of the window
            const k = Math.round((winH * 0.35 / chH) * 10) / 10;
            try { scaleCharacter(wrap.name, k); notes.push('agrandado x' + k); } catch (e) { console.warn('BB UI Builder: scale', e); }
        }
        if (winH > 0 && chH > winH * 0.6) hint = ' Es grande: usa "Tamano" en la tarjeta Seleccionado (sugerido x' + (Math.round(winH * 0.4 / chH * 100) / 100) + ').';
        return { name: wrap.name, notes, gaps, hint };
    }
    function addCharacter() {
        needProject();
        Blockbench.import({ extensions: ['bbmodel'], type: 'Blockbench Model', readtype: 'text', multiple: false, title: 'Elige el personaje (.bbmodel)' }, (files) => {
            if (!files || !files.length) return;
            importCharacter(files[0]).then((r) => {
                let msg = '<b>' + esc(nice(r.name.replace(/^personaje_/, ''))) + '</b> anadido: ' + esc(r.notes.join(', ')) + '.' + esc(r.hint);
                if (r.gaps.length) msg += '<br><br>No se pudo: ' + esc(r.gaps.join('; ')) + '.';
                msg += '<br><br>Esta accion no se deshace con Ctrl+Z: guarda antes de probar otro personaje.';
                Blockbench.showMessageBox({ title: 'Personaje', message: msg, icon: r.gaps.length ? 'warning' : 'check_circle' });
            }).catch((e) => { console.error(e); Blockbench.showMessageBox({ title: 'Personaje', message: esc(e.message), icon: 'error' }); });
        });
    }
    function scaleCharacter(name, s) {
        const g = findGroup(name);
        if (!g || !(s > 0) || s === 1) return;
        const o = g.origin || [0, 0, 0];
        const sc = (a) => (Array.isArray(a) ? [o[0] + (a[0] - o[0]) * s, o[1] + (a[1] - o[1]) * s, o[2] + (a[2] - o[2]) * s] : a);
        const gs = [], cs = [];
        collectTree(g, gs, cs);
        for (const x of gs) if (x !== g) x.origin = sc(x.origin);
        for (const c of cs) { c.from = sc(c.from); c.to = sc(c.to); if (c.origin) c.origin = sc(c.origin); if (c.inflate) c.inflate *= s; }
        const ids = new Set(gs.map((x) => x.uuid));
        for (const a of Animation.all || []) for (const k of Object.keys(a.animators || {})) {
            if (!ids.has(k)) continue;
            for (const kf of a.animators[k].position || []) for (const dp of kf.data_points || []) for (const ax of ['x', 'y', 'z']) {
                const v = dp[ax], n = Number(v);
                if (v !== '' && v !== undefined && v !== null && isFinite(n)) dp[ax] = typeof v === 'number' ? n * s : String(n * s);
            }
        }
        try { Canvas.updateAll(); } catch (e) {}
        touch(); syncState();
    }
    function removeCharacter(name) {
        const g = findGroup(name);
        if (!g) return;
        const gs = [], cs = [];
        collectTree(g, gs, cs);
        removeAnimationsOf(gs);
        deleteGroupTree(g, 'Remove UI character');
        touch(); applyRoleColors(); syncState();
    }

    // ------------------------------------------------------------------ save inside packs/data/bb_ui/<folder>/ + test in game
    let autoTimer = null, suppressUntil = 0;
    const saveTrack = { proj: null, saved: true, path: '' };
    // "<...>/data/bb_ui/<folder>/<file>.bbmodel" -> { dir, folder } or null
    function bbuiFolderOf(path) {
        const m = /^(.*[\\/]data[\\/]bb_ui[\\/]([^\\/]+))[\\/][^\\/]+$/i.exec(String(path || ''));
        return m ? { dir: m[1].replace(/\\/g, '/'), folder: m[2] } : null;
    }
    // A UI nobody can open is useless: make sure there is at least the default command.
    function ensureOpen(d) {
        if (d && !(d.open || []).length) { core.set(d, 'open', [{ type: 'command', name: d.namespace + ':' + d.id + '_ui', permission: 'any' }]); touch(); }
    }
    // Asks once (per project) whether the UI id should follow the folder name. Resolves when decided.
    function ensureIdMatches(info) {
        return new Promise((resolve) => {
            const d = getData();
            const want = core.sanitizeId(info.folder);
            const ed = d ? editorData() : null;
            if (!d || d.id === want || ed.idAsked === info.folder) return resolve();
            core.set(ed, 'idAsked', info.folder);
            touch();
            Blockbench.showMessageBox({
                title: 'Identificador de la UI',
                message: 'La carpeta se llama <b>' + esc(info.folder) + '</b> pero la UI se llama <b>' + esc(d.id) + '</b>. Usar el nombre de la carpeta?',
                buttons: ['Usar "' + want + '"', 'Dejar "' + d.id + '"'], confirm: 0, cancel: 1,
            }, (i) => {
                if (i === 0) {
                    const old = d.id;
                    for (const o of d.open || []) if (o.type === 'command' && o.name === d.namespace + ':' + old + '_ui') o.name = d.namespace + ':' + want + '_ui'; // keep the default command in step with the id
                    d.id = want; touch();
                }
                resolve();
            });
        });
    }
    function checkSaved() {
        if (!isUi()) { saveTrack.proj = null; return; }
        const saved = !!Project.saved, path = Project.save_path || '';
        if (saveTrack.proj !== Project) { saveTrack.proj = Project; saveTrack.saved = saved; saveTrack.path = path; saveTrack.t0 = Date.now(); return; }
        // opening a file also flips saved/path while it loads: only a save after the project settled counts
        const settled = Date.now() - (saveTrack.t0 || 0) > 5000;
        const just = settled && saved && !!path && (!saveTrack.saved || path !== saveTrack.path);
        saveTrack.saved = saved; saveTrack.path = path;
        if (just && Date.now() > suppressUntil && bbuiFolderOf(path)) {
            clearTimeout(autoTimer);
            autoTimer = setTimeout(() => { autoExport().catch((e) => console.warn('BB UI Builder: auto export', e)); }, 800);
        }
    }
    // After a manual save inside data/bb_ui/<folder>/: write ui.json / geo.json / texture.png / animations.json there.
    async function autoExport() {
        if (!isUi() || state.building) return;
        const info = bbuiFolderOf(Project.save_path);
        if (!info) return;
        await ensureIdMatches(info);
        try {
            ensureOpen(getData());
            const r = exportTo('', { dir: info.dir, skipModel: true });
            Blockbench.showQuickMessage('UI exportada a ' + info.folder + (r.warnings.length ? ' (con avisos)' : ''), 2000);
        } catch (e) {
            Blockbench.showQuickMessage('No se exporto: ' + (e.validation ? e.validation.errors[0] : e.message), 4000);
        }
    }
    function waitFor(fn, ms) {
        return new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (fn() || Date.now() - t0 > ms) return resolve(); setTimeout(tick, 100); }; tick(); });
    }
    async function testInGame() {
        if (state.building) return;
        const d = needProject();
        let info = bbuiFolderOf(Project.save_path);
        if (!info) {
            Blockbench.showMessageBox({
                title: 'regolith run', icon: 'info',
                message: 'Primero guarda este proyecto dentro de tu proyecto Regolith, en una carpeta propia de la UI:<br><br><code>packs/data/bb_ui/&lt;nombre_de_la_ui&gt;/ui.bbmodel</code><br><br>Usa Archivo &gt; Guardar como. Despues pulsa otra vez "regolith run".',
            });
            return;
        }
        suppressUntil = Date.now() + 6000;
        if (!Project.saved) {
            try { BarItems.save_project.trigger(); } catch (e) { console.warn('BB UI Builder: save', e); }
            await waitFor(() => Project.saved, 4000);
            info = bbuiFolderOf(Project.save_path) || info;
        }
        await ensureIdMatches(info);
        ensureOpen(getData());
        Blockbench.showQuickMessage('Construyendo...', 3000);
        let res;
        try { res = await exportAndBuild({ dir: info.dir, skipModel: true, silent: true, profile: '' }); }
        catch (e) {
            if (e.validation) return showValidation(e.validation, 'regolith run: corrige esto primero');
            return showOutput('regolith run', false, e.message);
        }
        if (res.ok) {
            const cmd = ((getData() || d).open || []).find((o) => o.type === 'command');
            Blockbench.showMessageBox({ title: 'regolith run', icon: 'check_circle', message: cmd ? 'Listo: abre el mundo y usa <code>/' + esc(cmd.name) + '</code>' : 'Listo: abre el mundo. (La UI no tiene comando de apertura: activa el Modo programador para anadir uno.)' });
        } else {
            showOutput('regolith run', false, 'No se pudo construir.\ncom.mojang: ' + (lastComMojang || '(por defecto)') + '\n\n' + (res.output || ''));
        }
    }

    // ------------------------------------------------------------------ start dialog for new projects
    function startEmpty() {
        try {
            const d = needProject();
            const s0 = d.screens[0];
            if (d.screens.length === 1 && s0.id === 'main' && !(s0.bones || []).length && !(s0.elements || []).length) {
                core.renameScreen(d, 'main', 'inicio');
                state.activeScreen = 'inicio';
            }
            ensureFolder(core.getScreen(d, state.activeScreen));
            ensureOpen(d);
            touch(); frame();
        } catch (e) { console.warn('BB UI Builder: start', e); }
    }
    function startDialog() {
        if (!isUi()) return;
        new Dialog({
            id: 'bb_ui_start', title: 'Nueva UI', width: 440,
            lines: ['<p>Como quieres empezar?</p>'],
            buttons: ['Empezar con una plantilla', 'Empezar vacío'], confirmIndex: 0, cancelIndex: 1,
            onConfirm() { try { templateDialog(); } catch (e) { startEmpty(); } },
            onCancel() { startEmpty(); },
        }).show();
    }
    const welcomed = new WeakSet();
    // Runs once per new project, after Blockbench's own "Proyecto" dialog has closed.
    function maybeWelcome() {
        if (!isUi() || welcomed.has(Project)) return;
        try { if (Dialog.open) return; } catch (e) {}
        welcomed.add(Project);
        startFlow();
    }
    function startFlow() {
        if (!isUi() || Project.save_path) return;
        const proj = Project, t0 = Date.now();
        // Blockbench opens its own "Proyecto" dialog and selects Edit mode right after creating a project:
        // wait until no dialog is open, then switch to UI mode and (for an empty project) offer the start dialog.
        const tick = () => {
            if (Project !== proj || !isUi()) return;
            if (Dialog.open && Date.now() - t0 < 120000) return setTimeout(tick, 250);
            const toUi = () => { try { const m = Modes.options[MODE_ID]; if (Project === proj && m && !inUiMode()) m.select(); } catch (e) { console.warn('BB UI Builder: mode', e); } };
            toUi();
            setTimeout(toUi, 600); setTimeout(toUi, 1500); // Blockbench may switch back to Edit right after setting up the project
            // the plugin itself creates an empty default window folder: only cubes mean the project already has content
            if ((Cube.all || []).length) return;
            try { startDialog(); } catch (e) {}
        };
        setTimeout(tick, 400);
    }

    // ------------------------------------------------------------------ project persistence
    function onCompile(e) {
        if (!e || !e.model || !isUi() || !Project.bbui) return;
        e.model.bbui = clone(Project.bbui);
    }
    function onParse(e) {
        if (merging > 0 || !e || !e.model || !e.model.bbui) return; // merging a character must not replace the UI data
        Project.bbui = e.model.bbui;
        state.data = null;
    }

    // ------------------------------------------------------------------ Vue templates
    const ACTION_FIELDS = {
        goto: [{ k: 'screen', t: 'screen' }],
        back: [], close: [], settings: [],
        command: [{ k: 'command', t: 'text' }, { k: 'as', t: 'select', o: ['player', 'server'] }],
        script: [{ k: 'fn', t: 'text' }, { k: 'args', t: 'json' }],
        set: [{ k: 'key', t: 'text' }, { k: 'value', t: 'value' }],
        add: [{ k: 'key', t: 'text' }, { k: 'amount', t: 'number' }, { k: 'min', t: 'number', opt: true }, { k: 'max', t: 'number', opt: true }],
        open_ui: [{ k: 'ui', t: 'text' }],
        sequence: [],
    };

    const ACTION_ORDER = ['goto', 'back', 'close', 'settings', 'open_ui', 'command', 'script', 'set', 'add', 'sequence'];
    const ACTION_LABEL = {
        goto: 'Ir a otra ventana', back: 'Volver a la anterior', close: 'Cerrar la UI', settings: 'Abrir ajustes', open_ui: 'Abrir otra UI',
        command: 'Ejecutar comando', script: 'Función de script', set: 'Guardar un valor', add: 'Sumar a un valor', sequence: 'Varias acciones',
    };
    const FIELD_LABEL = { screen: 'Ventana', command: 'Comando', as: 'Ejecutar', fn: 'Función', args: 'Argumentos (JSON)', key: 'Nombre del valor', value: 'Valor', amount: 'Cantidad', min: 'Mínimo', max: 'Máximo', ui: 'Id de la UI' };
    const FIELD_HINT = { command: 'say Hola (sin /)', fn: 'miFuncion', key: 'monedas', ui: 'mi_otra_ui' };
    const OPT_LABEL = { player: 'Como jugador', server: 'Como servidor' };
    const TIP_SIDE_LABEL = { derecha: 'A la derecha', izquierda: 'A la izquierda', arriba: 'Arriba', abajo: 'Abajo' };
    const DIR_LABEL = { up: 'Arriba', down: 'Abajo', left: 'Izquierda', right: 'Derecha' };
    const KIND_LABEL = { button: 'Botón', image: 'Imagen', number: 'Número', model: 'Modelo', decor: 'Decorado' };

    const actionComp = {
        name: 'bbui-action',
        props: ['action', 'screens', 'nested'],
        computed: {
            fields() { return ACTION_FIELDS[this.action.type] || []; },
            typeList() { return this.nested ? ACTION_ORDER.filter((t) => t !== 'sequence') : ACTION_ORDER; },
        },
        methods: {
            typeLabel(t) { return ACTION_LABEL[t] || t; },
            fieldLabel(k) { return FIELD_LABEL[k] || k; },
            optLabel(o) { return OPT_LABEL[o] || o; },
            hint(k) { return FIELD_HINT[k] || ''; },
            setType(t) {
                for (const k of Object.keys(this.action)) if (k !== 'type') core.del(this.action, k);
                core.set(this.action, 'type', t);
                if (t === 'goto') core.set(this.action, 'screen', this.screens[0] ? this.screens[0].id : '');
                if (t === 'command') core.set(this.action, 'command', '');
                if (t === 'script') core.set(this.action, 'fn', '');
                if (t === 'set') { core.set(this.action, 'key', ''); core.set(this.action, 'value', 0); }
                if (t === 'add') { core.set(this.action, 'key', ''); core.set(this.action, 'amount', 1); }
                if (t === 'open_ui') core.set(this.action, 'ui', '');
                if (t === 'sequence') core.set(this.action, 'actions', []);
                touch();
            },
            show(f) {
                const v = this.action[f.k];
                if (f.t === 'json') return JSON.stringify(v || {});
                if (f.t === 'value') return v === undefined ? '' : JSON.stringify(v);
                return v === undefined ? '' : v;
            },
            setF(f, raw) {
                if (f.t === 'number') {
                    if (raw === '' && f.opt) core.del(this.action, f.k);
                    else core.set(this.action, f.k, Number(raw) || 0);
                } else if (f.t === 'json') {
                    try { const o = JSON.parse(raw || '{}'); if (Object.keys(o).length) core.set(this.action, f.k, o); else core.del(this.action, f.k); }
                    catch (e) { Blockbench.showQuickMessage('JSON inválido', 1500); return; }
                } else if (f.t === 'value') {
                    let v = raw; try { v = JSON.parse(raw); } catch (e) {}
                    core.set(this.action, f.k, v);
                } else if (f.k === 'as' && raw === 'player') core.del(this.action, f.k);
                else core.set(this.action, f.k, raw);
                touch();
            },
            addSub() { this.action.actions.push({ type: 'close' }); touch(); },
            delSub(i) { this.action.actions.splice(i, 1); touch(); },
        },
        template: `<div class="bbui-action">
            <select @change="setType($event.target.value)"><option v-for="t in typeList" :value="t" :selected="t === action.type">{{typeLabel(t)}}</option></select>
            <div v-for="f in fields" class="bbui-row"><label>{{fieldLabel(f.k)}}</label>
            <select v-if="f.t === 'screen'" @change="setF(f, $event.target.value)"><option v-for="s in screens" :value="s.id" :selected="s.id === action.screen">{{s.id}}</option></select>
            <select v-else-if="f.t === 'select'" @change="setF(f, $event.target.value)"><option v-for="o in f.o" :value="o" :selected="o === (action[f.k] || f.o[0])">{{optLabel(o)}}</option></select>
            <input v-else :type="f.t === 'number' ? 'number' : 'text'" :value="show(f)" :placeholder="hint(f.k)" @change="setF(f, $event.target.value)">
            </div>
            <div v-if="action.type === 'sequence'" class="bbui-seq"><div class="bbui-dim">Se ejecutan en orden:</div>
            <div v-for="(a, i) in action.actions" class="bbui-seqitem"><bbui-action :action="a" :screens="screens" :nested="true"></bbui-action><button class="bbui-x" title="Quitar" @click="delSub(i)">x</button></div>
            <button @click="addSub">+ Añadir acción</button></div></div>`,
    };

    const TPL_SCREENS = `<div class="bbui" v-if="st.data">
        <div class="bbui-tools">
        <button class="bbui-tool" title="Añadir un botón a esta ventana" @click="addBtn"><i class="material-icons">smart_button</i><span>+ Botón</span></button>
        <button class="bbui-tool" title="Añadir un texto a esta ventana" @click="addTxt"><i class="material-icons">text_fields</i><span>+ Texto</span></button>
        <button class="bbui-tool" title="Añadir una imagen (eliges la zona de la textura)" @click="addImg"><i class="material-icons">image</i><span>+ Imagen</span></button>
        <button class="bbui-tool" :class="{on: st.preview.on}" :title="st.preview.on ? 'Detener la prueba' : 'Probar la navegación con flechas y Enter'" @click="togglePreview"><i class="material-icons">{{st.preview.on ? 'stop' : 'play_arrow'}}</i><span>Probar</span></button>
        <button class="bbui-tool" title="Exportar al pack (y construir si hay carpeta configurada)" @click="exportIt"><i class="material-icons">upload</i><span>Exportar</span></button>
        <button class="bbui-tool" :class="{on: st.showSettings}" title="Ajustes de la UI: distancia, sonidos, cómo se abre, fuentes..." @click="openSettings"><i class="material-icons">settings</i><span>Ajustes</span></button>
        <button class="bbui-tool" title="Vista de juego: cámara frontal ortogonal centrada en la UI" @click="gameView"><i class="material-icons">videocam</i><span>Vista de juego</span></button>
        </div>
        <div class="bbui-sec">Ventanas</div>
        <div v-for="s in st.data.screens" :key="s.id" class="bbui-screen" :class="{active: s.id === st.activeScreen}" title="Clic: editar esta ventana. Doble clic: renombrar" @click="activate(s.id)" @dblclick="rename(s.id)">
        <button class="bbui-star" :class="{on: s.id === st.data.start_screen}" :title="s.id === st.data.start_screen ? 'Ventana inicial' : 'Marcar como ventana inicial'" @click.stop="setStart(s.id)">{{s.id === st.data.start_screen ? '★' : '☆'}}</button>
        <span class="bbui-name">{{s.id}}</span>
        <span class="bbui-tag">{{btnCount(s)}} botón(es)</span>
        <button title="Renombrar" @click.stop="rename(s.id)">&#9998;</button>
        <button title="Eliminar la ventana" @click.stop="remove(s.id)">&#10005;</button></div>
        <button @click="add">+ Nueva ventana</button>
        <div class="bbui-chks"><label class="bbui-chk"><input type="checkbox" v-model="st.showAll" @change="refresh"> Mostrar todas las capas</label>
        <label class="bbui-chk"><input type="checkbox" v-model="st.safe" @change="applySafe"> Marco de pantalla</label>
        <label class="bbui-chk"><input type="checkbox" v-model="st.showTips" @change="refresh"> Mostrar textos de ayuda</label></div>
        <div v-if="st.preview.on" class="bbui-box"><b>Probando</b> <span>Foco: <b>{{st.preview.focus}}</b> (flechas, Enter, Esc)</span>
        <div class="bbui-pad"><button @click="mv('up')">&#9650;</button><br><button @click="mv('left')">&#9664;</button><button @click="ok">OK</button><button @click="mv('right')">&#9654;</button><br><button @click="mv('down')">&#9660;</button></div></div></div>`;

    const TPL_ELEMENT = `<div class="bbui" v-if="st.data">
        <div v-if="kind === 'screen' && screen">
        <div class="bbui-head">Ventana · {{screen.id}}</div>
        <div class="bbui-dim">Haz clic en un elemento del visor para editarlo.</div>
        <div class="bbui-row"><label>Nombre</label><input type="text" :value="screen.id" @change="renameScreenTo($event.target.value)"></div>
        <div class="bbui-row"><label>Botón inicial</label><select @change="setFocus($event.target.value)"><option value="" :selected="!screen.default_focus">(automático)</option>
        <option v-for="b in buttons" :value="b" :selected="b === screen.default_focus">{{b}}</option></select></div>
        <details class="bbui-box"><summary>Avanzado</summary>
        <div class="bbui-row"><label>Texto actionbar</label><input type="text" :value="screen.actionbar || ''" @change="setBar($event.target.value)" placeholder="Monedas: {coins}"></div>
        <div class="bbui-sec">Decorado de la ventana</div>
        <div v-if="!(screen.bones || []).length" class="bbui-dim">Sin decorado.</div>
        <div v-for="(b, i) in (screen.bones || [])" :key="b" class="bbui-row"><span style="flex:1;cursor:pointer" title="Seleccionar" @click="pick(b)">{{b}}</span><button class="bbui-x" title="Quitar de la ventana" @click="dropDecor(i)">x</button></div></details></div>
        <div v-else-if="kind === 'group'">
        <div class="bbui-head">Grupo · {{st.sel}}</div>
        <div class="bbui-dim">Este grupo no es un elemento de esta ventana.</div>
        <div class="bbui-stack"><button @click="convert('button')">Convertir en botón</button><button @click="convert('image')">Convertir en imagen</button><button @click="convert('decor')">Añadir como decorado de la ventana</button></div></div>
        <div v-else-if="kind === 'decor'">
        <div class="bbui-head">Decorado · {{st.sel}}</div>
        <div class="bbui-dim">Se muestra en esta ventana pero no se puede pulsar.</div>
        <div class="bbui-stack"><button @click="convert('button')">Convertir en botón</button><button @click="convert('image')">Convertir en imagen</button><button @click="convert('none')">Quitar de la ventana</button></div></div>
        <div v-else-if="el">
        <div class="bbui-head">{{kindLabel}} · {{st.sel}}</div>
        <div class="bbui-row"><label>Nombre</label><input type="text" :value="st.sel" @change="renameSel($event.target.value)"></div>
        <div class="bbui-row" v-if="kind !== 'button'"><label>Ventana</label><select @change="moveTo($event.target.value)"><option v-for="s in st.data.screens" :value="s.id" :selected="s.id === screen.id">{{s.id}}</option></select></div>
        <div v-if="kind === 'button'">
        <div class="bbui-box"><b>Al pulsar</b>
        <bbui-action v-if="el.action" :action="el.action" :screens="st.data.screens"></bbui-action>
        <button v-else @click="el.action = { type: 'close' }; touch()">Añadir acción</button></div>
        <div class="bbui-box"><b>Texto de ayuda</b> <span class="bbui-dim">(aparece al enfocar el botón)</span>
        <div class="bbui-row"><label>Texto</label><input type="text" :value="tipF('text', '')" @input="tipSet({ text: $event.target.value })" placeholder="(sin texto de ayuda)"></div>
        <div class="bbui-row"><label>Dónde</label><select @change="tipSet({ side: $event.target.value })"><option v-for="s in tipSides" :value="s" :selected="s === tipF('side', 'derecha')">{{tipSideLabel[s]}}</option></select></div>
        <details><summary>más opciones</summary>
        <div class="bbui-row"><label>Fuente</label><select @change="tipSet({ font: $event.target.value })"><option v-if="!fontNames.length" value="">(sin fuentes: créalas en Ajustes)</option>
        <option v-for="f in fontNames" :value="f" :selected="f === tipF('font', fontNames[0])">{{f}}</option></select></div>
        <div class="bbui-row"><label>Fondo</label><button @click="tipPickBg">Elegir fondo</button> <button v-if="tipF('bg', null)" @click="tipSet({ bg: null })">Quitar</button>
        <span class="bbui-dim">{{tipF('bg', null) ? tipF('bg', null).join(',') : 'ninguno'}}</span></div>
        <button @click="tipGenerate">Regenerar</button></details></div>
        <div class="bbui-box"><b>Resaltado al enfocar</b>
        <div v-if="hlExists" class="bbui-row"><span style="flex:1">{{el.highlight}}</span><button @click="pick(el.highlight)">Seleccionar</button></div>
        <div v-else><div class="bbui-dim">Este botón no tiene resaltado.</div><button @click="makeHl">Crear resaltado</button></div></div>
        </div>
        <div v-if="kind === 'number'" class="bbui-box"><b>Número</b>
        <div class="bbui-row"><label>Valor a mostrar</label><select @change="el.query = $event.target.value; touch()"><option v-for="q in queryNames" :value="q" :selected="q === el.query">{{q}}</option></select></div>
        <div class="bbui-row"><label>Dígitos <small class="bbui-hint">digits</small></label><input type="number" min="1" max="9" :value="el.digits" @change="el.digits = Number($event.target.value) || 1; touch()"></div>
        <div class="bbui-row"><label>Alineación</label><select @change="el.align = $event.target.value; touch()"><option v-for="a in ['left', 'right', 'center']" :value="a" :selected="a === el.align">{{alignLabel[a]}}</option></select></div></div>
        <details class="bbui-box"><summary>Avanzado</summary>
        <div v-if="kind === 'button'"><div class="bbui-sec">Navegación con las flechas</div>
        <div class="bbui-row" v-for="d in dirs"><label>{{dirLabel[d]}}</label><select @change="setNav(d, $event.target.value)">
        <option value="__auto" :selected="!hasNav(d)">automático (el más cercano)</option><option value="__none" :selected="hasNav(d) && el.nav[d] === null">ninguno</option>
        <option v-for="b in others" :value="b" :selected="hasNav(d) && el.nav[d] === b">{{b}}</option></select></div>
        <div class="bbui-row"><label>Grupo del resaltado</label><select @change="setHl($event.target.value)"><option value="" :selected="!el.highlight">(ninguno)</option>
        <option v-for="g in groupsOther" :value="g" :selected="g === el.highlight">{{g}}</option></select></div></div>
        <label class="bbui-chk"><input type="checkbox" :checked="!!el.visible_if" @change="toggleVis($event.target.checked)"> Mostrar solo si... <small class="bbui-hint">visible_if</small></label>
        <div v-if="el.visible_if"><div class="bbui-row"><label>Valor</label><select @change="el.visible_if.query = $event.target.value; touch()"><option v-for="q in queryNames" :value="q" :selected="q === el.visible_if.query">{{q}}</option></select></div>
        <div class="bbui-row"><label>Condición</label><select @change="el.visible_if.op = $event.target.value; touch()"><option v-for="o in ops" :value="o" :selected="o === el.visible_if.op">{{o}}</option></select></div>
        <div class="bbui-row"><label>Número</label><input type="number" :value="el.visible_if.value" @change="el.visible_if.value = Number($event.target.value) || 0; touch()"></div></div>
        <div class="bbui-sec">Rol</div>
        <button @click="convert('none')">Quitar de la ventana</button></details>
        </div></div>`;

    const TPL_SETTINGS = `<div class="bbui" v-if="d">
        <div class="bbui-row"><b style="flex:1">Ajustes de la UI</b><button @click="closeMe">Cerrar</button><button @click="openAnims">Animaciones…</button></div>
        <div class="bbui-row"><label>Identificador <small class="bbui-hint">id</small></label><input type="text" v-model="d.id" @change="touch()"></div>
        <div class="bbui-row"><label>Espacio de nombres <small class="bbui-hint">namespace</small></label><input type="text" v-model="d.namespace" @change="touch()"></div>
        <div class="bbui-box"><b>Cómo se ve en el juego</b>
        <div class="bbui-row"><label>Campo de visión <small class="bbui-hint">fov</small></label><input type="number" v-model.number="d.display.fov" @change="touch()"></div>
        <div class="bbui-row"><label>Distancia <small class="bbui-hint">distance</small></label><input type="number" step="0.1" v-model.number="d.display.distance" @change="touch()"></div>
        <div class="bbui-row"><label>Altura <small class="bbui-hint">height</small></label><input type="number" step="0.1" v-model.number="d.display.height" @change="touch()"></div>
        <div class="bbui-row"><label>Anclaje <small class="bbui-hint">anchor</small></label><select @change="d.display.anchor = $event.target.value; touch()"><option v-for="a in ['player', 'trigger']" :value="a" :selected="a === d.display.anchor">{{anchorLabel[a]}}</option></select></div>
        <div class="bbui-sec">Sonidos <small class="bbui-hint">sounds</small></div>
        <div class="bbui-row" v-for="k in soundKeys"><label>{{soundLabel[k]}} <small class="bbui-hint">{{k}}</small></label><input type="text" :value="sound(k)" placeholder="id del sonido" @change="setSound(k, $event.target.value)"></div></div>
        <div class="bbui-box"><b>Cómo se abre</b> <small class="bbui-hint">open</small>
        <div v-for="(o, i) in d.open" class="bbui-box"><b>{{openLabel[o.type] || o.type}}</b> <button class="bbui-x" title="Quitar" @click="delOpen(i)">x</button>
        <div class="bbui-row" v-if="o.type === 'item'"><label>Objeto</label><input type="text" v-model="o.item" @change="touch()"></div>
        <div class="bbui-row" v-if="o.type === 'block'"><label>Bloque</label><input type="text" v-model="o.block" @change="touch()"></div>
        <div class="bbui-row" v-if="o.type === 'entity'"><label>Entidad</label><input type="text" v-model="o.entity" @change="touch()"></div>
        <div v-if="o.type === 'command'"><div class="bbui-row"><label>Nombre</label><input type="text" v-model="o.name" @change="touch()"></div>
        <div class="bbui-row"><label>Permiso <small class="bbui-hint">permission</small></label><select @change="o.permission = $event.target.value; touch()"><option v-for="p in ['any', 'gamedirectors', 'admin']" :value="p" :selected="p === o.permission">{{p}}</option></select></div></div>
        <div v-if="o.type === 'item' || o.type === 'block'"><label class="bbui-chk"><input type="checkbox" :checked="!!o.generate" @change="toggleGen(o, $event.target.checked)"> Generarlo automáticamente <small class="bbui-hint">generate</small></label>
        <div v-if="o.generate"><div class="bbui-row"><label>Nombre</label><input type="text" v-model="o.generate.name" @change="touch()"></div>
        <div class="bbui-row"><label>Textura</label><input type="text" v-model="o.generate.texture" @change="touch()"></div></div></div></div>
        <select v-model="newOpen"><option v-for="t in ['item', 'block', 'entity', 'command']" :value="t">{{openLabel[t]}}</option></select> <button @click="addOpen">+ Método</button></div>
        <div class="bbui-box"><b>Valores del juego</b> <small class="bbui-hint">queries</small>
        <div v-for="k in queryNames" class="bbui-box"><b>{{k}}</b> <button class="bbui-x" title="Quitar" @click="delQuery(k)">x</button>
        <div class="bbui-row"><label>Origen <small class="bbui-hint">source</small></label><select @change="setSource(k, $event.target.value)"><option v-for="s in sources" :value="s" :selected="s === d.queries[k].source">{{s}}</option></select></div>
        <div class="bbui-row" v-if="d.queries[k].source === 'dynamic_property'"><label>Clave <small class="bbui-hint">key</small></label><input type="text" v-model="d.queries[k].key" @change="touch()"></div>
        <div class="bbui-row" v-if="d.queries[k].source === 'scoreboard'"><label>Objetivo <small class="bbui-hint">objective</small></label><input type="text" v-model="d.queries[k].objective" @change="touch()"></div>
        <div class="bbui-row" v-if="d.queries[k].source === 'script'"><label>Función <small class="bbui-hint">fn</small></label><input type="text" v-model="d.queries[k].fn" @change="touch()"></div>
        <div class="bbui-row"><label>Por defecto <small class="bbui-hint">default</small></label><input type="number" :value="d.queries[k].default" @change="setDefault(k, $event.target.value)"></div></div>
        <button @click="addQuery">+ Valor</button></div>
        <div class="bbui-box"><b>Cursor</b>
        <div class="bbui-row"><label class="bbui-chk"><input type="checkbox" :checked="cursorOn" @change="setCursorOn($event.target.checked)"> Cursor de ratón</label></div>
        <div class="bbui-row"><label>Sensibilidad</label><input type="number" min="0.1" max="5" step="0.1" :disabled="!cursorOn" :value="cursorSens" @change="setCursorSens($event.target.value)"></div>
        <div class="bbui-row"><label>Imagen del cursor</label><select :disabled="!cursorOn" @change="setCursorTex($event.target.value)"><option value="" :selected="!cursorTex">(flecha por defecto)</option>
        <option v-for="t in st.textures" :value="t" :selected="t === cursorTex">{{t}}</option></select></div>
        <div class="bbui-dim">Se exporta como cursor.png; la punta es el pixel de arriba a la izquierda.</div></div>
        <div class="bbui-box"><b>Fuentes</b>
        <div v-for="(f, k) in (d.fonts || {})" class="bbui-row"><span style="flex:1">{{k}} <span class="bbui-dim">{{Object.keys(f.glyphs).length}} glifos, glifo max {{f.size[0]}}x{{f.size[1]}} u</span></span><button class="bbui-x" title="Quitar" @click="delFont(k)">x</button></div>
        <button @click="newFont">+ Fuente (cuadrícula)</button> <button @click="newText">+ Texto</button></div>
        <div class="bbui-box"><button @click="doValidate">Validar</button> <button @click="doExport">Exportar al pack</button> <button @click="pickRoot">Carpeta...</button><div class="bbui-dim">{{root}}</div>
        <div class="bbui-row"><label>Perfil <small class="bbui-hint">regolith</small></label><input type="text" :value="st.profile" @change="setProf($event.target.value)"></div>
        <button :disabled="st.building" @click="doBuild">{{st.building ? 'Construyendo...' : 'Exportar y construir'}}</button></div></div>`;

    const TPL_ANIMS = `<div class="bbui" v-if="st.data">
        <div class="bbui-row"><b style="flex:1">Animaciones</b><button @click="closeMe">Cerrar</button></div>
        <div class="bbui-dim">Momentos que la UI puede animar. Crear añade una animación de Blockbench con el nombre y el bucle correctos; Editar abre el modo Animate.</div>
        <div v-for="r in report.rows" :key="r.role" class="bbui-row"><span style="flex:1" :class="{'bbui-dim': !r.anim}">{{friendly(r.role)}} <small class="bbui-hint">{{r.role}}</small></span>
        <span class="bbui-tag">{{r.anim ? 'existe' : 'falta'}}</span>
        <button v-if="!r.anim" @click="create(r.role)">Crear</button><button v-else @click="edit(r.role)">Editar</button></div>
        <div v-if="report.extras.length" class="bbui-box"><b>Avisos</b>
        <div v-for="x in report.extras" :key="x.name" class="bbui-warn">{{x.name}}: {{x.msg}}</div></div></div>`;

    const TPL_ARTIST = `<div class="bbui bbui-artist" v-if="st.data">
        <div class="bba-sec"><i class="material-icons">translate</i><span>Idioma</span></div>
        <div v-if="langs.length" class="bba-chips">
        <button v-for="c in langs" :key="c" class="bba-chip" :class="{on: c === editCode}" :title="'Ver y escribir en ' + langName(c)" @click="pickLang(c)">{{langName(c)}}<i v-if="multi && c === defCode" class="material-icons" title="Idioma principal: se usa cuando falta una traducción">star</i></button></div>
        <div v-if="multi" class="bba-dim">Escribes en «{{langName(editCode)}}». Lo que falte por traducir se ve en {{langName(defCode)}}.</div>
        <div v-else class="bba-dim">Añade un idioma para traducir los textos y verlos aquí mismo.</div>
        <div class="bba-line"><select class="bba-full" @change="addLang($event)"><option value="">Añadir idioma…</option><option v-for="l in addable" :key="l[0]" :value="l[0]">{{l[1]}}</option></select></div>
        <div v-if="langs.length" class="bba-line">
        <button v-if="multi" class="bba-btn bba-half" title="Todos los textos en una tabla" @click="openTr"><i class="material-icons">table_chart</i> Traducciones</button>
        <button class="bba-btn bba-half bba-danger" :title="'Quitar ' + langName(editCode) + ' del proyecto'" @click="dropLang(editCode)"><i class="material-icons">remove_circle_outline</i> Quitar</button></div>

        <div class="bba-sec"><i class="material-icons">web_stories</i><span>Ventanas</span></div>
        <div class="bbui-wlist"><div v-for="s in st.data.screens" :key="s.id" class="bbui-win" :class="{active: s.id === st.activeScreen}" title="Clic: ver y editar esta ventana" @click="activate(s.id)">
        <button class="bbui-ib bbui-star" :class="{on: s.id === st.data.start_screen}" :title="s.id === st.data.start_screen ? 'Es la ventana con la que empieza' : 'Hacer que el juego empiece por esta ventana'" @click.stop="setStart(s.id)"><i class="material-icons">{{s.id === st.data.start_screen ? 'star' : 'star_border'}}</i></button>
        <span class="bbui-wname">{{nice(s.id)}}</span>
        <button class="bbui-ib bba-hov" title="Cambiar el nombre" @click.stop="rename(s.id)"><i class="material-icons">edit</i></button>
        <button class="bbui-ib bba-hov" title="Borrar la ventana" @click.stop="remove(s.id)"><i class="material-icons">delete_outline</i></button></div></div>
        <button class="bba-add" @click="addWindow"><i class="material-icons">add</i> Nueva ventana</button>

        <div class="bba-sec"><i class="material-icons">ads_click</i><span>Seleccionado</span></div>
        <div v-if="!piece" class="bba-empty"><i class="material-icons">touch_app</i><div>Haz clic en algo de la vista para editarlo</div></div>
        <div v-else-if="isChar" class="bba-card">
        <div class="bba-title"><i class="material-icons">pets</i>{{pieceNice}}</div>
        <div class="bba-lbl">Tamaño</div>
        <div class="bba-line"><input type="number" min="0.05" step="0.1" v-model.number="scaleBy"><button @click="applyScale">Aplicar</button></div>
        <div class="bba-dim">1 = tal cual · 0.5 = la mitad · 2 = el doble</div>
        <button class="bba-btn bba-danger" @click="removeChar"><i class="material-icons">delete_outline</i> Quitar personaje</button></div>
        <div v-else class="bba-card">
        <div class="bba-title"><i class="material-icons">{{pieceIcon}}</i>{{pieceNice}}</div>
        <div v-if="isCommon" class="bba-dim">Está en todas las ventanas.</div>
        <div v-if="canMark" class="bba-seg bba-seg5">
        <button v-for="k in kindList" :key="k.k" :class="{on: pieceType === k.k}" :disabled="k.k === 'button' && isCommon" :title="'Marcar como: ' + k.t" @click="setKind(k.k)">{{k.t}}</button></div>
        <div v-else class="bba-dim">Tipo: {{pieceTypeLabel}}</div>
        <template v-if="isTextPiece">
        <template v-if="textRec">
        <div class="bba-lbl">Texto<span v-if="multi"> en {{langName(editCode)}}</span></div>
        <textarea class="bba-full bba-ta" rows="2" :placeholder="textHint" :value="textValue" @input="setTextValue($event.target.value)"></textarea>
        <div v-if="multi && !textValue.trim()" class="bba-dim bba-warn">Sin traducir: se ve en {{langName(defCode)}}.</div>
        <div v-if="textMissing.length" class="bba-dim bba-warn">La letra no tiene: {{textMissing.join(' ')}}</div>
        <button v-if="multi" class="bba-link" @click="showAllLangs = !showAllLangs"><i class="material-icons">{{showAllLangs ? 'expand_less' : 'expand_more'}}</i> ver todos los idiomas</button>
        <div v-if="multi && showAllLangs"><div v-for="x in textAll" :key="x.code" class="bba-line"><span class="bba-lc" :class="{bad: !x.value.trim()}">{{x.code.toUpperCase()}}</span><input type="text" :value="x.value" :placeholder="x.code === defCode ? '' : '(sin traducir)'" @input="setTextLang(x.code, $event.target.value)"></div></div>
        <button class="bba-link" @click="moreText = !moreText"><i class="material-icons">{{moreText ? 'expand_less' : 'expand_more'}}</i> más opciones</button>
        <template v-if="moreText">
        <div class="bba-line"><select v-if="fontNames.length > 1" title="Letra" @change="setTextOpt('font', $event.target.value)"><option v-for="f in fontNames" :value="f" :selected="f === textRec.font">{{f}}</option></select>
        <input type="number" min="0.05" step="0.05" title="Tamaño de la letra" :value="textRec.scale" @change="setTextOpt('scale', Number($event.target.value))"></div>
        <div class="bba-seg bba-seg4"><button v-for="a in aligns" :key="a.k" :class="{on: textRec.align === a.k}" :title="a.t" @click="setTextOpt('align', a.k)"><i class="material-icons">{{a.i}}</i></button></div>
        </template>
        </template>
        <div v-else class="bba-dim">Este texto está dibujado como una imagen. Para verlo en otro idioma, haz una copia y elige su idioma aquí abajo.</div>
        </template>
        <template v-if="multi && !(isTextPiece && textRec)">
        <div class="bba-lbl">Idioma de esta pieza</div>
        <select class="bba-full" @change="setPieceLang($event.target.value)"><option value="" :selected="!pieceLang">Todos</option><option v-for="c in langs" :key="c" :value="c" :selected="c === pieceLang">{{langName(c)}}</option></select>
        <div v-if="pieceLang" class="bba-dim">Solo se ve en {{langName(pieceLang)}}.</div>
        </template>
        <template v-if="isButton">
        <div class="bba-lbl">Al pulsar va a</div>
        <select class="bba-full" @change="setTarget($event.target.value)"><option v-for="o in targetOptions" :value="o.v" :selected="o.v === targetValue">{{o.t}}</option></select>
        <div class="bba-lbl">Texto al pasar el ratón<span v-if="multi"> en {{langName(editCode)}}</span></div>
        <input class="bba-full" type="text" :placeholder="tipHint" :value="tipText" @input="setTipText($event.target.value)">
        <div v-if="multi && tipHas && !tipText.trim()" class="bba-dim bba-warn">Sin traducir: se ve en {{langName(defCode)}}.</div>
        <div v-if="tipMissing.length" class="bba-dim bba-warn">La letra no tiene: {{tipMissing.join(' ')}}</div>
        <template v-if="tipHas">
        <div class="bba-line bba-tipopts">
        <div class="bba-seg bba-seg4">
        <button v-for="sd in tipSides" :key="sd.k" :class="{on: tipSide === sd.k}" :title="sd.t" @click="setTipSide(sd.k)"><i class="material-icons">{{sd.i}}</i></button></div>
        <select v-if="fontNames.length > 1" :title="'Letra'" @change="setTipFont($event.target.value)"><option v-for="f in fontNames" :value="f" :selected="f === tipFont">{{f}}</option></select></div>
        <button class="bba-link" @click="pickTipBg"><i class="material-icons">wallpaper</i> {{tipHasBg ? 'Cambiar el fondo' : 'Elegir un fondo'}}</button>
        </template>
        <div v-if="hasOldTip" class="bba-dim">Este botón ya trae un texto dibujado a mano; el que escribas se añade aparte.</div>
        </template>
        <button v-if="isCommon" class="bba-btn" @click="toWindow">Poner solo en esta ventana</button>
        <button v-else-if="!isButton && isTop" class="bba-btn" @click="toCommon">Poner en todas las ventanas</button></div>

        <div class="bba-sec"><i class="material-icons">animation</i><span>Transición al entrar</span></div>
        <select class="bba-full" @change="setTrans($event.target.value)"><option v-for="(t, k) in transitions" :value="k" :selected="k === transValue">{{t}}</option></select>
        <div class="bba-dim">Cómo aparece «{{nice(st.activeScreen)}}»</div>

        <div class="bba-sec"><i class="material-icons">add_box</i><span>Añadir</span></div>
        <div class="bba-grid">
        <button class="bba-tile" title="Una imagen de la textura (eliges la zona)" @click="addImg"><i class="material-icons">image</i><span>Imagen</span></button>
        <button class="bba-tile" title="Un texto" @click="addTxt"><i class="material-icons">text_fields</i><span>Texto</span></button>
        <button class="bba-tile" title="Un botón con su rótulo" @click="addBtn"><i class="material-icons">smart_button</i><span>Botón</span></button>
        <button class="bba-tile" title="Un personaje animado desde un archivo .bbmodel" @click="addChar"><i class="material-icons">pets</i><span>Personaje</span></button></div>

        <div class="bba-sec"><i class="material-icons">play_circle</i><span>Probar en el juego</span></div>
        <button class="bba-btn bba-primary" :disabled="st.building" title="Guarda, exporta y ejecuta regolith run (los packs van a tu Minecraft)" @click="testGame"><i class="material-icons">terminal</i> {{st.building ? 'Ejecutando...' : 'regolith run'}}</button>
        <div class="bba-dim">Guarda, exporta y lleva los packs a tu Minecraft.</div>
        <label class="bba-dev"><input type="checkbox" :checked="st.dev" @change="setDevMode($event.target.checked)"> Modo programador</label></div>`;

    // "Piezas": its own panel (the artist can move / float / resize it like any Blockbench panel)
    const TPL_PIECES = `<div class="bbui bbui-artist" v-if="st.data">
        <div class="bba-dim bba-phead">{{nice(st.activeScreen)}}</div>
        <div v-if="!pieceRows.length" class="bba-dim">Esta ventana todavía no tiene piezas.</div>
        <div v-else class="bba-plist bba-pfree">
        <div v-for="(r, i) in pieceRows" :key="r.name + '#' + i" class="bba-prow" :class="{active: r.name === activeName}" :style="{paddingLeft: (2 + r.depth * 14) + 'px'}" :title="r.name" @click="pickPiece(r.name)">
        <span class="bba-arrow" @click.stop="r.kids ? toggleRow(r) : 0"><i v-if="r.kids" class="material-icons">{{r.open ? 'expand_more' : 'chevron_right'}}</i></span>
        <i class="material-icons bba-pico" :class="'bba-t-' + r.type">{{r.icon}}</i>
        <span class="bbui-wname">{{r.label}}</span><span v-if="r.lang" class="bba-badge" :title="'Solo se ve en ' + langName(r.lang)">{{r.lang.toUpperCase()}}</span></div></div></div>`;

    // ------------------------------------------------------------------ panels
    function getRootLabel() { try { return localStorage.getItem(STORE_KEY) || '(sin carpeta de exportacion)'; } catch (e) { return ''; } }

    function makePanels() {
        // Settings / Animations only exist while their flag is on (toggled from the Ventanas toolbar / Settings panel).
        const flagCond = (key) => () => isUi() && inUiMode() && state.dev && !!state[key];
        const devCond = () => isUi() && inUiMode() && state.dev; // the programmer panels only exist in Modo programador
        const pos = { slot: 'right_bar', float_position: [0, 0], float_size: [320, 420], height: 300, folded: false };

        panels.push(new Panel('bb_ui_artist2', {
            id: 'bb_ui_artist2', name: 'UI', icon: 'dashboard_customize', growable: true, resizable: true,
            condition: () => isUi() && inUiMode(),
            default_position: { slot: 'left_bar', float_position: [0, 0], float_size: [340, 700], height: 760, folded: false },
            component: {
                data() {
                    return {
                        st: state, scaleBy: 1, transitions: TRANSITIONS, open: {}, showAllLangs: false, moreText: false,
                        aligns: [{ k: 'left', i: 'format_align_left', t: 'A la izquierda' }, { k: 'center', i: 'format_align_center', t: 'Centrado' }, { k: 'right', i: 'format_align_right', t: 'A la derecha' }],
                        kindList: [{ k: 'panel', t: 'Panel' }, { k: 'image', t: 'Imagen' }, { k: 'text', t: 'Texto' }, { k: 'button', t: 'Botón' }, { k: 'decor', t: 'Otro' }],
                        tipSides: [{ k: 'izquierda', i: 'west', t: 'A la izquierda' }, { k: 'arriba', i: 'north', t: 'Arriba' }, { k: 'abajo', i: 'south', t: 'Abajo' }, { k: 'derecha', i: 'east', t: 'A la derecha' }],
                    };
                },
                computed: {
                    screen() { return this.st.data ? core.getScreen(this.st.data, this.st.activeScreen) : null; },
                    // pieces of the active window as a tree (see buildPieceTree); recomputed on data/structure changes, not per render
                    tree() { void this.st.rev; void this.st.groups; void this.st.activeScreen; void this.st.dev; void this.st.showAll; try { return buildPieceTree(this.st.data, this.st.activeScreen); } catch (e) { console.warn('BB UI Builder: pieces', e); return { roots: [], parentOf: {}, names: new Set(), types: {}, btn: {} }; } },
                    // the row that stands for the selection: the group itself, else its nearest ancestor that is a row
                    activeName() {
                        const t = this.tree;
                        if (t.names.has(this.st.grp)) return this.st.grp;
                        for (let g = findGroup(this.st.grp); g instanceof Group; g = g.parent) if (t.names.has(g.name)) return g.name;
                        return t.names.has(this.st.piece) ? this.st.piece : '';
                    },
                    pieceRows() {
                        const out = [], open = this.open, multi = this.multi, trs = (this.st.data && this.st.data.translations) || {};
                        const rec = (list, depth) => {
                            for (const r of list) {
                                const t = PIECE_TYPES[r.type] || PIECE_TYPES.decor;
                                const isOpen = open[r.name] !== undefined ? open[r.name] : depth === 0;
                                const label = r.type === 'highlight' || r.type === 'tip' ? t.label : nice(r.type === 'character' ? r.name.replace(/^personaje_/, '') : r.name);
                                out.push({ name: r.name, type: r.type, icon: t.icon, label, depth, kids: r.kids.length, open: isOpen, lang: multi && trs[r.name] && this.langs.includes(trs[r.name]) ? trs[r.name] : '' });
                                if (r.kids.length && isOpen) rec(r.kids, depth + 1);
                            }
                        };
                        rec(this.tree.roots, 0);
                        return out;
                    },
                    // what the Seleccionado card edits: the selected row (a highlight / tooltip stands for its button), else the window piece
                    piece() {
                        void this.st.groups;
                        let n = this.activeName || this.st.piece;
                        if (n && this.tree.btn[n]) n = this.tree.btn[n];
                        return n && findGroup(n) ? n : '';
                    },
                    pieceGroup() { void this.st.rev; return this.piece ? findGroup(this.piece) : null; },
                    isTop() { const g = this.pieceGroup; return !!g && g.parent instanceof Group && isFolderGroup(g.parent); },
                    pieceType() { const t = this.tree.types[this.piece] || ''; return ['panel', 'button', 'image', 'text'].includes(t) ? t : 'decor'; },
                    canMark() { const t = this.tree.types[this.piece] || ''; return !!this.piece && !this.isChar && t !== 'number' && t !== 'model'; },
                    pieceTypeLabel() { return (PIECE_TYPES[this.tree.types[this.piece]] || PIECE_TYPES.decor).label; },
                    pieceIcon() { return (PIECE_TYPES[this.isChar ? 'character' : this.pieceType] || PIECE_TYPES.decor).icon; },
                    isCommon() { void this.st.rev; const g = this.pieceGroup; return !!g && g.parent instanceof Group && g.parent.name === COMUNES; },
                    isChar() { return /^personaje_/.test(this.piece); },
                    pieceNice() { return nice(this.piece.replace(/^personaje_/, '')); },
                    el() { const s = this.screen; return s && this.piece ? ((s.elements || []).find((e) => e.bone === this.piece && e.type === 'button') || null) : null; },
                    isButton() { return !!this.el; },
                    tipRec() { void this.st.rev; const ed = this.st.data && this.st.data.editor; return (ed && ed.tooltips && this.piece && ed.tooltips[this.piece]) || null; },
                    langs() { void this.st.rev; const l = this.st.data && this.st.data.languages; return Array.isArray(l) ? l.slice() : []; },
                    multi() { return this.langs.length > 1; },
                    defCode() { return this.langs[0] || 'es'; },
                    editCode() { return this.langs.includes(this.st.lang) ? this.st.lang : this.defCode; },
                    addable() { return core.LANGS.filter((l) => !this.langs.includes(l[0])); },
                    pieceLang() { void this.st.rev; const t = this.st.data && this.st.data.translations; return (t && this.piece && t[this.piece]) || ''; },
                    isTextPiece() { return this.pieceType === 'text'; },
                    textRec() { void this.st.rev; const ed = this.st.data && this.st.data.editor; return (ed && ed.texts && this.piece && ed.texts[this.piece]) || null; },
                    textValue() { const r = this.textRec; return r && r.text ? String(r.text[this.editCode] || '') : ''; },
                    textHint() { const r = this.textRec; return this.multi && r && r.text && this.editCode !== this.defCode && r.text[this.defCode] ? String(r.text[this.defCode]) : 'Escribe el texto'; },
                    textAll() { const r = this.textRec; return this.langs.map((c) => ({ code: c, value: r && r.text ? String(r.text[c] || '') : '' })); },
                    textMissing() { const r = this.textRec, f = r && this.st.data.fonts && this.st.data.fonts[r.font]; return f ? core.missingChars(f, this.textValue) : []; },
                    tipText() { const r = this.tipRec; if (!r) return ''; return this.multi && this.editCode !== this.defCode ? String((r.texts && r.texts[this.editCode]) || '') : String(r.text || ''); },
                    tipHas() { const r = this.tipRec; return !!r && (!!String(r.text || '').trim() || (this.multi && Object.values(r.texts || {}).some((v) => String(v || '').trim()))); },
                    tipHint() { const r = this.tipRec; return this.multi && this.editCode !== this.defCode && r && r.text ? String(r.text) : 'Por ejemplo: Siguiente página'; },
                    tipMissing() { const r = this.tipRec, f = r && this.st.data.fonts && this.st.data.fonts[r.font]; return f ? core.missingChars(f, this.tipText) : []; },
                    tipSide() { return this.tipRec ? this.tipRec.side || 'derecha' : 'derecha'; },
                    tipFont() { return this.tipRec ? this.tipRec.font || '' : ''; },
                    tipHasBg() { return !!(this.tipRec && Array.isArray(this.tipRec.bg)); },
                    fontNames() { return Object.keys((this.st.data && this.st.data.fonts) || {}); },
                    // texts drawn into the highlight by hand or by a script (e.g. the guide book's), not by this tool
                    hasOldTip() {
                        void this.st.rev;
                        const hl = this.el && this.el.highlight, g = hl ? findGroup(hl) : null;
                        if (!g) return false;
                        const own = findTipGroup(this.piece);
                        return (g.children || []).some((c) => c instanceof Group && c !== own && /tip/i.test(c.name));
                    },
                    targetValue() {
                        const a = this.el && this.el.action;
                        if (!a) return 'close';
                        if (a.type === 'goto') return 'goto:' + a.screen;
                        return a.type === 'back' || a.type === 'close' ? a.type : 'custom';
                    },
                    targetOptions() {
                        const o = this.st.data.screens.filter((s) => s.id !== this.st.activeScreen).map((s) => ({ v: 'goto:' + s.id, t: 'Ventana: ' + nice(s.id) }));
                        o.push({ v: 'back', t: 'Volver' }, { v: 'close', t: 'Cerrar' });
                        if (this.targetValue === 'custom') o.push({ v: 'custom', t: 'Acción avanzada (Modo programador)' });
                        if (/^goto:/.test(this.targetValue) && !o.some((x) => x.v === this.targetValue)) o.unshift({ v: this.targetValue, t: 'Ventana: ' + nice(this.targetValue.slice(5)) });
                        return o;
                    },
                    transValue() {
                        const id = this.st.activeScreen;
                        if (!this.st.animNames.some((n) => core.animRole(n) === 'screen.' + id)) return 'none';
                        const ed = this.st.data && this.st.data.editor, rec = ed && ed.transitions && ed.transitions[id];
                        return TRANSITIONS[rec] && rec !== 'none' ? rec : 'custom';
                    },
                },
                watch: {
                    // a selection made in the viewport opens the rows above it
                    activeName(n) { for (let p = n && this.tree.parentOf[n]; p; p = this.tree.parentOf[p]) if (this.open[p] !== true) this.$set(this.open, p, true); },
                },
                methods: {
                    nice,
                    langName: core.langName,
                    guard(fn) { try { fn(); } catch (e) { console.error(e); Blockbench.showQuickMessage(e.message, 3000); } },
                    pickLang(c) { setLang(c); },
                    addLang(ev) { const v = ev.target.value; ev.target.value = ''; if (v) this.guard(() => addLanguage(v)); },
                    dropLang(c) {
                        if (!c) return;
                        Blockbench.showMessageBox({ title: 'Quitar idioma', message: 'Quitar «' + esc(core.langName(c)) + '» del proyecto? Sus textos y las piezas solo de ese idioma se dejan de usar.', buttons: ['Quitar', 'Cancelar'], confirm: 0, cancel: 1 }, (i) => { if (i === 0) this.guard(() => removeLanguage(c)); });
                    },
                    openTr() { this.guard(translationsDialog); },
                    setPieceLang(v) { this.guard(() => setPieceLang(this.piece, v)); },
                    setTextValue(v) { this.guard(() => setTextPiece(this.piece, { text: v })); },
                    setTextLang(code, v) { this.guard(() => setTextPiece(this.piece, { text: v, lang: code })); },
                    setTextOpt(k, v) { this.guard(() => setTextPiece(this.piece, { [k]: v }, true)); },
                    activate(id) { gotoScreen(id); applyGameView(true); },
                    setStart(id) { this.st.data.start_screen = id; touch(); },
                    addWindow() {
                        Blockbench.textPrompt('Nombre de la ventana', 'Ventana ' + (this.st.data.screens.length + 1), (v) => this.guard(() => createWindow(v)));
                    },
                    rename(id) { Blockbench.textPrompt('Nuevo nombre', nice(id), (v) => this.guard(() => renameWindow(id, v))); },
                    remove(id) {
                        if (this.st.data.screens.length < 2) return Blockbench.showQuickMessage('Debe quedar al menos una ventana', 2000);
                        Blockbench.showMessageBox({ title: 'Borrar ventana', message: 'Borrar la ventana "' + esc(nice(id)) + '" con todo lo que tiene dentro?', buttons: ['Borrar', 'Cancelar'], confirm: 0, cancel: 1 }, (i) => { if (i === 0) this.guard(() => deleteWindow(id)); });
                    },
                    setKind(k) { this.guard(() => setPieceType(this.piece, k)); },
                    pickPiece(name) { const g = findGroup(name); if (g) { selectGroup(g); syncState(); } },
                    toggleRow(r) { this.$set(this.open, r.name, !r.open); },
                    setTarget(v) { this.guard(() => setPieceTarget(this.piece, v)); },
                    setTipText(v) {
                        this.guard(() => {
                            const rec = tooltipRec(this.piece);
                            // the default language lives in rec.text, the others in rec.texts[code]
                            const patch = this.multi && this.editCode !== this.defCode ? { texts: Object.assign({}, rec && rec.texts, { [this.editCode]: v }) } : { text: v };
                            // first text: pick a light font if there is one (most UI fonts are white/negative)
                            if (!rec || !rec.font) { const f = this.fontNames.find((n) => /whit|withe|blanc|ui_font/i.test(n)) || this.fontNames[0]; if (f) patch.font = f; }
                            // first text: same background as the project's other tooltips, so it reads on any page
                            if (!rec || !Array.isArray(rec.bg)) {
                                const all = Object.values(((this.st.data && this.st.data.editor) || {}).tooltips || {});
                                const withBg = all.find((t) => t !== rec && Array.isArray(t.bg));
                                if (withBg) { patch.bg = withBg.bg.slice(); if (withBg.side && (!rec || !rec.text)) patch.side = withBg.side; }
                            }
                            setTooltip(this.piece, patch);
                        });
                    },
                    setTipSide(k) { this.guard(() => setTooltip(this.piece, { side: k }, true)); },
                    setTipFont(f) { this.guard(() => setTooltip(this.piece, { font: f }, true)); },
                    pickTipBg() { this.guard(() => pickTooltipBg(this.piece)); },
                    toCommon() { this.guard(() => movePiece(this.piece, true)); },
                    toWindow() { this.guard(() => movePiece(this.piece, false)); },
                    applyScale() { this.guard(() => { scaleCharacter(this.piece, Number(this.scaleBy)); this.scaleBy = 1; }); },
                    removeChar() {
                        const name = this.piece;
                        Blockbench.showMessageBox({ title: 'Quitar personaje', message: 'Quitar a "' + esc(this.pieceNice) + '" y sus animaciones?', buttons: ['Quitar', 'Cancelar'], confirm: 0, cancel: 1 }, (i) => { if (i === 0) this.guard(() => removeCharacter(name)); });
                    },
                    setTrans(k) {
                        const el = this.$el, top = el ? el.scrollTop : 0;
                        const back = () => { try { if (el) el.scrollTop = top; } catch (e) {} };
                        this.guard(() => setTransition(k));
                        back(); this.$nextTick(back); setTimeout(back, 120); setTimeout(back, 500);
                    },
                    addImg() { this.guard(() => imageDialog({ artist: true })); },
                    addTxt() { this.guard(() => textDialog({ artist: true })); },
                    addBtn() { this.guard(() => addElement('button', { artist: true })); },
                    addChar() { this.guard(addCharacter); },
                    togglePreview() { if (this.st.preview.on) previewStop(); else previewStart(); },
                    testGame() { testInGame().catch((e) => { console.error(e); showOutput('regolith run', false, e.message); }); },
                    mv(d) { previewMove(d); },
                    ok() { previewAccept(); },
                    setDevMode(on) { setDev(on); },
                },
                template: '<div class="bbui-root">' + TPL_ARTIST + '</div>',
            },
        }));

        panels.push(new Panel('bb_ui_pieces', {
            id: 'bb_ui_pieces', name: 'Piezas', icon: 'account_tree', growable: true, resizable: true,
            condition: () => isUi() && inUiMode(),
            default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [300, 500], height: 500, folded: false },
            component: {
                data() { return { st: state, open: {} }; },
                computed: {
                    tree() { void this.st.rev; void this.st.groups; void this.st.activeScreen; void this.st.dev; void this.st.showAll; try { return buildPieceTree(this.st.data, this.st.activeScreen); } catch (e) { console.warn('BB UI Builder: pieces', e); return { roots: [], parentOf: {}, names: new Set(), types: {}, btn: {} }; } },
                    activeName() {
                        const t = this.tree;
                        if (t.names.has(this.st.grp)) return this.st.grp;
                        for (let g = findGroup(this.st.grp); g instanceof Group; g = g.parent) if (t.names.has(g.name)) return g.name;
                        return t.names.has(this.st.piece) ? this.st.piece : '';
                    },
                    langs() { void this.st.rev; const l = this.st.data && this.st.data.languages; return Array.isArray(l) ? l.slice() : []; },
                    multi() { return this.langs.length > 1; },
                    pieceRows() {
                        const out = [], open = this.open, multi = this.multi, trs = (this.st.data && this.st.data.translations) || {};
                        const rec = (list, depth) => {
                            for (const r of list) {
                                const t = PIECE_TYPES[r.type] || PIECE_TYPES.decor;
                                const isOpen = open[r.name] !== undefined ? open[r.name] : depth === 0;
                                const label = r.type === 'highlight' || r.type === 'tip' ? t.label : nice(r.type === 'character' ? r.name.replace(/^personaje_/, '') : r.name);
                                out.push({ name: r.name, type: r.type, icon: t.icon, label, depth, kids: r.kids.length, open: isOpen, lang: multi && trs[r.name] && this.langs.includes(trs[r.name]) ? trs[r.name] : '' });
                                if (r.kids.length && isOpen) rec(r.kids, depth + 1);
                            }
                        };
                        rec(this.tree.roots, 0);
                        return out;
                    },
                },
                watch: {
                    // selecting in the viewport opens the rows above the selection
                    activeName(n) { for (let p = n && this.tree.parentOf[n]; p; p = this.tree.parentOf[p]) if (this.open[p] !== true) this.$set(this.open, p, true); },
                },
                methods: {
                    nice, langName: core.langName,
                    pickPiece(name) { const g = findGroup(name); if (g) { selectGroup(g); syncState(); } },
                    toggleRow(r) { this.$set(this.open, r.name, !r.open); },
                },
                template: '<div class="bbui-root">' + TPL_PIECES + '</div>',
            },
        }));

        panels.push(new Panel('bb_ui_screens', {
            id: 'bb_ui_screens', name: 'Ventanas (programador)', icon: 'layers', growable: true, resizable: true, condition: devCond,
            default_position: { slot: 'left_bar', float_position: [0, 0], float_size: [300, 420], height: 380, folded: false },
            component: {
                data() { return { st: state }; },
                methods: {
                    btnCount(s) { return core.buttons(s).length; },
                    activate(id) { gotoScreen(id); },
                    refresh() { applyVisibility(); },
                    applySafe() { setSafe(this.st.safe); },
                    setStart(id) { this.st.data.start_screen = id; touch(); },
                    guard(fn) { try { fn(); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    addBtn() { this.guard(() => addElement('button')); },
                    addTxt() { this.guard(textDialog); },
                    addImg() { this.guard(imageDialog); },
                    togglePreview() { if (this.st.preview.on) previewStop(); else previewStart(); },
                    exportIt() { if (hasExportRoot()) exportAndBuildAction(); else exportAction(); },
                    openSettings() { setPanelFlag('showSettings', !this.st.showSettings); },
                    gameView() { applyGameView(true); },
                    add() {
                        Blockbench.textPrompt('Nombre de la ventana', 'ventana_' + (this.st.data.screens.length + 1), (v) => {
                            v = core.sanitizeId(v);
                            if (core.getScreen(this.st.data, v)) return Blockbench.showQuickMessage('Ya existe', 1500);
                            this.st.data.screens.push({ id: v, bones: [], elements: [] });
                            touch(); gotoScreen(v);
                        });
                    },
                    rename(id) {
                        Blockbench.textPrompt('Nuevo nombre', id, (v) => {
                            v = core.sanitizeId(v);
                            if (v === id) return;
                            if (core.getScreen(this.st.data, v)) return Blockbench.showQuickMessage('Ya existe', 1500);
                            core.renameScreen(this.st.data, id, v);
                            if (this.st.activeScreen === id) this.st.activeScreen = v;
                            touch();
                        });
                    },
                    remove(id) {
                        const d = this.st.data;
                        if (d.screens.length < 2) return Blockbench.showQuickMessage('Debe quedar una ventana', 1500);
                        Blockbench.showMessageBox({ title: 'Eliminar ventana', message: 'Eliminar la ventana "' + esc(id) + '"? Sus elementos siguen en el modelo, pero dejan de ser parte de la UI.', buttons: ['Eliminar', 'Cancelar'], confirm: 0, cancel: 1 }, (i) => {
                            if (i !== 0) return;
                            const k = d.screens.findIndex((s) => s.id === id);
                            if (k < 0) return;
                            d.screens.splice(k, 1);
                            if (d.start_screen === id) d.start_screen = d.screens[0].id;
                            if (this.st.activeScreen === id) this.st.activeScreen = d.start_screen;
                            touch(); applyVisibility(); applyRoleColors();
                        });
                    },
                    mv(d) { previewMove(d); },
                    ok() { previewAccept(); },
                },
                template: '<div class="bbui-root">' + TPL_SCREENS + '</div>', // fixed root: Blockbench 5 panels need an element even with no data
            },
        }));

        panels.push(new Panel('bb_ui_element', {
            id: 'bb_ui_element', name: 'Inspector', icon: 'smart_button', growable: true, resizable: true, condition: devCond, default_position: pos,
            component: {
                components: { 'bbui-action': actionComp },
                data() {
                    return { st: state, dirs: DIRS, ops: OPS, tipSides: TIP_SIDES, tipSideLabel: TIP_SIDE_LABEL, dirLabel: DIR_LABEL, alignLabel: { left: 'Izquierda', right: 'Derecha', center: 'Centro' } };
                },
                computed: {
                    screen() { return this.st.data ? core.getScreen(this.st.data, this.st.activeScreen) : null; },
                    buttons() { return this.screen ? core.buttons(this.screen).map((e) => e.bone) : []; },
                    info() {
                        const s = this.screen, sel = this.st.sel;
                        if (!s || !sel) return null;
                        const el = (s.elements || []).find((e) => e.bone === sel);
                        if (el) return { screen: s, element: el, decor: false };
                        return (s.bones || []).includes(sel) ? { screen: s, element: null, decor: true } : null;
                    },
                    kind() { if (!this.st.sel) return 'screen'; if (!this.info) return 'group'; return this.info.decor ? 'decor' : this.info.element.type; },
                    kindLabel() { return KIND_LABEL[this.kind] || this.kind; },
                    el() { return this.info && this.info.element; },
                    queryNames() { return this.st.data ? Object.keys(this.st.data.queries) : []; },
                    others() { return this.screen ? this.buttons.filter((b) => b !== this.st.sel) : []; },
                    groupsOther() { return this.st.groups.filter((g) => g !== this.st.sel); },
                    fontNames() { return this.st.data && this.st.data.fonts ? Object.keys(this.st.data.fonts) : []; },
                    hlExists() { return !!this.el && !!this.el.highlight && this.st.groups.includes(this.el.highlight); },
                },
                methods: {
                    touch,
                    guard(fn) { try { fn(); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    pick(name) { const g = (Group.all || []).find((x) => x.name === name); if (g) { selectGroup(g); syncState(); } },
                    renameSel(v) {
                        v = String(v || '').trim().replace(/[^A-Za-z0-9_]+/g, '_');
                        const old = this.st.sel;
                        if (!v || v === old) return;
                        if (boneNames().includes(v)) return Blockbench.showQuickMessage('Ya existe un grupo con ese nombre', 2000);
                        const g = (Group.all || []).find((x) => x.name === old);
                        if (!g) return;
                        Undo.initEdit({ groups: [g] });
                        g.name = v;
                        Undo.finishEdit('Rename UI element', { groups: [g] });
                        trackRenames(); touch(); syncState();
                    },
                    renameScreenTo(v) {
                        v = core.sanitizeId(v);
                        const id = this.screen.id;
                        if (v === id) return;
                        if (core.getScreen(this.st.data, v)) return Blockbench.showQuickMessage('Ya existe una ventana con ese nombre', 2000);
                        core.renameScreen(this.st.data, id, v);
                        this.st.activeScreen = v;
                        touch();
                    },
                    setFocus(v) { if (v) core.set(this.screen, 'default_focus', v); else core.del(this.screen, 'default_focus'); touch(); },
                    setBar(v) { if (v) core.set(this.screen, 'actionbar', v); else core.del(this.screen, 'actionbar'); touch(); },
                    dropDecor(i) { this.screen.bones.splice(i, 1); touch(); applyRoleColors(); },
                    convert(role) {
                        core.assignBone(this.st.data, this.st.activeScreen, this.st.sel, role, this.queryNames);
                        touch(); applyRoleColors(); syncState();
                    },
                    moveTo(id) {
                        const type = this.el.type, old = clone(this.el);
                        core.assignBone(this.st.data, id, this.st.sel, type, this.queryNames);
                        const ne = core.findBone(this.st.data, this.st.sel).element;
                        for (const k of Object.keys(old)) core.set(ne, k, old[k]);
                        touch(); applyRoleColors(); gotoScreen(id);
                    },
                    makeHl() { this.guard(() => createHighlight(this.st.sel)); },
                    tipF(k, def) {
                        const ed = this.st.data && this.st.data.editor;
                        const r = ed && ed.tooltips && ed.tooltips[this.st.sel];
                        return r && r[k] !== undefined && r[k] !== '' ? r[k] : def;
                    },
                    tipSet(patch) {
                        try {
                            if (patch.font === undefined && !this.tipF('font', '') && this.fontNames.length) patch = Object.assign({ font: this.fontNames[0] }, patch);
                            setTooltip(this.st.sel, patch);
                        } catch (e) { Blockbench.showQuickMessage(e.message, 2500); }
                    },
                    tipPickBg() { this.guard(() => pickTooltipBg(this.st.sel)); },
                    tipGenerate() { this.guard(() => setTooltip(this.st.sel, {}, true)); },
                    hasNav(d) { return !!(this.el.nav && Object.prototype.hasOwnProperty.call(this.el.nav, d)); },
                    setNav(d, v) {
                        if (v === '__auto') { if (this.el.nav) core.del(this.el.nav, d); if (this.el.nav && !Object.keys(this.el.nav).length) core.del(this.el, 'nav'); }
                        else { if (!this.el.nav) core.set(this.el, 'nav', {}); core.set(this.el.nav, d, v === '__none' ? null : v); }
                        touch();
                    },
                    setHl(v) { if (v) core.set(this.el, 'highlight', v); else core.del(this.el, 'highlight'); touch(); applyRoleColors(); },
                    toggleVis(on) {
                        if (on) core.set(this.el, 'visible_if', { query: this.queryNames[0] || '', op: '>=', value: 1 });
                        else core.del(this.el, 'visible_if');
                        touch();
                    },
                },
                template: '<div class="bbui-root">' + TPL_ELEMENT + '</div>', // fixed root: Blockbench 5 panels need an element even with no data
            },
        }));

        panels.push(new Panel('bb_ui_settings', {
            id: 'bb_ui_settings', name: 'Ajustes de la UI', icon: 'settings', growable: true, resizable: true, condition: flagCond('showSettings'), default_position: pos,
            component: {
                data() {
                    return {
                        st: state, newOpen: 'item', sources: ['dynamic_property', 'scoreboard', 'script'], soundKeys: ['move', 'accept', 'open', 'close'], root: getRootLabel(),
                        anchorLabel: { player: 'Junto al jugador', trigger: 'Donde se activa' },
                        soundLabel: { move: 'Al mover', accept: 'Al aceptar', open: 'Al abrir', close: 'Al cerrar' },
                        openLabel: { item: 'Objeto', block: 'Bloque', entity: 'Entidad', command: 'Comando' },
                    };
                },
                computed: {
                    d() { return this.st.data; },
                    queryNames() { return this.st.data ? Object.keys(this.st.data.queries) : []; },
                    cursorOn() { return !!this.d && this.d.display.cursor !== false; },
                    cursorSens() { const c = this.d && this.d.display.cursor; return c && c.sensitivity > 0 ? c.sensitivity : 1; },
                    cursorTex() { return (this.d && this.d.editor && this.d.editor.cursorTexture) || ''; },
                },
                methods: {
                    touch,
                    setCursorOn(on) {
                        if (on) core.del(this.d.display, 'cursor'); else core.set(this.d.display, 'cursor', false);
                        touch();
                    },
                    setCursorSens(v) {
                        const n = Number(v);
                        if (!(n > 0) || n === 1) core.del(this.d.display, 'cursor'); else core.set(this.d.display, 'cursor', { sensitivity: n });
                        touch();
                    },
                    setCursorTex(name) {
                        const ed = editorData();
                        if (name) core.set(ed, 'cursorTexture', name); else core.del(ed, 'cursorTexture');
                        touch();
                    },
                    sound(k) { return (this.d.display.sounds && this.d.display.sounds[k]) || ''; },
                    setSound(k, v) {
                        const disp = this.d.display;
                        if (!disp.sounds) core.set(disp, 'sounds', {});
                        if (v) core.set(disp.sounds, k, v); else core.del(disp.sounds, k);
                        if (!Object.keys(disp.sounds).length) core.del(disp, 'sounds');
                        touch();
                    },
                    addOpen() {
                        const t = this.newOpen;
                        const o = { type: t };
                        if (t === 'item') o.item = this.d.namespace + ':ui_' + this.d.id;
                        if (t === 'block') o.block = this.d.namespace + ':ui_' + this.d.id;
                        if (t === 'entity') o.entity = 'minecraft:villager_v2';
                        if (t === 'command') { o.name = this.d.namespace + ':' + this.d.id + '_ui'; o.permission = 'any'; }
                        this.d.open.push(o); touch();
                    },
                    delOpen(i) { this.d.open.splice(i, 1); touch(); },
                    toggleGen(o, on) { if (on) core.set(o, 'generate', { name: 'UI ' + this.d.id, texture: 'textures/items/book_normal' }); else core.del(o, 'generate'); touch(); },
                    addQuery() {
                        Blockbench.textPrompt('Nombre de la query', 'coins', (v) => {
                            v = core.sanitizeId(v);
                            if (this.d.queries[v]) return;
                            core.set(this.d.queries, v, { source: 'dynamic_property', key: this.d.namespace + ':' + v, default: 0 });
                            touch();
                        });
                    },
                    delQuery(k) { core.del(this.d.queries, k); touch(); },
                    setSource(k, s) {
                        const q = this.d.queries[k], def = q.default;
                        for (const f of ['key', 'objective', 'fn']) core.del(q, f);
                        core.set(q, 'source', s);
                        if (s === 'dynamic_property') core.set(q, 'key', this.d.namespace + ':' + k);
                        if (s === 'scoreboard') core.set(q, 'objective', k);
                        if (s === 'script') core.set(q, 'fn', '');
                        if (def !== undefined && s !== 'script') core.set(q, 'default', def);
                        touch();
                    },
                    setDefault(k, v) { if (v === '') core.del(this.d.queries[k], 'default'); else core.set(this.d.queries[k], 'default', Number(v) || 0); touch(); },
                    delFont(k) { removeFont(k); },
                    newFont() { try { fontDialog(); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    newText() { try { textDialog(); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    closeMe() { setPanelFlag('showSettings', false); },
                    openAnims() { setPanelFlag('showAnims', true); },
                    setProf(v) { setProfile(v); },
                    doBuild() { exportAndBuildAction(); },
                    doValidate() { showValidation(validate()); },
                    doExport() { exportAction(); this.root = getRootLabel(); },
                    pickRoot() { getExportRoot(true); this.root = getRootLabel(); },
                },
                template: '<div class="bbui-root">' + TPL_SETTINGS + '</div>', // fixed root: Blockbench 5 panels need an element even with no data
            },
        }));

        panels.push(new Panel('bb_ui_animations', {
            id: 'bb_ui_animations', name: 'Animaciones de la UI', icon: 'movie', growable: true, resizable: true, condition: flagCond('showAnims'), default_position: pos,
            component: {
                data() { return { st: state }; },
                computed: {
                    report() { return this.st.data ? animationReport() : { rows: [], extras: [] }; },
                },
                methods: {
                    closeMe() { setPanelFlag('showAnims', false); },
                    friendly(r) {
                        const fixed = { idle: 'En reposo', open: 'Al abrir', close: 'Al cerrar' };
                        if (fixed[r]) return fixed[r];
                        const m = /^(screen|focus|press)\.(.+)$/.exec(r);
                        return m ? { screen: 'Ventana ', focus: 'Al enfocar ', press: 'Al pulsar ' }[m[1]] + m[2] : r;
                    },
                    create(role) { try { createUiAnimation(role); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    edit(role) { try { editUiAnimation(role); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                },
                template: '<div class="bbui-root">' + TPL_ANIMS + '</div>',
            },
        }));
    }

    const CSS = '.bba-sec{display:flex;align-items:center;gap:6px;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--color-border);font-size:11px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:var(--color-subtle_text)}.bba-sec:first-child{margin-top:4px}.bba-sec i{font-size:16px}.bba-add{width:100%;margin:6px 0 2px;padding:6px;border:1px dashed var(--color-border);background:transparent;border-radius:6px;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:var(--color-subtle_text)}.bba-add:hover{border-color:var(--color-accent);color:var(--color-text)}.bba-add i{font-size:16px}.bbui-win .bba-hov{opacity:0}.bbui-win:hover .bba-hov,.bbui-win.active .bba-hov{opacity:.75}.bbui-star.on i{color:#f5c542}.bba-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 8px;border:1px dashed var(--color-border);border-radius:6px;color:var(--color-subtle_text);text-align:center;font-size:12px}.bba-empty i{font-size:22px;opacity:.7}.bba-card{border:1px solid var(--color-border);border-radius:6px;padding:10px;background:var(--color-back)}.bba-title{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:bold;margin-bottom:8px}.bba-title i{font-size:18px;opacity:.8}.bba-lbl{font-size:12px;color:var(--color-subtle_text);margin:10px 0 3px}.bba-full{width:100%;box-sizing:border-box;height:30px}.bba-dim{font-size:11px;color:var(--color-subtle_text);margin-top:4px}.bba-seg{display:flex;border:1px solid var(--color-border);border-radius:6px;overflow:hidden}.bba-seg button{flex:1;padding:6px 4px;border:none;border-radius:0;background:transparent;cursor:pointer;min-width:0}.bba-seg button+button{border-left:1px solid var(--color-border)}.bba-seg button.on{background:var(--color-accent);color:var(--color-accent_text,#fff)}.bba-seg4{flex:0 0 auto}.bba-seg4 button{padding:4px 6px}.bba-seg4 i{font-size:16px}.bba-line{display:flex;gap:6px;align-items:center;margin-top:6px}.bba-line input{flex:1;min-width:0}.bba-tipopts select{flex:1;min-width:0;height:28px}.bba-link{margin-top:6px;padding:2px 0;border:none;background:transparent;cursor:pointer;color:var(--color-subtle_text);display:flex;align-items:center;gap:4px;font-size:12px}.bba-link:hover{color:var(--color-text)}.bba-link i{font-size:15px}.bba-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.bba-tile{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;min-width:0;font-size:13px}.bba-tile i{font-size:20px;opacity:.85}.bba-btn{width:100%;margin-top:6px;padding:7px;border-radius:6px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font-size:13px}.bba-btn i{font-size:18px}.bba-btn.on{background:var(--color-selected)}.bba-primary{background:var(--color-accent);color:var(--color-accent_text,#fff);font-weight:bold;padding:9px}.bba-primary:hover{filter:brightness(1.1)}.bba-primary:disabled{opacity:.6}.bba-danger:hover{color:#ff6b6b}.bba-seg5 button{font-size:11px;padding:6px 2px}.bba-seg button:disabled{opacity:.4;cursor:default}.bba-plist{max-height:260px;overflow-y:auto;border:1px solid var(--color-border);border-radius:6px;padding:2px 0;background:var(--color-back)}.bba-pfree{max-height:none;border:none;background:transparent}.bba-phead{margin:0 0 6px}.bba-prow{display:flex;align-items:center;gap:4px;padding:3px 6px 3px 2px;cursor:pointer;font-size:13px}.bba-prow:hover{background:var(--color-button)}.bba-prow.active{background:var(--color-selected)}.bba-arrow{flex:0 0 18px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;opacity:.8}.bba-arrow i{font-size:18px}.bba-pico{font-size:17px;opacity:.9;flex:0 0 auto}.bba-t-highlight,.bba-t-tip{opacity:.6}.bba-dev{display:flex;align-items:center;gap:6px;margin:18px 0 4px;padding-top:8px;border-top:1px solid var(--color-border);font-size:12px;color:var(--color-subtle_text)}' +
        '.bba-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}.bba-chip{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border:1px solid var(--color-border);border-radius:12px;background:transparent;cursor:pointer;font-size:12px}.bba-chip.on{background:var(--color-accent);color:var(--color-accent_text,#fff);border-color:transparent}.bba-chip i{font-size:12px;opacity:.8}.bba-half{flex:1;width:auto;margin-top:0;min-width:0}.bba-badge{margin-left:auto;padding:0 5px;border-radius:8px;background:var(--color-accent);color:var(--color-accent_text,#fff);font-size:10px;font-weight:bold}.bba-ta{height:auto;resize:vertical;font-family:inherit}.bba-warn{color:#e8a33d}.bba-lc{flex:0 0 26px;font-size:10px;font-weight:bold;opacity:.8}.bba-lc.bad{color:#e8a33d}' +
        '.bbui-trscroll{max-height:60vh;overflow:auto;border:1px solid var(--color-border);border-radius:6px;margin-top:8px}.bbui-trtab{border-collapse:collapse;width:100%}.bbui-trtab th{position:sticky;top:0;background:var(--color-back);text-align:left;padding:6px;font-size:12px;z-index:1}.bbui-trtab td{padding:4px 6px;vertical-align:top;border-top:1px solid var(--color-border)}.bbui-trname{min-width:120px;font-size:12px}.bbui-trname small{display:block;opacity:.6}.bbui-trtab textarea{width:100%;min-width:140px;box-sizing:border-box;resize:vertical}.bbui-trtab textarea.bbui-trempty{background:rgba(232,163,61,.18);outline:1px solid #e8a33d}.bbui-trwarn{font-size:10px;color:#e8a33d;margin-top:2px}' +
        '.bbui-root{overflow-y:auto;overflow-x:hidden;max-height:calc(100vh - 130px);box-sizing:border-box}.bbui{padding:6px;font-size:12px}.bbui-artist{font-size:13px}.bbui-big{font-size:15px;font-weight:bold;margin:12px 0 4px}.bbui-btn{width:100%;padding:7px;font-size:13px;margin:4px 0}.bbui-wide{width:100%;padding:6px;font-size:13px}.bbui-win{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:4px;cursor:pointer;font-size:14px}.bbui-win:hover{background:var(--color-button)}.bbui-win.active{background:var(--color-selected)}.bbui-win .bbui-star{font-size:18px}.bbui-card{border:1px solid var(--color-border);border-radius:5px;padding:8px;margin:4px 0}.bbui-ib{flex:0 0 auto;width:24px;height:24px;min-width:0;padding:0;display:inline-flex;align-items:center;justify-content:center}.bbui-ib i{font-size:16px}.bbui-win .bbui-star i{font-size:18px}.bbui-wlist{max-height:240px;overflow-y:auto}.bbui-wname{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bbui-hint2{font-size:11px;margin:2px 0}.bbui-dev{margin-top:14px;opacity:.8}.bbui-tool.bbui-wide2{width:124px}.bbui-tool:disabled{opacity:.5}.bbui-row{display:flex;gap:6px;align-items:center;margin:2px 0}.bbui-row label{flex:0 0 100px;opacity:.8}' +
        '.bbui-row input,.bbui-row select,.bbui-action>select{flex:1;min-width:0}.bbui-box{border:1px solid var(--color-border);border-radius:4px;padding:5px;margin:6px 0}' +
        '.bbui-screen{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:3px}.bbui-screen.active{background:var(--color-selected)}.bbui-name{flex:1;cursor:pointer}' +
        '.bbui-tag{font-size:10px;opacity:.7}.bbui-dim{opacity:.6}.bbui-warn{color:#e8a33d;margin:2px 0}.bbui-chk{display:inline-flex;gap:4px;align-items:center}.bbui-x{padding:0 6px}' +
        '.bbui-seq{margin-left:10px}.bbui-seqitem{display:flex;gap:4px;align-items:flex-start;border-left:2px solid var(--color-border);padding-left:4px;margin:3px 0}' +
        '.bbui-tools{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}.bbui-tool{display:flex;flex-direction:column;align-items:center;width:58px;padding:4px 2px;line-height:1.1}.bbui-tool i{font-size:26px}.bbui-tool span{font-size:10px;text-align:center}.bbui-tool.on{background:var(--color-selected)}' +
        '.bbui-sec{font-weight:bold;opacity:.8;margin:8px 0 3px}.bbui-head{font-size:14px;font-weight:bold;margin-bottom:4px}.bbui-hint{opacity:.5;font-size:9px;margin-left:3px}.bbui-star{font-size:15px}.bbui-star.on{color:#ffd23c}' +
        '.bbui-stack{display:flex;flex-direction:column;gap:4px;margin-top:6px}.bbui-chks{display:flex;flex-direction:column;gap:3px;margin:6px 0}.bbui details>summary{cursor:pointer;opacity:.8}.bbui-screen{cursor:pointer}' +
        '.bbui-pkwrap{max-height:400px;overflow:auto;border:1px solid var(--color-border);margin:4px 0}.bbui-pkwrap canvas{display:block;image-rendering:pixelated;cursor:crosshair}.bbui-pad{margin-top:6px;text-align:center}.bbui-pad button{min-width:34px;margin:1px}';

    // ------------------------------------------------------------------ actions
    function makeActions() {
        // dev = only listed in Modo programador
        const mk = (id, name, icon, fn, dev) => {
            const a = new Action('bb_ui_' + id, {
                name, icon, condition: () => isUi() && (!dev || state.dev),
                click() { try { fn(); } catch (e) { console.error(e); Blockbench.showMessageBox({ title: 'BB UI', message: esc(e.message), icon: 'error' }); } },
            });
            actions.push(a);
            return a;
        };
        const list = [
            mk('add_image', 'Añadir imagen', 'image', () => imageDialog({ artist: !state.dev })),
            mk('add_text', 'Añadir texto', 'text_fields', () => textDialog({ artist: !state.dev })),
            mk('add_character', 'Añadir personaje (.bbmodel)', 'pets', addCharacter),
            mk('add_button', 'Añadir botón', 'smart_button', () => addElement('button')),
            mk('template', 'Nueva UI desde plantilla', 'auto_awesome', templateDialog),
            mk('preview', 'Vista previa de los botones', 'gamepad', () => { syncState(); if (state.preview.on) previewStop(); else previewStart(); }, true),
            mk('test_game', 'regolith run', 'terminal', () => testInGame().catch((e) => showOutput('regolith run', false, e.message))),
            mk('game_view', 'Vista de juego', 'videocam', () => applyGameView(true)),
            mk('validate', 'Revisar la UI', 'rule', () => showValidation(validate())),
            mk('export', 'Exportar al pack', 'upload', exportAction, true),
            mk('export_build', 'Exportar y construir', 'build', exportAndBuildAction, true),
            mk('add_font', 'Crear fuente de texto', 'font_download', fontDialog, true),
            mk('add_plain_image', 'Añadir hueco de imagen', 'crop_original', () => addElement('image'), true),
            mk('add_number', 'Añadir número', 'pin', () => addElement('number'), true),
            mk('add_model', 'Añadir hueco de modelo', 'view_in_ar', () => addElement('model'), true),
            mk('build_profile', 'Perfil de construcción', 'tune', () => Blockbench.textPrompt('Perfil de regolith (regolith run <perfil>)', state.profile, (v) => setProfile(v)), true),
            mk('safe_zone', 'Marco de pantalla (mostrar/ocultar)', 'crop_free', () => setSafe(!state.safe), true),
            mk('role_colors', 'Refrescar colores del outliner', 'palette', applyRoleColors, true),
            mk('export_root', 'Carpeta de exportación', 'folder_open', () => getExportRoot(true), true),
        ];
        try {
            // BarMenu registers itself in the menu bar.
            menus.push(new BarMenu('bb_ui_menu', list.map((a) => a.id), { name: 'UI', condition: () => isUi() }));
        } catch (e) {
            console.warn('BB UI Builder: menu', e);
            for (const a of list) { try { MenuBar.addAction(a, 'tools'); } catch (e2) {} }
        }
        try { const tb = Toolbars.outliner; if (tb) { for (const a of list.slice(0, 4)) tb.add(a); tb.update(); } } catch (e) {}
        makePieceTypeMenu();
    }

    // Group context menu (outliner, any mode): "Tipo de pieza UI" > Panel / Botón / Imagen / Texto / Sin tipo.
    // Personaje is not offered: characters come from the "Personaje" import (wrapper `personaje_*` + animations), so they are only shown (checked, read-only).
    let pieceMenuAction = null;
    function makePieceTypeMenu() {
        const ctxGroup = (ctx) => (ctx instanceof Group ? ctx : (typeof Group !== 'undefined' ? Group.first_selected : null)) || null;
        const targets = (g) => {
            let list = [];
            try { const m = Group.multi_selected; if (Array.isArray(m) && m.includes(g)) list = m.slice(); } catch (e) {}
            return list.length ? list : [g];
        };
        const apply = (g, kind) => {
            const errs = [];
            for (const t of targets(g)) { try { setPieceType(t.name, kind); } catch (e) { errs.push(e.message); } }
            if (errs.length) Blockbench.showQuickMessage(errs[0], 3000);
        };
        const items = [['panel', 'Panel'], ['button', 'Botón'], ['image', 'Imagen'], ['text', 'Texto'], ['decor', 'Sin tipo']];
        pieceMenuAction = new Action('bb_ui_piece_type', {
            name: 'Tipo de pieza UI', icon: 'category',
            condition: (ctx) => { try { const g = ctxGroup(ctx); return isUi() && !!g && !isFolderGroup(g); } catch (e) { return false; } },
            children: (ctx) => {
                const g = ctxGroup(ctx);
                if (!g) return [];
                if (/^personaje_/.test(g.name)) return [{ name: 'Personaje (se añade con «Personaje»)', icon: 'pets', marked: true, click() {} }];
                const cur = markedKind(g.name);
                return items.map(([k, label]) => ({ id: k, name: label, icon: (PIECE_TYPES[k] || PIECE_TYPES.decor).icon, marked: cur === k, click() { apply(g, k); } }));
            },
        });
        actions.push(pieceMenuAction);
        try { Group.prototype.menu.addAction(pieceMenuAction); }
        catch (e) { try { Group.prototype.menu.structure.push(pieceMenuAction); } catch (e2) { console.warn('BB UI Builder: group menu', e2); } }
    }
    function removePieceTypeMenu() {
        const a = pieceMenuAction; pieceMenuAction = null;
        if (!a) return;
        try { Group.prototype.menu.removeAction(a.id); }
        catch (e) { try { const st = Group.prototype.menu.structure, i = st.indexOf(a); if (i >= 0) st.splice(i, 1); } catch (e2) {} }
    }

    // ------------------------------------------------------------------ mode
    // Fourth editor tab ("UI"), next to Edit / Paint / Animate: only the UI panels live here (no outliner / textures panels; pieces are picked from the "Piezas" list).
    function registerMode() {
        if (typeof Mode === 'undefined') return;
        modeObj = new Mode(MODE_ID, {
            name: 'UI',
            icon: 'dashboard_customize',
            default_tool: 'move_tool',
            category: 'navigate',
            condition: () => isUi(),
            onSelect() { try { state.rev++; syncState(); applyVisibility(); safeZone(); applyGameView(true); refreshPanels(); } catch (e) { console.warn('BB UI Builder: mode', e); } },
            onUnselect() { try { if (state.preview.on) previewStop(); restoreView(); } catch (e) {} },
        });
        for (const id of SHARED_PANELS) {
            const p = typeof Panels !== 'undefined' && Panels[id];
            const c = p && p.condition;
            if (c && Array.isArray(c.modes) && !c.modes.includes(MODE_ID)) { c.modes.push(MODE_ID); patchedPanels.push(c); }
        }
        try { if (Modes.vue) Modes.vue.$forceUpdate(); } catch (e) {}
    }

    function unregisterMode() {
        for (const c of patchedPanels) { const i = c.modes.indexOf(MODE_ID); if (i >= 0) c.modes.splice(i, 1); }
        patchedPanels.length = 0;
        if (modeObj) modeObj.delete();
        modeObj = null;
        try { if (Modes.vue) Modes.vue.$forceUpdate(); } catch (e) {}
    }

    // ------------------------------------------------------------------ format
    function registerFormat() {
        if (typeof ModelFormat === 'undefined' || !Formats.bedrock) return;
        const opts = {};
        for (const k of Object.keys(Formats.bedrock)) {
            const v = Formats.bedrock[k];
            if (['boolean', 'number', 'string'].includes(typeof v)) opts[k] = v;
        }
        delete opts.id;
        Object.assign(opts, {
            name: 'Minecraft UI',
            description: 'Interfaz 3D para Minecraft Bedrock (BB UI): huesos = botones, imagenes, modelos y numeros.',
            icon: 'dashboard_customize',
            category: 'minecraft',
            show_on_start_screen: true,
            single_texture: true,
            meshes: false, splines: false, armature_rig: false, billboards: false, bounding_boxes: false, texture_meshes: false,
            animation_files: false,
            onSetup() { setTimeout(() => { try { Project.box_uv = false; ensureData(); syncState(); } catch (e) {} }, 0); },
        });
        formatObj = new ModelFormat(FORMAT_ID, opts);
    }

    let lastSelVis = null;
    const uiOpened = new WeakSet();
    function poll() {
        try {
            // a saved UI project (opened from a file) goes straight to UI mode, once
            if (isUi() && Project.save_path && !uiOpened.has(Project) && !(typeof Dialog !== 'undefined' && Dialog.open)) {
                uiOpened.add(Project);
                const m = Modes.options[MODE_ID];
                if (m && !inUiMode()) { m.select(); setTimeout(() => { try { if (!inUiMode()) Modes.options[MODE_ID].select(); } catch (e) {} }, 800); }
                // the project may still be finishing its load: show only the active window and frame it once it is there
                for (const ms of [600, 1600]) setTimeout(() => { try { if (isUi()) { syncState(); applyVisibility(); applyGameView(true); } } catch (e) {} }, ms);
            }
        } catch (e) {}
        try { if (isUi() && state.sel !== lastSelVis) { lastSelVis = state.sel; applyVisibility(); } } catch (e) {}
        try { trackRenames(); } catch (e) { console.warn('BB UI Builder: rename tracking', e); }
        try { syncState(); } catch (e) {}
        try { processTextures(); } catch (e) {}
        try { checkSaved(); } catch (e) {}
        try { maybeWelcome(); } catch (e) {}
        try {
            const sig = state.rev + '|' + state.groups.join('|');
            if (isUi() && sig !== colorSig) { colorSig = sig; applyRoleColors(); }
        } catch (e) {}
        try { if (isUi() || safeObj) safeZone(); } catch (e) {}
    }

    BBPlugin.register(PLUGIN_ID, {
        title: 'BB UI Builder',
        author: 'SenyuGamer',
        icon: 'dashboard_customize',
        description: 'Disena UIs 3D de Minecraft Bedrock (BB UI): botones, imagenes, numeros, navegacion y acciones. Exporta ui.json + geo.json + textura al repo.',
        version: VERSION,
        variant: 'desktop',
        min_version: '4.10.0',
        tags: ['Minecraft: Bedrock Edition', 'UI'],
        onload() {
            styleEl = Blockbench.addCSS(CSS);
            registerFormat();
            registerMode();
            makePanels();
            makeActions();
            if (Codecs.project && Codecs.project.on) { Codecs.project.on('compile', onCompile); Codecs.project.on('parse', onParse); }
            loadProfile();
            loadDev();
            Blockbench.on('add_texture', onAddTexture);
            selListener = onSelection;
            Blockbench.on('update_selection', selListener);
            for (const ev of ['update_selection', 'select_project', 'new_project', 'load_project', 'finished_edit']) {
                Blockbench.on(ev, poll);
                listeners.push(ev);
            }
            keyHandler = (e) => {
                if (!state.preview.on || !isUi()) return;
                const t = e.target && e.target.tagName;
                if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
                const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
                if (map[e.key]) { previewMove(map[e.key]); e.preventDefault(); e.stopPropagation(); }
                else if (e.key === 'Enter') { previewAccept(); e.preventDefault(); }
                else if (e.key === 'Escape') { previewStop(); }
            };
            document.addEventListener('keydown', keyHandler, true);
            pollTimer = setInterval(poll, 400);
            window.BBUIBuilder = {
                getData: () => { const d = getData(); return d ? clone(d) : null; },
                setData: (obj) => { if (!isUi()) throw new Error('No hay proyecto Minecraft UI.'); Project.bbui = clone(obj); state.data = null; syncState(); touch(); },
                exportTo: (path, opts) => exportTo(path, opts),
                exportAndBuild: (opts) => exportAndBuild(opts),
                addImage, addText, addFont, removeFont, setSafe, applyRoleColors, setProfile,
                imageDialog, textDialog, fontDialog, templateDialog,
                applyTemplate, generateTooltip, setTooltip, setLang, addLanguage, removeLanguage, setTextPiece, setPieceLang, translationsDialog, createUiAnimation, editUiAnimation,
                addElement, createHighlight, applyGameView, previewMove, previewAccept, bonePositions,
                createWindow, renameWindow, deleteWindow, setTransition, addCharacter, importCharacter, scaleCharacter, removeCharacter, testInGame, setDev,
                safeZoneInfo: () => (safeObj ? clone(safeObj.bbui_info) : null),
                validate,
                core,
            };
            poll();
        },
        onunload() {
            const step = (f) => { try { f(); } catch (e) { console.warn('BB UI Builder unload:', e); } };
            step(() => Blockbench.removeListener('add_texture', onAddTexture));
            step(() => { if (selListener) Blockbench.removeListener('update_selection', selListener); selListener = null; });
            step(restoreView);
            step(() => { state.showSettings = false; state.showAnims = false; });
            step(() => clearInterval(pollTimer));
            step(() => clearTimeout(autoTimer));
            step(() => { state.safe = false; removeSafe(); });
            step(() => document.removeEventListener('keydown', keyHandler, true));
            step(() => listeners.forEach((ev) => Blockbench.removeListener(ev, poll)));
            step(() => {
                if (Codecs.project && Codecs.project.removeListener) {
                    Codecs.project.removeListener('compile', onCompile);
                    Codecs.project.removeListener('parse', onParse);
                }
            });
            step(() => { const tb = Toolbars.outliner; if (tb) { for (const a of actions) { const i = tb.children.indexOf(a); if (i >= 0) tb.children.splice(i, 1); } tb.update(); } });
            step(removePieceTypeMenu);
            step(() => menus.forEach((m) => m.delete && m.delete()));
            step(() => actions.forEach((a) => a.delete()));
            step(() => panels.forEach((p) => p.delete()));
            step(() => styleEl && styleEl.delete());
            step(unregisterMode);
            step(() => { if (formatObj) formatObj.delete(); });
            actions = []; panels = []; listeners = []; formatObj = null; menus.length = 0;
            delete window.BBUIBuilder;
        },
    });
})();
