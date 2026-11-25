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
    const ACTION_TYPES = ['goto', 'back', 'close', 'command', 'script', 'set', 'add', 'sequence'];
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

    // Screen space: right = model -X, up = model +Y. pos = { bone: [x,y,z] } (group origins).
    core.nearest = function (pos, buttons, from, dir) {
        const p = pos[from];
        if (!p) return null;
        let best = null, bestScore = Infinity;
        for (const b of buttons) {
            if (b === from || !pos[b]) continue;
            const dx = -(pos[b][0] - p[0]);
            const dy = pos[b][1] - p[1];
            const main = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'up' ? dy : -dy;
            const side = (dir === 'left' || dir === 'right') ? dy : dx;
            if (main <= 1e-4) continue;
            const score = main + 2 * Math.abs(side);
            if (score < bestScore) { bestScore = score; best = b; }
        }
        return best;
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
        return n;
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
        const claim = (bone, where) => {
            if (!bones.has(bone)) E(where + ': el hueso "' + bone + '" no existe en el modelo.');
            if (used.has(bone)) E(where + ': el hueso "' + bone + '" ya se usa en ' + used.get(bone) + '.');
            else used.set(bone, where);
        };
        const queryNames = Object.keys(data.queries || {});
        for (const s of screens) {
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

    const state = { data: null, activeScreen: '', showAll: false, sel: '', rev: 0, groups: [], preview: { on: false, focus: '', stack: [] } };
    let panels = [], actions = [], listeners = [], styleEl = null, formatObj = null, pollTimer = null, keyHandler = null;
    const menus = [];

    const isUi = () => typeof Format !== 'undefined' && Format && Format.id === FORMAT_ID && typeof Project !== 'undefined' && Project;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const touch = () => { try { Project.saved = false; } catch (e) {} state.rev++; };
    const getData = () => (isUi() ? Project.bbui || null : null);

    function boneNames() { try { return (Group.all || []).map((g) => g.name); } catch (e) { return []; } }
    function bonePositions() {
        const out = {};
        try { for (const g of Group.all || []) out[g.name] = g.origin ? g.origin.slice() : [0, 0, 0]; } catch (e) {}
        return out;
    }

    function ensureData() {
        if (!isUi()) return null;
        if (!Project.bbui) Project.bbui = core.defaultData(Project.name || Project.geometry_name);
        return Project.bbui;
    }

    function syncState() {
        if (!isUi()) { state.data = null; return; }
        const d = ensureData();
        if (state.data !== d) {
            state.data = d;
            if (!core.getScreen(d, state.activeScreen)) state.activeScreen = d.start_screen || (d.screens[0] && d.screens[0].id) || '';
            state.preview.on = false;
        }
        const g = (typeof Group !== 'undefined') ? (Group.first_selected || Group.selected) : null;
        const name = g ? g.name : '';
        if (state.sel !== name) state.sel = name;
        const names = boneNames();
        if (names.join('|') !== state.groups.join('|')) state.groups = names;
    }

    // ------------------------------------------------------------------ visibility per screen
    function applyVisibility() {
        const d = getData();
        if (!d) return;
        const owner = {};
        for (const s of d.screens) {
            for (const b of s.bones || []) owner[b] = s.id;
            for (const e of s.elements || []) { owner[e.bone] = s.id; if (e.highlight) owner[e.highlight] = s.id; }
        }
        for (const g of Group.all || []) {
            const o = owner[g.name];
            g.visibility = state.showAll || !o || o === state.activeScreen;
        }
        try { Canvas.updateVisibility(); } catch (e) {}
        try { Canvas.updateAllBones(); } catch (e) {}
    }
    function showAllTemporarily(fn) {
        const prev = (Group.all || []).map((g) => [g, g.visibility]);
        for (const [g] of prev) g.visibility = true;
        try { return fn(); } finally { for (const [g, v] of prev) g.visibility = v; try { Canvas.updateVisibility(); } catch (e) {} }
    }

    // ------------------------------------------------------------------ preview navigation
    function previewButtons() {
        const s = core.getScreen(state.data, state.activeScreen);
        return s ? core.buttons(s).map((e) => e.bone) : [];
    }
    function previewFocus(bone) {
        state.preview.focus = bone;
        const g = (Group.all || []).find((x) => x.name === bone);
        if (g) { try { g.select(); } catch (e) {} }
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
            else msg += (msg ? ', ' : '') + a.type;
        }
        if (msg) Blockbench.showQuickMessage('Accion: ' + msg, 1500);
    }
    function gotoScreen(id) {
        const s = core.getScreen(state.data, id);
        if (!s) return;
        state.activeScreen = id;
        applyVisibility();
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
    function flatGroup(name, cx, cy, z, w, h) {
        const group = new Group({ name, origin: [cx, cy, z] }).init();
        const cube = new Cube({ name: name + '_plane', from: [cx - w / 2, cy - h / 2, z], to: [cx + w / 2, cy + h / 2, z] });
        try { cube.box_uv = false; } catch (e) {}
        cube.init();
        cube.addTo(group);
        try {
            cube.faces.north.uv = [0, 0, w, h];
            for (const f of ['south', 'east', 'west', 'up', 'down']) cube.faces[f].uv = [0, 0, 0, 0];
        } catch (e) {}
        return { group, cube };
    }
    const SIZES = { button: [8, 4], image: [16, 8], number: [8, 4], model: [8, 8] };
    function addElement(kind) {
        const d = ensureData();
        if (!d) return Blockbench.showQuickMessage('Abre un proyecto "Minecraft UI".', 2000);
        syncState();
        const screen = core.getScreen(d, state.activeScreen);
        const prefix = { button: 'btn', image: 'img', number: 'num', model: 'mdl' }[kind];
        const name = nextName(prefix);
        const used = (screen.elements || []).length + (screen.bones || []).length;
        const [w, h] = SIZES[kind];
        const y = 14 - 6 * (used % 3);
        const x = -Math.floor(used / 3) * 10;
        const groups = [], cubes = [];
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        const main = flatGroup(name, x, y, -0.4, w, h);
        groups.push(main.group); cubes.push(main.cube);
        let hlName = '';
        if (kind === 'button') {
            hlName = name + '_hl';
            const hl = flatGroup(hlName, x, y, -0.2, w + 1.5, h + 1.5);
            groups.push(hl.group); cubes.push(hl.cube);
        }
        Undo.finishEdit('Add UI ' + kind, { outliner: true, elements: cubes, groups });
        const el = core.assignBone(d, screen.id, name, kind, Object.keys(d.queries));
        if (el && hlName) core.set(el, 'highlight', hlName);
        touch();
        applyVisibility();
        try { main.group.select(); } catch (e) {}
        syncState();
        return name;
    }

    // ------------------------------------------------------------------ validate / export
    function validate() { return core.validate(getData(), boneNames()); }
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
        root = String(root || getExportRoot(false)).replace(/\\/g, '/').replace(/\/$/, '');
        if (!root) throw new Error('No hay carpeta de exportacion.');
        const dir = root + '/' + d.id;
        fs.mkdirSync(dir, { recursive: true });

        // geo.json: Codecs.bedrock writes the project as a single minecraft:geometry.
        try { if (!Project.geometry_name) Project.geometry_name = 'bb_ui_' + d.id + '_src'; } catch (e) {}
        const geo = toObject(showAllTemporarily(() => Codecs.bedrock.compile()));
        const geos = geo['minecraft:geometry'];
        if (!Array.isArray(geos) || geos.length !== 1) throw new Error('geo.json debe tener exactamente una geometria (tiene ' + (geos ? geos.length : 0) + ').');
        fs.writeFileSync(dir + '/geo.json', JSON.stringify(geo, null, 2));

        const tex = (typeof Texture !== 'undefined' && Texture.all && Texture.all[0]) || null;
        if (!tex) throw new Error('El proyecto no tiene textura.');
        let b64 = '';
        try { b64 = tex.getBase64(); } catch (e) {}
        if (!b64 && tex.canvas) b64 = tex.canvas.toDataURL('image/png');
        b64 = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
        if (!b64) throw new Error('No se pudo leer la textura.');
        fs.writeFileSync(dir + '/texture.png', Buffer.from(b64, 'base64'));

        fs.writeFileSync(dir + '/ui.json', JSON.stringify(clone(d), null, 2));
        const proj = Codecs.project.compile();
        fs.writeFileSync(dir + '/model.bbmodel', typeof proj === 'string' ? proj : JSON.stringify(proj));
        return { dir, files: ['ui.json', 'geo.json', 'texture.png', 'model.bbmodel'], warnings: res.warnings };
    }
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

    // ------------------------------------------------------------------ project persistence
    function onCompile(e) {
        if (!e || !e.model || !isUi() || !Project.bbui) return;
        e.model.bbui = clone(Project.bbui);
    }
    function onParse(e) {
        if (!e || !e.model || !e.model.bbui) return;
        Project.bbui = e.model.bbui;
        state.data = null;
    }

    // ------------------------------------------------------------------ Vue templates
    const ACTION_FIELDS = {
        goto: [{ k: 'screen', t: 'screen' }],
        back: [], close: [],
        command: [{ k: 'command', t: 'text' }, { k: 'as', t: 'select', o: ['player', 'server'] }],
        script: [{ k: 'fn', t: 'text' }, { k: 'args', t: 'json' }],
        set: [{ k: 'key', t: 'text' }, { k: 'value', t: 'value' }],
        add: [{ k: 'key', t: 'text' }, { k: 'amount', t: 'number' }, { k: 'min', t: 'number', opt: true }, { k: 'max', t: 'number', opt: true }],
        sequence: [],
    };

    const actionComp = {
        name: 'bbui-action',
        props: ['action', 'screens', 'nested'],
        computed: {
            fields() { return ACTION_FIELDS[this.action.type] || []; },
            typeList() { return this.nested ? ACTION_TYPES.filter((t) => t !== 'sequence') : ACTION_TYPES; },
        },
        methods: {
            setType(t) {
                for (const k of Object.keys(this.action)) if (k !== 'type') core.del(this.action, k);
                core.set(this.action, 'type', t);
                if (t === 'goto') core.set(this.action, 'screen', this.screens[0] ? this.screens[0].id : '');
                if (t === 'command') core.set(this.action, 'command', '');
                if (t === 'script') core.set(this.action, 'fn', '');
                if (t === 'set') { core.set(this.action, 'key', ''); core.set(this.action, 'value', 0); }
                if (t === 'add') { core.set(this.action, 'key', ''); core.set(this.action, 'amount', 1); }
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
                    catch (e) { Blockbench.showQuickMessage('JSON invalido', 1500); return; }
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
        template: '<div class="bbui-action">' +
            '<select @change="setType($event.target.value)"><option v-for="t in typeList" :value="t" :selected="t === action.type">{{t}}</option></select>' +
            '<div v-for="f in fields" class="bbui-row"><label>{{f.k}}</label>' +
            '<select v-if="f.t === \'screen\'" @change="setF(f, $event.target.value)"><option v-for="s in screens" :value="s.id" :selected="s.id === action.screen">{{s.id}}</option></select>' +
            '<select v-else-if="f.t === \'select\'" @change="setF(f, $event.target.value)"><option v-for="o in f.o" :value="o" :selected="o === (action[f.k] || f.o[0])">{{o}}</option></select>' +
            '<input v-else :type="f.t === \'number\' ? \'number\' : \'text\'" :value="show(f)" @change="setF(f, $event.target.value)">' +
            '</div>' +
            '<div v-if="action.type === \'sequence\'" class="bbui-seq">' +
            '<div v-for="(a, i) in action.actions" class="bbui-seqitem"><bbui-action :action="a" :screens="screens" :nested="true"></bbui-action><button class="bbui-x" @click="delSub(i)">x</button></div>' +
            '<button @click="addSub">+ sub-accion</button></div></div>',
    };

    const TPL_SCREENS = '<div class="bbui" v-if="st.data">' +
        '<div v-for="s in st.data.screens" :key="s.id" class="bbui-screen" :class="{active: s.id === st.activeScreen}">' +
        '<span class="bbui-name" @click="activate(s.id)">{{s.id}}</span>' +
        '<span class="bbui-tag" v-if="s.id === st.data.start_screen">inicio</span>' +
        '<button title="Pantalla de inicio" @click="setStart(s.id)">&#9733;</button>' +
        '<button title="Renombrar" @click="rename(s.id)">&#9998;</button>' +
        '<button title="Eliminar" @click="remove(s.id)">&#10005;</button></div>' +
        '<button @click="add">+ Pantalla</button> ' +
        '<label class="bbui-chk"><input type="checkbox" v-model="st.showAll" @change="refresh"> Mostrar todo</label>' +
        '<div v-if="screen" class="bbui-box"><b>Pantalla {{screen.id}}</b>' +
        '<div class="bbui-row"><label>default_focus</label><select @change="setFocus($event.target.value)"><option value="" :selected="!screen.default_focus">(auto)</option>' +
        '<option v-for="b in buttons" :value="b" :selected="b === screen.default_focus">{{b}}</option></select></div>' +
        '<div class="bbui-row"><label>actionbar</label><input type="text" :value="screen.actionbar || \'\'" @change="setBar($event.target.value)" placeholder="Monedas: {coins}"></div></div>' +
        '<div class="bbui-box"><b>Vista previa de navegacion</b><br>' +
        '<button @click="togglePreview">{{st.preview.on ? \'Detener\' : \'Iniciar\'}}</button> <span v-if="st.preview.on">Foco: <b>{{st.preview.focus}}</b> (flechas, Enter, Esc)</span>' +
        '<div v-if="st.preview.on" class="bbui-pad"><button @click="mv(\'up\')">&#9650;</button><br><button @click="mv(\'left\')">&#9664;</button><button @click="ok">OK</button><button @click="mv(\'right\')">&#9654;</button><br><button @click="mv(\'down\')">&#9660;</button></div></div></div>';

    const TPL_ELEMENT = '<div class="bbui" v-if="st.data">' +
        '<div v-if="!st.sel" class="bbui-dim">Selecciona un hueso (grupo) en el outliner.</div>' +
        '<div v-else><b>{{st.sel}}</b> <span class="bbui-dim" v-if="info">en {{info.screen.id}}</span>' +
        '<div class="bbui-row"><label>Rol</label><select @change="setRole($event.target.value)"><option v-for="r in roles" :value="r" :selected="r === role">{{roleLabel[r]}}</option></select></div>' +
        '<div class="bbui-row" v-if="role !== \'none\'"><label>Pantalla</label><select @change="moveTo($event.target.value)"><option v-for="s in st.data.screens" :value="s.id" :selected="s.id === info.screen.id">{{s.id}}</option></select></div>' +
        '<div v-if="el && role === \'button\'">' +
        '<div class="bbui-box"><b>Accion</b><bbui-action :action="el.action" :screens="st.data.screens"></bbui-action></div>' +
        '<div class="bbui-box"><b>Navegacion</b>' +
        '<div class="bbui-row" v-for="d in dirs"><label>{{d}}</label><select @change="setNav(d, $event.target.value)">' +
        '<option value="__auto" :selected="!hasNav(d)">auto (mas cercano)</option><option value="__none" :selected="hasNav(d) && el.nav[d] === null">ninguno</option>' +
        '<option v-for="b in others" :value="b" :selected="hasNav(d) && el.nav[d] === b">{{b}}</option></select></div></div>' +
        '<div class="bbui-box"><div class="bbui-row"><label>highlight</label><select @change="setHl($event.target.value)"><option value="" :selected="!el.highlight">(ninguno)</option>' +
        '<option v-for="g in groupsOther" :value="g" :selected="g === el.highlight">{{g}}</option></select></div></div></div>' +
        '<div v-if="el && role === \'number\'" class="bbui-box"><b>Numero</b>' +
        '<div class="bbui-row"><label>query</label><select @change="el.query = $event.target.value; touch()"><option v-for="q in queryNames" :value="q" :selected="q === el.query">{{q}}</option></select></div>' +
        '<div class="bbui-row"><label>digits</label><input type="number" min="1" max="9" :value="el.digits" @change="el.digits = Number($event.target.value) || 1; touch()"></div>' +
        '<div class="bbui-row"><label>align</label><select @change="el.align = $event.target.value; touch()"><option v-for="a in [\'left\', \'right\', \'center\']" :value="a" :selected="a === el.align">{{a}}</option></select></div></div>' +
        '<div v-if="el" class="bbui-box"><label class="bbui-chk"><input type="checkbox" :checked="!!el.visible_if" @change="toggleVis($event.target.checked)"> visible_if</label>' +
        '<div v-if="el.visible_if"><div class="bbui-row"><label>query</label><select @change="el.visible_if.query = $event.target.value; touch()"><option v-for="q in queryNames" :value="q" :selected="q === el.visible_if.query">{{q}}</option></select></div>' +
        '<div class="bbui-row"><label>op</label><select @change="el.visible_if.op = $event.target.value; touch()"><option v-for="o in ops" :value="o" :selected="o === el.visible_if.op">{{o}}</option></select></div>' +
        '<div class="bbui-row"><label>value</label><input type="number" :value="el.visible_if.value" @change="el.visible_if.value = Number($event.target.value) || 0; touch()"></div></div></div>' +
        '</div></div>';

    const TPL_SETTINGS = '<div class="bbui" v-if="d">' +
        '<div class="bbui-row"><label>id</label><input type="text" v-model="d.id" @change="touch()"></div>' +
        '<div class="bbui-row"><label>namespace</label><input type="text" v-model="d.namespace" @change="touch()"></div>' +
        '<div class="bbui-box"><b>Display</b>' +
        '<div class="bbui-row"><label>fov</label><input type="number" v-model.number="d.display.fov" @change="touch()"></div>' +
        '<div class="bbui-row"><label>distance</label><input type="number" step="0.1" v-model.number="d.display.distance" @change="touch()"></div>' +
        '<div class="bbui-row"><label>height</label><input type="number" step="0.1" v-model.number="d.display.height" @change="touch()"></div>' +
        '<div class="bbui-row"><label>anchor</label><select @change="d.display.anchor = $event.target.value; touch()"><option v-for="a in [\'player\', \'trigger\']" :value="a" :selected="a === d.display.anchor">{{a}}</option></select></div>' +
        '<div class="bbui-row" v-for="k in soundKeys"><label>sound {{k}}</label><input type="text" :value="sound(k)" @change="setSound(k, $event.target.value)"></div></div>' +
        '<div class="bbui-box"><b>Metodos de apertura</b>' +
        '<div v-for="(o, i) in d.open" class="bbui-box"><b>{{o.type}}</b> <button class="bbui-x" @click="delOpen(i)">x</button>' +
        '<div class="bbui-row" v-if="o.type === \'item\'"><label>item</label><input type="text" v-model="o.item" @change="touch()"></div>' +
        '<div class="bbui-row" v-if="o.type === \'block\'"><label>block</label><input type="text" v-model="o.block" @change="touch()"></div>' +
        '<div class="bbui-row" v-if="o.type === \'entity\'"><label>entity</label><input type="text" v-model="o.entity" @change="touch()"></div>' +
        '<div v-if="o.type === \'command\'"><div class="bbui-row"><label>name</label><input type="text" v-model="o.name" @change="touch()"></div>' +
        '<div class="bbui-row"><label>permission</label><select @change="o.permission = $event.target.value; touch()"><option v-for="p in [\'any\', \'gamedirectors\', \'admin\']" :value="p" :selected="p === o.permission">{{p}}</option></select></div></div>' +
        '<div v-if="o.type === \'item\' || o.type === \'block\'"><label class="bbui-chk"><input type="checkbox" :checked="!!o.generate" @change="toggleGen(o, $event.target.checked)"> generate</label>' +
        '<div v-if="o.generate"><div class="bbui-row"><label>name</label><input type="text" v-model="o.generate.name" @change="touch()"></div>' +
        '<div class="bbui-row"><label>texture</label><input type="text" v-model="o.generate.texture" @change="touch()"></div></div></div></div>' +
        '<select v-model="newOpen"><option v-for="t in [\'item\', \'block\', \'entity\', \'command\']" :value="t">{{t}}</option></select> <button @click="addOpen">+ Metodo</button></div>' +
        '<div class="bbui-box"><b>Queries</b>' +
        '<div v-for="k in queryNames" class="bbui-box"><b>{{k}}</b> <button class="bbui-x" @click="delQuery(k)">x</button>' +
        '<div class="bbui-row"><label>source</label><select @change="setSource(k, $event.target.value)"><option v-for="s in sources" :value="s" :selected="s === d.queries[k].source">{{s}}</option></select></div>' +
        '<div class="bbui-row" v-if="d.queries[k].source === \'dynamic_property\'"><label>key</label><input type="text" v-model="d.queries[k].key" @change="touch()"></div>' +
        '<div class="bbui-row" v-if="d.queries[k].source === \'scoreboard\'"><label>objective</label><input type="text" v-model="d.queries[k].objective" @change="touch()"></div>' +
        '<div class="bbui-row" v-if="d.queries[k].source === \'script\'"><label>fn</label><input type="text" v-model="d.queries[k].fn" @change="touch()"></div>' +
        '<div class="bbui-row"><label>default</label><input type="number" :value="d.queries[k].default" @change="setDefault(k, $event.target.value)"></div></div>' +
        '<button @click="addQuery">+ Query</button></div>' +
        '<div class="bbui-box"><button @click="doValidate">Validar</button> <button @click="doExport">Exportar al pack</button> <button @click="pickRoot">Carpeta...</button><div class="bbui-dim">{{root}}</div></div></div>';

    // ------------------------------------------------------------------ panels
    function getRootLabel() { try { return localStorage.getItem(STORE_KEY) || '(sin carpeta de exportacion)'; } catch (e) { return ''; } }

    function makePanels() {
        const cond = { formats: [FORMAT_ID], modes: ['edit'] };
        const pos = { slot: 'right_bar', float_position: [0, 0], float_size: [320, 420], height: 300, folded: false };

        panels.push(new Panel('bb_ui_screens', {
            id: 'bb_ui_screens', name: 'UI Screens', icon: 'layers', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                data() { return { st: state }; },
                computed: {
                    screen() { return this.st.data ? core.getScreen(this.st.data, this.st.activeScreen) : null; },
                    buttons() { return this.screen ? core.buttons(this.screen).map((e) => e.bone) : []; },
                },
                methods: {
                    activate(id) { gotoScreen(id); },
                    refresh() { applyVisibility(); },
                    setStart(id) { this.st.data.start_screen = id; touch(); },
                    add() {
                        Blockbench.textPrompt('Id de la pantalla', 'screen_' + (this.st.data.screens.length + 1), (v) => {
                            v = core.sanitizeId(v);
                            if (core.getScreen(this.st.data, v)) return Blockbench.showQuickMessage('Ya existe', 1500);
                            this.st.data.screens.push({ id: v, bones: [], elements: [] });
                            touch(); gotoScreen(v);
                        });
                    },
                    rename(id) {
                        Blockbench.textPrompt('Nuevo id', id, (v) => {
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
                        if (d.screens.length < 2) return Blockbench.showQuickMessage('Debe quedar una pantalla', 1500);
                        d.screens.splice(d.screens.findIndex((s) => s.id === id), 1);
                        if (d.start_screen === id) d.start_screen = d.screens[0].id;
                        if (this.st.activeScreen === id) this.st.activeScreen = d.start_screen;
                        touch(); applyVisibility();
                    },
                    setFocus(v) { if (v) core.set(this.screen, 'default_focus', v); else core.del(this.screen, 'default_focus'); touch(); },
                    setBar(v) { if (v) core.set(this.screen, 'actionbar', v); else core.del(this.screen, 'actionbar'); touch(); },
                    togglePreview() { if (this.st.preview.on) previewStop(); else previewStart(); },
                    mv(d) { previewMove(d); },
                    ok() { previewAccept(); },
                },
                template: TPL_SCREENS,
            },
        }));

        panels.push(new Panel('bb_ui_element', {
            id: 'bb_ui_element', name: 'UI Element', icon: 'smart_button', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                components: { 'bbui-action': actionComp },
                data() {
                    return { st: state, roles: ROLES, dirs: DIRS, ops: OPS, roleLabel: { none: 'Ninguno', decor: 'Decoracion de pantalla', button: 'Boton', image: 'Imagen', model: 'Modelo', number: 'Numero' } };
                },
                computed: {
                    info() { return this.st.data && this.st.sel ? core.findBone(this.st.data, this.st.sel) : null; },
                    el() { return this.info && this.info.element; },
                    role() { return !this.info ? 'none' : this.info.decor ? 'decor' : this.info.element.type; },
                    queryNames() { return this.st.data ? Object.keys(this.st.data.queries) : []; },
                    others() { return this.info ? core.buttons(this.info.screen).map((e) => e.bone).filter((b) => b !== this.st.sel) : []; },
                    groupsOther() { return this.st.groups.filter((g) => g !== this.st.sel); },
                },
                methods: {
                    touch,
                    setRole(r) {
                        const screenId = this.info ? this.info.screen.id : this.st.activeScreen;
                        core.assignBone(this.st.data, screenId, this.st.sel, r, this.queryNames);
                        touch();
                    },
                    moveTo(id) {
                        const role = this.role, old = this.el ? clone(this.el) : null;
                        core.assignBone(this.st.data, id, this.st.sel, role, this.queryNames);
                        if (old) { const ne = core.findBone(this.st.data, this.st.sel).element; for (const k of Object.keys(old)) core.set(ne, k, old[k]); }
                        touch();
                    },
                    hasNav(d) { return !!(this.el.nav && Object.prototype.hasOwnProperty.call(this.el.nav, d)); },
                    setNav(d, v) {
                        if (v === '__auto') { if (this.el.nav) core.del(this.el.nav, d); if (this.el.nav && !Object.keys(this.el.nav).length) core.del(this.el, 'nav'); }
                        else { if (!this.el.nav) core.set(this.el, 'nav', {}); core.set(this.el.nav, d, v === '__none' ? null : v); }
                        touch();
                    },
                    setHl(v) { if (v) core.set(this.el, 'highlight', v); else core.del(this.el, 'highlight'); touch(); },
                    toggleVis(on) {
                        if (on) core.set(this.el, 'visible_if', { query: this.queryNames[0] || '', op: '>=', value: 1 });
                        else core.del(this.el, 'visible_if');
                        touch();
                    },
                },
                template: TPL_ELEMENT,
            },
        }));

        panels.push(new Panel('bb_ui_settings', {
            id: 'bb_ui_settings', name: 'UI Settings', icon: 'settings', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                data() { return { st: state, newOpen: 'item', sources: ['dynamic_property', 'scoreboard', 'script'], soundKeys: ['move', 'accept', 'open', 'close'], root: getRootLabel() }; },
                computed: {
                    d() { return this.st.data; },
                    queryNames() { return this.st.data ? Object.keys(this.st.data.queries) : []; },
                },
                methods: {
                    touch,
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
                    doValidate() { showValidation(validate()); },
                    doExport() { exportAction(); this.root = getRootLabel(); },
                    pickRoot() { getExportRoot(true); this.root = getRootLabel(); },
                },
                template: TPL_SETTINGS,
            },
        }));
    }

    const CSS = '.bbui{padding:6px;font-size:12px}.bbui-row{display:flex;gap:6px;align-items:center;margin:2px 0}.bbui-row label{flex:0 0 90px;opacity:.8}' +
        '.bbui-row input,.bbui-row select,.bbui-action>select{flex:1;min-width:0}.bbui-box{border:1px solid var(--color-border);border-radius:4px;padding:5px;margin:6px 0}' +
        '.bbui-screen{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:3px}.bbui-screen.active{background:var(--color-selected)}.bbui-name{flex:1;cursor:pointer}' +
        '.bbui-tag{font-size:10px;opacity:.7}.bbui-dim{opacity:.6}.bbui-chk{display:inline-flex;gap:4px;align-items:center}.bbui-x{padding:0 6px}' +
        '.bbui-seq{margin-left:10px}.bbui-seqitem{display:flex;gap:4px;align-items:flex-start;border-left:2px solid var(--color-border);padding-left:4px;margin:3px 0}' +
        '.bbui-pad{margin-top:6px;text-align:center}.bbui-pad button{min-width:34px;margin:1px}';

    // ------------------------------------------------------------------ actions
    function makeActions() {
        const mk = (id, name, icon, fn) => {
            const a = new Action('bb_ui_' + id, {
                name, icon, condition: () => isUi(),
                click() { try { fn(); } catch (e) { console.error(e); Blockbench.showMessageBox({ title: 'BB UI', message: esc(e.message), icon: 'error' }); } },
            });
            actions.push(a);
            return a;
        };
        const list = [
            mk('add_button', 'UI: Add Button', 'smart_button', () => addElement('button')),
            mk('add_image', 'UI: Add Image', 'image', () => addElement('image')),
            mk('add_number', 'UI: Add Number', 'pin', () => addElement('number')),
            mk('add_model', 'UI: Add Model Slot', 'view_in_ar', () => addElement('model')),
            mk('preview', 'UI: Preview navigation', 'gamepad', () => { syncState(); if (state.preview.on) previewStop(); else previewStart(); }),
            mk('validate', 'UI: Validate', 'rule', () => showValidation(validate())),
            mk('export', 'UI: Export to pack', 'upload', exportAction),
            mk('export_root', 'UI: Set export folder', 'folder_open', () => getExportRoot(true)),
        ];
        try {
            // BarMenu registers itself in the menu bar.
            menus.push(new BarMenu('bb_ui_menu', list.map((a) => a.id), { name: 'UI', condition: () => isUi() }));
        } catch (e) {
            console.warn('BB UI Builder: menu', e);
            for (const a of list) { try { MenuBar.addAction(a, 'tools'); } catch (e2) {} }
        }
        try { const tb = Toolbars.outliner; if (tb) { for (const a of list.slice(0, 4)) tb.add(a); tb.update(); } } catch (e) {}
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

    function poll() { try { syncState(); } catch (e) {} }

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
            makePanels();
            makeActions();
            if (Codecs.project && Codecs.project.on) { Codecs.project.on('compile', onCompile); Codecs.project.on('parse', onParse); }
            for (const ev of ['update_selection', 'select_project', 'new_project', 'load_project']) {
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
                validate,
                core,
            };
            poll();
        },
        onunload() {
            const step = (f) => { try { f(); } catch (e) { console.warn('BB UI Builder unload:', e); } };
            step(() => clearInterval(pollTimer));
            step(() => document.removeEventListener('keydown', keyHandler, true));
            step(() => listeners.forEach((ev) => Blockbench.removeListener(ev, poll)));
            step(() => {
                if (Codecs.project && Codecs.project.removeListener) {
                    Codecs.project.removeListener('compile', onCompile);
                    Codecs.project.removeListener('parse', onParse);
                }
            });
            step(() => { const tb = Toolbars.outliner; if (tb) { for (const a of actions) { const i = tb.children.indexOf(a); if (i >= 0) tb.children.splice(i, 1); } tb.update(); } });
            step(() => menus.forEach((m) => m.delete && m.delete()));
            step(() => actions.forEach((a) => a.delete()));
            step(() => panels.forEach((p) => p.delete()));
            step(() => styleEl && styleEl.delete());
            step(() => { if (formatObj) formatObj.delete(); });
            actions = []; panels = []; listeners = []; formatObj = null; menus.length = 0;
            delete window.BBUIBuilder;
        },
    });
})();
