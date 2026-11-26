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
        const tips = data.editor && data.editor.tooltips;
        if (tips && Object.prototype.hasOwnProperty.call(tips, from) && !Object.prototype.hasOwnProperty.call(tips, to)) {
            core.set(tips, to, tips[from]);
            core.del(tips, from);
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

    const state = { data: null, activeScreen: '', showAll: false, showTips: true, safe: false, sel: '', rev: 0, groups: [], textures: [], animNames: [], profile: 'default', building: false, preview: { on: false, focus: '', stack: [] } };
    const MODE_ID = 'bb_ui_mode';
    // Built-in panels that also show in the UI mode (to select bones and paint): their condition gets MODE_ID while loaded.
    const SHARED_PANELS = ['outliner', 'textures'];
    let panels = [], actions = [], listeners = [], styleEl = null, formatObj = null, pollTimer = null, keyHandler = null, modeObj = null;
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
        for (const g of Group.all || []) {
            const o = owner[g.name];
            g.visibility = state.showAll || !o || o.has(state.activeScreen);
            if (tipGroups.has(g)) g.visibility = state.showTips !== false; // tooltips: editor toggle (they only show while focused in game)
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
            else if (a.type === 'settings') Blockbench.showQuickMessage('Abre el formulario de ajustes', 1500);
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
        const at = placement(screen, null);
        const x = at.x, y = at.y;
        const groups = [], cubes = [];
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        const main = flatGroup(name, x, y, at.z, w, h);
        groups.push(main.group); cubes.push(main.cube);
        let hlName = '';
        if (kind === 'button') {
            hlName = name + '_hl';
            const hl = flatGroup(hlName, x, y, at.z + 0.2, w + 1.5, h + 1.5);
            groups.push(hl.group); cubes.push(hl.cube);
        }
        Undo.finishEdit('Add UI ' + kind, { outliner: true, elements: cubes, groups });
        try { Canvas.updateAll(); } catch (e) {}
        const el = core.assignBone(d, screen.id, name, kind, Object.keys(d.queries));
        if (el && hlName) core.set(el, 'highlight', hlName);
        touch();
        applyVisibility();
        applyRoleColors();
        try { main.group.select(); } catch (e) {}
        syncState();
        return name;
    }

    // ------------------------------------------------------------------ placement helpers
    function selectedGroup() { try { return Group.first_selected || null; } catch (e) { return null; } }
    // Where a new element goes: inside the selected group (at its origin, a bit in front) or stacked at the root.
    function placement(screen, parent) {
        if (parent && parent.origin) return { x: parent.origin[0], y: parent.origin[1], z: parent.origin[2] - 0.2 };
        const used = (screen.elements || []).length + (screen.bones || []).length;
        // centre of what is visible now (world space), just in front of it, staggered so new items don't stack
        const b = cubeBounds();
        if (b) {
            const k = used % 6;
            return { x: (b.mn[0] + b.mx[0]) / 2 + (k % 3 - 1) * 3, y: (b.mn[1] + b.mx[1]) / 2 + (1 - Math.floor(k / 3)) * 3, z: b.mn[2] - 0.4 };
        }
        return { x: -Math.floor(used / 3) * 10, y: 14 - 6 * (used % 3), z: -0.4 };
    }
    function finishNewElement(d, screen, name, group, role) {
        core.assignBone(d, screen.id, name, role, Object.keys(d.queries));
        touch();
        try { Canvas.updateAll(); } catch (e) {} // new cubes need their meshes/UVs built before they show
        applyVisibility();
        applyRoleColors();
        try { group.select(); } catch (e) {}
        syncState();
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
        const parent = selectedGroup();
        const name = opts.name && !boneNames().includes(opts.name) ? opts.name : nextName('img');
        const p = placement(screen, parent);
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        const q = flatGroup(name, p.x, p.y, p.z, w, h, uv, parent);
        Undo.finishEdit('Add UI image', { outliner: true, elements: [q.cube], groups: [q.group] });
        finishNewElement(d, screen, name, q.group, 'image');
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
            id: 'bb_ui_add_image', title: opts.title || 'UI: Add Image', width: 640, component,
            buttons: [pk.pickOnly ? 'Elegir' : 'Add', 'Cancel'], confirmIndex: 0, cancelIndex: 1,
            onConfirm() {
                if (pk.pickOnly) {
                    if (!(pk.u1 > pk.u0 && pk.v1 > pk.v0)) { Blockbench.showQuickMessage('Rectangulo de UV vacio', 1500); return false; }
                    try { opts.onPick([pk.u0, pk.v0, pk.u1, pk.v1]); } catch (e) { console.error(e); }
                    return;
                }
                try { addImage({ uv: [pk.u0, pk.v0, pk.u1, pk.v1], height: pk.height, name: pk.name }); }
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
                const g = font.glyphs[ch] && norm(font.glyphs[ch]);
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
        const parent = selectedGroup();
        const name = opts.name && !boneNames().includes(opts.name) ? opts.name : nextName('txt');
        const p = placement(screen, parent);
        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        const t = buildTextGroup({ name, font, text, scale: opts.scale, align: opts.align, cx: p.x, cy: p.y, z: p.z, parent });
        Undo.finishEdit('Add UI text', { outliner: true, elements: t.cubes, groups: [t.group] });
        finishNewElement(d, screen, name, t.group, 'image');
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
        const group = new Group({ name: o.name, origin: [o.cx, o.cy, o.z] }).init();
        if (o.parent) group.addTo(o.parent);
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

    function textDialog() {
        const d = needProject();
        const fonts = Object.keys(d.fonts || {});
        if (!fonts.length) throw new Error('No hay fuentes: crea una en UI Settings -> Fonts (o menu UI: Create Font).');
        new Dialog({
            id: 'bb_ui_add_text', title: 'UI: Add Text', width: 480,
            form: {
                text: { label: 'Texto', type: 'textarea', value: 'Hello' },
                font: { label: 'Fuente', type: 'select', options: Object.fromEntries(fonts.map((f) => [f, f])), value: fonts[0] },
                scale: { label: 'Escala (unidades por pixel)', type: 'number', value: 1, min: 0.05, step: 0.05 },
                align: { label: 'Alineacion', type: 'select', options: { left: 'left', center: 'center', right: 'right' }, value: 'center' },
            },
            onConfirm(f) {
                try { addText({ text: f.text, font: f.font, scale: f.scale, align: f.align }); }
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
        const text = String(rec.text || '');
        const lay = core.layoutText(font, text, 'center');
        if (!lay.glyphs.length) throw new Error('Tooltip de ' + bone + ': ningun caracter existe en la fuente.');
        const bb = subtreeBounds(btn, false);
        if (!bb) throw new Error('El boton "' + bone + '" no tiene cubos.');
        let hl = el.highlight ? (Group.all || []).find((g) => g.name === el.highlight) : null;
        if (!hl) {
            const hn = el.highlight && !boneNames().includes(el.highlight) ? el.highlight : uniqueName(bone + '_hl');
            hl = new Group({ name: hn, origin: btn.origin ? btn.origin.slice() : [0, 0, 0] }).init();
            if (btn.parent instanceof Group) hl.addTo(btn.parent);
            acc.groups.push(hl);
            core.set(el, 'highlight', hn);
        }
        const tw = lay.width + 2 * TIP_PAD, th = lay.height + 2 * TIP_PAD;
        let cx = (bb.mn[0] + bb.mx[0]) / 2, cy = (bb.mn[1] + bb.mx[1]) / 2;
        // screen-right = model -X
        if (rec.side === 'izquierda') cx = bb.mx[0] + TIP_GAP + tw / 2;
        else if (rec.side === 'arriba') cy = bb.mx[1] + TIP_GAP + th / 2;
        else if (rec.side === 'abajo') cy = bb.mn[1] - TIP_GAP - th / 2;
        else cx = bb.mn[0] - TIP_GAP - tw / 2;
        const z = bb.mn[2] - 0.4; // in front of the button (the viewer is on the -Z side)
        const tipName = hl.name + '_tip';
        const tip = new Group({ name: tipName, origin: [cx, cy, z] }).init();
        tip.addTo(hl);
        acc.groups.push(tip);
        if (Array.isArray(rec.bg) && rec.bg.length === 4) {
            const q = flatGroup(tipName + '_bg', cx, cy, z, tw, th, rec.bg, tip);
            acc.groups.push(q.group); acc.cubes.push(q.cube);
        }
        const t = buildTextGroup({ name: tipName + '_txt', font, text, scale: 1, align: 'center', cx, cy, z: z - 0.2, parent: tip });
        acc.groups.push(t.group); acc.cubes.push(...t.cubes);
        core.set(rec, 'uuid', tip.uuid);
        return tip;
    }
    // Rebuilds (or removes, when the text is empty) the tooltip of a button. Returns true when a tooltip group exists afterwards.
    function generateTooltip(bone) {
        const d = needProject();
        const rec = tooltipRec(bone);
        const f = core.findBone(d, bone);
        if (!f || !f.element || f.element.type !== 'button') throw new Error('"' + bone + '" no es un boton.');
        const old = findTipGroup(bone);
        const oldG = [], oldC = [];
        if (old) collectTree(old, oldG, oldC);
        const acc = { groups: [], cubes: [] };
        const text = rec ? String(rec.text || '').trim() : '';
        Undo.initEdit({ outliner: true, elements: oldC, groups: oldG });
        try {
            if (old) removeGroupTree(old);
            if (rec && rec.uuid) core.del(rec, 'uuid');
            if (text) tipBuild(d, bone, rec, acc);
        } finally {
            Undo.finishEdit('Generate UI tooltip', { outliner: true, elements: acc.cubes, groups: acc.groups });
            try { Canvas.updateAll(); } catch (e) {}
            touch(); applyVisibility(); applyRoleColors(); syncState();
        }
        return !!text;
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
        const flat = (name, sx, sy, z, w, h, uv, parent) => {
            const q = flatGroup(name, -sx, CY + sy, z, w, h, uv, parent);
            acc.groups.push(q.group); acc.cubes.push(q.cube);
            return q.group;
        };
        const label = (name, text, sx, sy, z, scale, parent) => {
            // the 7px glyphs sit in a block 1.25 lines tall: nudge down to centre them
            const t = buildTextGroup({ name, font: d.fonts[fontName], text, scale, align: 'center', cx: -sx, cy: CY + sy - 0.875 * scale, z, parent });
            if (!t) return null;
            acc.groups.push(t.group); acc.cubes.push(...t.cubes);
            return t.group;
        };
        const tips = [];
        const button = (base, text, sx, sy, w, h, action, tip, side) => {
            const name = uname(base), hl = uname(name + '_hl');
            const g = flat(name, sx, sy, Z, w, h, TPL_UV.button);
            // fit the label inside the button (5px glyphs, 6px advance)
            const tw = text.length * 6 - 1;
            label(name + '_txt', text, sx, sy, Z - 0.4, Math.min(1, (w - 4) / tw, (h - 2) / 7), g);
            flat(hl, sx, sy, Z + 0.2, w + 4, h + 4, TPL_UV.frame);
            if (tip) tips.push({ bone: name, text: tip, side: side || 'derecha' });
            return { bone: name, type: 'button', highlight: hl, action };
        };
        const arrow = (base, uv, sx, sy, action, tip) => {
            const name = uname(base), hl = uname(name + '_hl');
            flat(name, sx, sy, Z, 12, 12, uv);
            flat(hl, sx, sy, Z + 0.2, 16, 16, TPL_UV.frame);
            if (tip) tips.push({ bone: name, text: tip, side: 'arriba' });
            return { bone: name, type: 'button', highlight: hl, action };
        };
        const heading = (base, text, W, H, scale) => {
            const name = uname(base);
            // never wider than the panel (W) minus its border
            const g = label(name, text, 0, H / 2 - 9, Z, Math.min(scale, (W - 12) / (text.length * 6 - 1)), null);
            return g ? g.name : null;
        };

        Undo.initEdit({ outliner: true, elements: [], groups: [] });
        let screens = [], start = 'main', H = 48, W = 104;
        try {
            if (kind === 'menu') {
                const rows = count + 1;
                H = 16 + rows * 12 + 6;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel);
                const scr = { id: 'main', bones: [], elements: [] };
                const t = heading('ui_title', title, W, H, 1.5); if (t) scr.bones.push(t);
                const y0 = H / 2 - 22;
                for (let i = 1; i <= count; i++) scr.elements.push(button('btn_' + i, 'OPCION ' + i, -26, y0 - (i - 1) * 12, 40, 10, { type: 'goto', screen: 'opt_' + i }, 'IR A ' + i));
                scr.elements.push(button('btn_close', 'SALIR', -26, y0 - count * 12, 40, 10, { type: 'close' }, 'CERRAR'));
                scr.default_focus = scr.elements[0].bone;
                screens.push(scr);
                for (let i = 1; i <= count; i++) {
                    const s = { id: 'opt_' + i, bones: [], elements: [] };
                    const tt = heading('opt_' + i + '_title', 'OPCION ' + i, W, H, 1.5); if (tt) s.bones.push(tt);
                    const nt = heading('opt_' + i + '_info', 'EDITA ESTA PANTALLA', W, H - 22, 1); if (nt) s.bones.push(nt);
                    const back = button('opt_' + i + '_back', 'ATRAS', 0, -H / 2 + 14, 40, 10, { type: 'goto', screen: 'main' });
                    s.elements.push(back); s.default_focus = back.bone;
                    screens.push(s);
                }
            } else if (kind === 'book') {
                W = 104; H = 64;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel);
                const by = -H / 2 + 10;
                for (let i = 1; i <= count; i++) {
                    const s = { id: 'page_' + i, bones: [], elements: [] };
                    const tt = heading('p' + i + '_title', title, W, H, 1.5); if (tt) s.bones.push(tt);
                    const bt = heading('p' + i + '_body', 'PAGINA ' + i, W, H - 34, 1); if (bt) s.bones.push(bt);
                    if (i > 1) s.elements.push(arrow('p' + i + '_prev', TPL_UV.arrowL, -36, by, { type: 'goto', screen: 'page_' + (i - 1) }, 'ATRAS'));
                    const close = button('p' + i + '_close', 'CERRAR', 0, by, 40, 10, { type: 'close' }, 'SALIR', 'arriba');
                    s.elements.push(close);
                    if (i < count) s.elements.push(arrow('p' + i + '_next', TPL_UV.arrowR, 36, by, { type: 'goto', screen: 'page_' + (i + 1) }, 'SIGUE'));
                    s.default_focus = i < count ? s.elements[s.elements.length - 1].bone : close.bone;
                    screens.push(s);
                }
                start = 'page_1';
            } else {
                W = 88; H = 48;
                flat(uname('ui_panel'), 0, 0, 0, W, H, TPL_UV.panel);
                const scr = { id: 'main', bones: [], elements: [] };
                const t = heading('ui_title', title, W, H, 1.5); if (t) scr.bones.push(t);
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
                if ((Group.all || []).length) {
                    Blockbench.showMessageBox({
                        title: 'UI: plantilla', icon: 'warning', buttons: ['Continuar', 'Cancelar'], confirm: 0, cancel: 1,
                        message: 'El proyecto ya tiene grupos. La plantilla anade los suyos, reemplaza las pantallas y puede dejar huesos sueltos. Continuar?',
                    }, (i) => { if (i === 0) run(f); });
                } else run(f);
            },
        }).show();
    }

    // ------------------------------------------------------------------ role colours (outliner)
    const ROLE_COLOR = { button: 6, image: 5, number: 1, model: 4, decor: 9, highlight: 8 };
    let colorSig = '';
    function applyRoleColors() {
        const d = getData();
        if (!d) return;
        const role = {};
        for (const s of d.screens || []) {
            for (const b of s.bones || []) role[b] = 'decor';
            for (const e of s.elements || []) { role[e.bone] = e.type; if (e.highlight) role[e.highlight] = 'highlight'; }
        }
        for (const g of Group.all || []) {
            const r = role[g.name];
            if (r) { const c = ROLE_COLOR[r]; if (g.color !== c) g.color = c; g.bbui_colored = true; }
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
        root = String(root || getExportRoot(false)).replace(/\\/g, '/').replace(/\/$/, '');
        if (!root) throw new Error('No hay carpeta de exportacion.');
        const dir = root + '/' + d.id;
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

        const proj = Codecs.project.compile();
        fs.writeFileSync(dir + '/model.bbmodel', typeof proj === 'string' ? proj : JSON.stringify(proj));
        files.push('model.bbmodel');
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
            try { child = cp.spawn('regolith', ['run', profile], { cwd, shell: true, windowsHide: true }); }
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
        const root = opts.root || getExportRoot(false);
        if (!root) throw new Error('No hay carpeta de exportacion.');
        const r = exportTo(root, opts);
        const proj = findRegolithRoot(r.dir);
        if (!proj) {
            const msg = 'Exportado a ' + r.dir + ', pero no se encontro config.json (raiz del proyecto Regolith) subiendo desde esa carpeta.';
            if (!opts.silent) showOutput('Export & Build', false, msg);
            return { ok: false, exported: r, output: msg };
        }
        const profile = opts.profile || state.profile || 'default';
        state.building = true;
        if (!opts.silent) Blockbench.showQuickMessage('regolith run ' + profile + '...', 3000);
        let res;
        try { res = await runRegolith(proj, profile); } finally { state.building = false; }
        const head = '$ regolith run ' + profile + '   (en ' + proj + ')\nExportado: ' + r.dir + '\nCodigo de salida: ' + res.code + '\n\n';
        if (!opts.silent) showOutput('Export & Build', res.ok, head + res.output);
        return Object.assign(res, { exported: r, cwd: proj });
    }
    function exportAndBuildAction() {
        exportAndBuild().catch((e) => {
            if (e.validation) showValidation(e.validation, 'Export & Build: corrige esto primero');
            else showOutput('Export & Build', false, e.message);
        });
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
        back: [], close: [], settings: [],
        command: [{ k: 'command', t: 'text' }, { k: 'as', t: 'select', o: ['player', 'server'] }],
        script: [{ k: 'fn', t: 'text' }, { k: 'args', t: 'json' }],
        set: [{ k: 'key', t: 'text' }, { k: 'value', t: 'value' }],
        add: [{ k: 'key', t: 'text' }, { k: 'amount', t: 'number' }, { k: 'min', t: 'number', opt: true }, { k: 'max', t: 'number', opt: true }],
        open_ui: [{ k: 'ui', t: 'text' }],
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
        '<label class="bbui-chk"><input type="checkbox" v-model="st.showAll" @change="refresh"> Mostrar todo</label> ' +
        '<label class="bbui-chk"><input type="checkbox" v-model="st.showTips" @change="refresh"> Mostrar tooltips</label>' +
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
        '<option v-for="g in groupsOther" :value="g" :selected="g === el.highlight">{{g}}</option></select></div></div>' +
        '<div class="bbui-box"><b>Tooltip</b> <span class="bbui-dim">(aparece con el foco, dentro del highlight)</span>' +
        '<div class="bbui-row"><label>Tooltip</label><input type="text" :value="tipF(\'text\', \'\')" @input="tipSet({ text: $event.target.value })" placeholder="(sin tooltip)"></div>' +
        '<div class="bbui-row"><label>font</label><select @change="tipSet({ font: $event.target.value })"><option v-if="!fontNames.length" value="">(sin fuentes)</option>' +
        '<option v-for="f in fontNames" :value="f" :selected="f === tipF(\'font\', fontNames[0])">{{f}}</option></select></div>' +
        '<div class="bbui-row"><label>side</label><select @change="tipSet({ side: $event.target.value })"><option v-for="s in tipSides" :value="s" :selected="s === tipF(\'side\', \'derecha\')">{{s}}</option></select></div>' +
        '<div class="bbui-row"><label>background</label><button @click="tipPickBg">Elegir fondo</button> <button v-if="tipF(\'bg\', null)" @click="tipSet({ bg: null })">Quitar</button> ' +
        '<span class="bbui-dim">{{tipF(\'bg\', null) ? tipF(\'bg\', null).join(\',\') : \'ninguno\'}}</span></div>' +
        '<button @click="tipGenerate">Generar</button></div></div>' +
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
        '<div class="bbui-box"><b>Cursor</b>' +
        '<div class="bbui-row"><label class="bbui-chk"><input type="checkbox" :checked="cursorOn" @change="setCursorOn($event.target.checked)"> Cursor de raton</label></div>' +
        '<div class="bbui-row"><label>Sensibilidad</label><input type="number" min="0.1" max="5" step="0.1" :disabled="!cursorOn" :value="cursorSens" @change="setCursorSens($event.target.value)"></div>' +
        '<div class="bbui-row"><label>Imagen del cursor</label><select :disabled="!cursorOn" @change="setCursorTex($event.target.value)"><option value="" :selected="!cursorTex">(flecha por defecto)</option>' +
        '<option v-for="t in st.textures" :value="t" :selected="t === cursorTex">{{t}}</option></select></div>' +
        '<div class="bbui-dim">Se exporta como cursor.png; la punta es el pixel de arriba a la izquierda.</div></div>' +
        '<div class="bbui-box"><b>Fonts</b>' +
        '<div v-for="(f, k) in (d.fonts || {})" class="bbui-row"><span style="flex:1">{{k}} <span class="bbui-dim">{{Object.keys(f.glyphs).length}} glifos, glifo max {{f.size[0]}}x{{f.size[1]}} u</span></span><button class="bbui-x" @click="delFont(k)">x</button></div>' +
        '<button @click="newFont">+ Fuente (cuadricula)</button> <button @click="newText">+ Texto</button></div>' +
        '<div class="bbui-box"><label class="bbui-chk"><input type="checkbox" v-model="st.safe" @change="applySafe"> Guia de zona segura (16:9, solo editor)</label></div>' +
        '<div class="bbui-box"><button @click="doValidate">Validar</button> <button @click="doExport">Exportar al pack</button> <button @click="pickRoot">Carpeta...</button><div class="bbui-dim">{{root}}</div>' +
        '<div class="bbui-row"><label>perfil</label><input type="text" :value="st.profile" @change="setProf($event.target.value)"></div>' +
        '<button :disabled="st.building" @click="doBuild">{{st.building ? \'Construyendo...\' : \'Export & Build\'}}</button></div></div>';

    const TPL_ANIMS = '<div class="bbui" v-if="st.data">' +
        '<div class="bbui-dim">Roles que la UI puede animar (CONTRACT 3.1). Crear anade una animacion de Blockbench con el nombre y el loop correctos; Editar abre el modo Animate.</div>' +
        '<div v-for="r in report.rows" :key="r.role" class="bbui-row"><span style="flex:1" :class="{\'bbui-dim\': !r.anim}">{{r.role}}</span>' +
        '<span class="bbui-tag">{{r.anim ? \'existe\' : \'falta\'}}</span>' +
        '<button v-if="!r.anim" @click="create(r.role)">Crear</button><button v-else @click="edit(r.role)">Editar</button></div>' +
        '<div v-if="report.extras.length" class="bbui-box"><b>Avisos</b>' +
        '<div v-for="x in report.extras" :key="x.name" class="bbui-warn">{{x.name}}: {{x.msg}}</div></div></div>';

    // ------------------------------------------------------------------ panels
    function getRootLabel() { try { return localStorage.getItem(STORE_KEY) || '(sin carpeta de exportacion)'; } catch (e) { return ''; } }

    function makePanels() {
        const cond = { formats: [FORMAT_ID], modes: [MODE_ID] };
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
                template: '<div class="bbui-root">' + TPL_SCREENS + '</div>', // fixed root: Blockbench 5 panels need an element even with no data
            },
        }));

        panels.push(new Panel('bb_ui_element', {
            id: 'bb_ui_element', name: 'UI Element', icon: 'smart_button', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                components: { 'bbui-action': actionComp },
                data() {
                    return { st: state, roles: ROLES, dirs: DIRS, ops: OPS, tipSides: TIP_SIDES, roleLabel: { none: 'Ninguno', decor: 'Decoracion de pantalla', button: 'Boton', image: 'Imagen', model: 'Modelo', number: 'Numero' } };
                },
                computed: {
                    info() { return this.st.data && this.st.sel ? core.findBone(this.st.data, this.st.sel) : null; },
                    el() { return this.info && this.info.element; },
                    role() { return !this.info ? 'none' : this.info.decor ? 'decor' : this.info.element.type; },
                    queryNames() { return this.st.data ? Object.keys(this.st.data.queries) : []; },
                    others() { return this.info ? core.buttons(this.info.screen).map((e) => e.bone).filter((b) => b !== this.st.sel) : []; },
                    groupsOther() { return this.st.groups.filter((g) => g !== this.st.sel); },
                    fontNames() { return this.st.data && this.st.data.fonts ? Object.keys(this.st.data.fonts) : []; },
                },
                methods: {
                    touch,
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
                    tipPickBg() { try { pickTooltipBg(this.st.sel); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    tipGenerate() { try { setTooltip(this.st.sel, {}, true); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    setRole(r) {
                        const screenId = this.info ? this.info.screen.id : this.st.activeScreen;
                        core.assignBone(this.st.data, screenId, this.st.sel, r, this.queryNames);
                        touch(); applyRoleColors();
                    },
                    moveTo(id) {
                        const role = this.role, old = this.el ? clone(this.el) : null;
                        core.assignBone(this.st.data, id, this.st.sel, role, this.queryNames);
                        if (old) { const ne = core.findBone(this.st.data, this.st.sel).element; for (const k of Object.keys(old)) core.set(ne, k, old[k]); }
                        touch(); applyRoleColors();
                    },
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
            id: 'bb_ui_settings', name: 'UI Settings', icon: 'settings', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                data() { return { st: state, newOpen: 'item', sources: ['dynamic_property', 'scoreboard', 'script'], soundKeys: ['move', 'accept', 'open', 'close'], root: getRootLabel() }; },
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
                    applySafe() { setSafe(this.st.safe); },
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
            id: 'bb_ui_animations', name: 'UI Animations', icon: 'movie', growable: true, resizable: true, condition: cond, default_position: pos,
            component: {
                data() { return { st: state }; },
                computed: {
                    report() { return this.st.data ? animationReport() : { rows: [], extras: [] }; },
                },
                methods: {
                    create(role) { try { createUiAnimation(role); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                    edit(role) { try { editUiAnimation(role); } catch (e) { Blockbench.showQuickMessage(e.message, 2500); } },
                },
                template: '<div class="bbui-root">' + TPL_ANIMS + '</div>',
            },
        }));
    }

    const CSS = '.bbui{padding:6px;font-size:12px}.bbui-row{display:flex;gap:6px;align-items:center;margin:2px 0}.bbui-row label{flex:0 0 90px;opacity:.8}' +
        '.bbui-row input,.bbui-row select,.bbui-action>select{flex:1;min-width:0}.bbui-box{border:1px solid var(--color-border);border-radius:4px;padding:5px;margin:6px 0}' +
        '.bbui-screen{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:3px}.bbui-screen.active{background:var(--color-selected)}.bbui-name{flex:1;cursor:pointer}' +
        '.bbui-tag{font-size:10px;opacity:.7}.bbui-dim{opacity:.6}.bbui-warn{color:#e8a33d;margin:2px 0}.bbui-chk{display:inline-flex;gap:4px;align-items:center}.bbui-x{padding:0 6px}' +
        '.bbui-seq{margin-left:10px}.bbui-seqitem{display:flex;gap:4px;align-items:flex-start;border-left:2px solid var(--color-border);padding-left:4px;margin:3px 0}' +
        '.bbui-pkwrap{max-height:400px;overflow:auto;border:1px solid var(--color-border);margin:4px 0}.bbui-pkwrap canvas{display:block;image-rendering:pixelated;cursor:crosshair}.bbui-pad{margin-top:6px;text-align:center}.bbui-pad button{min-width:34px;margin:1px}';

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
            mk('add_image', 'UI: Add Image', 'image', imageDialog),
            mk('add_text', 'UI: Add Text', 'text_fields', textDialog),
            mk('add_font', 'UI: Create Font', 'font_download', fontDialog),
            mk('add_plain_image', 'UI: Add Plain Image Slot', 'crop_original', () => addElement('image')),
            mk('add_number', 'UI: Add Number', 'pin', () => addElement('number')),
            mk('add_model', 'UI: Add Model Slot', 'view_in_ar', () => addElement('model')),
            mk('template', 'Nueva UI desde plantilla', 'auto_awesome', templateDialog),
            mk('preview', 'UI: Preview navigation', 'gamepad', () => { syncState(); if (state.preview.on) previewStop(); else previewStart(); }),
            mk('validate', 'UI: Validate', 'rule', () => showValidation(validate())),
            mk('export', 'UI: Export to pack', 'upload', exportAction),
            mk('export_build', 'UI: Export & Build', 'build', exportAndBuildAction),
            mk('build_profile', 'UI: Set build profile', 'tune', () => Blockbench.textPrompt('Perfil de regolith (regolith run <perfil>)', state.profile, (v) => setProfile(v))),
            mk('safe_zone', 'UI: Toggle safe-zone guide', 'crop_free', () => setSafe(!state.safe)),
            mk('role_colors', 'UI: Refresh role colours', 'palette', applyRoleColors),
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

    // ------------------------------------------------------------------ mode
    // Fourth editor tab ("UI"), next to Edit / Paint / Animate: the UI panels live here, with the outliner and textures.
    function registerMode() {
        if (typeof Mode === 'undefined') return;
        modeObj = new Mode(MODE_ID, {
            name: 'UI',
            icon: 'dashboard_customize',
            default_tool: 'move_tool',
            category: 'navigate',
            condition: () => isUi(),
            onSelect() { try { syncState(); applyVisibility(); } catch (e) {} },
            onUnselect() { try { if (state.preview.on) previewStop(); } catch (e) {} },
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

    function poll() {
        try { trackRenames(); } catch (e) { console.warn('BB UI Builder: rename tracking', e); }
        try { syncState(); } catch (e) {}
        try { processTextures(); } catch (e) {}
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
            Blockbench.on('add_texture', onAddTexture);
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
                applyTemplate, generateTooltip, setTooltip, createUiAnimation, editUiAnimation,
                previewMove, previewAccept, bonePositions,
                safeZoneInfo: () => (safeObj ? clone(safeObj.bbui_info) : null),
                validate,
                core,
            };
            poll();
        },
        onunload() {
            const step = (f) => { try { f(); } catch (e) { console.warn('BB UI Builder unload:', e); } };
            step(() => Blockbench.removeListener('add_texture', onAddTexture));
            step(() => clearInterval(pollTimer));
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
