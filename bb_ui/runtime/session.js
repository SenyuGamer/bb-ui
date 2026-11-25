// BB UI sessions: one per player, one display entity per session.
import { world, system, InputPermissionCategory } from "@minecraft/server";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import { getQueryNumber, evalCondition, substituteQueries } from "./queries.js";
import { nextFocus, visibleButtons } from "./nav.js";
import { runAction } from "./actions.js";

// getMovementVector(): x > 0 is a strafe to the LEFT (A key). Flip this constant if it turns out mirrored in game.
export const MOVE_X_POSITIVE_IS_LEFT = true;
export const MOVE_THRESHOLD = 0.5;
export const MOVE_DELAY_TICKS = 4;
export const REFRESH_TICKS = 10;
const INPUT_GRACE_TICKS = 5; // ignore Jump/Sneak right after opening (the opening click/jump)
const CAMERA_EASE_SECONDS = 0.3;

/** @type {Map<string, any>} playerId -> session */
export const sessions = new Map();
const metaCache = new Map();
let tickCount = 0;

function meta(def) {
    let m = metaCache.get(def.id);
    if (m) return m;
    m = { screenById: {}, numbers: [], conds: [] };
    for (const s of def.screens ?? []) m.screenById[s.id] = s;
    const seen = new Set();
    for (const s of def.screens ?? []) {
        for (const el of s.elements ?? []) {
            if (seen.has(el.bone)) continue;
            seen.add(el.bone);
            if (el.type === "number" && def.numbers?.[el.bone] !== undefined)
                m.numbers.push({ k: def.numbers[el.bone], query: el.query });
            if (el.visible_if && def.conditions?.[el.bone] !== undefined)
                m.conds.push({ k: def.conditions[el.bone], cond: el.visible_if });
        }
    }
    metaCache.set(def.id, m);
    return m;
}

export function getSession(player) {
    return sessions.get(player.id);
}

function play(session, key) {
    const snd = session.def.display?.sounds?.[key];
    if (!snd) return;
    try {
        session.player.playSound(snd);
    } catch {}
}

// ---------- properties ----------
function setProp(session, name, value) {
    if (session.props.get(name) === value) return;
    const { player, entity, def } = session;
    player.setPropertyOverrideForEntity(entity, `${def.namespace}:${name}`, value);
    session.props.set(name, value);
}

function applyAllProps(session) {
    const { def, player } = session;
    const m = session.meta;
    setProp(session, "viewer", true);
    setProp(session, "screen", def.screenIndex[session.screenId] ?? 0);
    setProp(session, "focus", session.focus);
    for (const n of m.numbers) setProp(session, `n${n.k}`, getQueryNumber(player, def, n.query));
    for (const c of m.conds) setProp(session, `v${c.k}`, evalCondition(player, def, c.cond));
}

function updateActionbar(session) {
    const text = session.def.screens
        ? session.meta.screenById[session.screenId]?.actionbar
        : undefined;
    if (!text) return;
    session.player.onScreenDisplay.setActionBar(substituteQueries(text, session.player, session.def));
}

export function refreshSession(session) {
    if (!session.active) return;
    const { def, player } = session;
    const m = session.meta;
    for (const n of m.numbers) setProp(session, `n${n.k}`, getQueryNumber(player, def, n.query));
    for (const c of m.conds) setProp(session, `v${c.k}`, evalCondition(player, def, c.cond));
    // keep focus on a visible button
    const vis = visibleButtons(session);
    if (vis.length && !vis.includes(session.focus)) setFocus(session, vis[0], false);
    setProp(session, "focus", session.focus);
    updateActionbar(session);
}

function setFocus(session, idx, sound = true) {
    if (idx === session.focus) return;
    session.focus = idx;
    setProp(session, "focus", idx);
    if (sound) play(session, "move");
}

function defaultFocus(session) {
    const bones = session.def.buttons?.[session.screenId] ?? [];
    const screen = session.meta.screenById[session.screenId];
    const vis = visibleButtons(session);
    const want = screen?.default_focus ? bones.indexOf(screen.default_focus) : -1;
    if (want >= 0 && vis.includes(want)) return want;
    return vis.length ? vis[0] : 0;
}

// ---------- screens ----------
export function gotoScreen(session, screenId, push = true) {
    if (!session.active) return false;
    if (session.def.screenIndex?.[screenId] === undefined) {
        console.warn(`[bb_ui] unknown screen '${screenId}' in UI '${session.id}'`);
        return false;
    }
    if (push && screenId !== session.screenId) session.stack.push(session.screenId);
    session.screenId = screenId;
    session.focus = defaultFocus(session);
    setProp(session, "screen", session.def.screenIndex[screenId]);
    setProp(session, "focus", session.focus);
    refreshSession(session);
    return true;
}

export function backScreen(session) {
    if (!session.stack.length) return closeSession(session, "back");
    gotoScreen(session, session.stack.pop(), false);
}

// ---------- geometry ----------
function horizontalDir(player) {
    const v = player.getViewDirection();
    const len = Math.hypot(v.x, v.z);
    if (len > 1e-3) return { x: v.x / len, z: v.z / len };
    const yaw = (player.getRotation().y * Math.PI) / 180;
    return { x: -Math.sin(yaw), z: Math.cos(yaw) };
}

function computeLayout(player, display, source) {
    const head = player.getHeadLocation();
    const dist = display.distance ?? 2.5;
    const height = display.height ?? 0;
    if (display.anchor === "trigger" && (source?.block || source?.entity)) {
        let c;
        if (source.block) {
            const l = source.block.location;
            c = { x: l.x + 0.5, y: l.y + 1 + height, z: l.z + 0.5 };
        } else {
            const l = source.entity.location;
            c = { x: l.x, y: l.y + height, z: l.z };
        }
        let dx = head.x - c.x;
        let dz = head.z - c.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        const cam = { x: c.x + dx * dist, y: c.y, z: c.z + dz * dist };
        return { entityLoc: c, camLoc: cam };
    }
    const d = horizontalDir(player);
    const e = { x: head.x + d.x * dist, y: head.y + height, z: head.z + d.z * dist };
    return { entityLoc: e, camLoc: head };
}

function applyCamera(session, camLoc, entityLoc) {
    const { player, def } = session;
    player.camera.setCamera("minecraft:free", {
        location: camLoc,
        facingLocation: entityLoc,
        easeOptions: { easeTime: CAMERA_EASE_SECONDS },
    });
    if (def.display?.fov) player.camera.setFov({ fov: def.display.fov });
}

// ---------- open / close ----------
export function openSession(player, id, opts = {}) {
    const def = UI_REGISTRY[id];
    if (!def) {
        console.warn(`[bb_ui] unknown UI '${id}'`);
        return undefined;
    }
    if (sessions.has(player.id)) return undefined;
    const display = def.display ?? {};
    const { entityLoc, camLoc } = computeLayout(player, display, opts.source);
    const entity = player.dimension.spawnEntity(def.entity, entityLoc);
    const session = {
        id,
        def,
        meta: meta(def),
        player,
        entity,
        active: true,
        screenId: def.start_screen,
        stack: [],
        focus: 0,
        props: new Map(),
        openedTick: tickCount,
        lastDir: null,
        lastMoveTick: -1000,
        reapplyAt: tickCount + 3,
        previousScreens: [],
    };
    sessions.set(player.id, session);
    try {
        entity.addTag(`bb_ui:${player.id}`);
        entity.teleport(entityLoc, { facingLocation: { x: camLoc.x, y: entityLoc.y, z: camLoc.z } });
        session.focus = defaultFocus(session);
        applyAllProps(session);
        applyCamera(session, camLoc, entityLoc);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, false);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, false);
        updateActionbar(session);
        play(session, "open");
    } catch (e) {
        console.warn(`[bb_ui] open failed: ${e}`);
        closeSession(session, "error");
        return undefined;
    }
    return session;
}

export function closeSession(session, reason = "close", { entityDeferred = false } = {}) {
    if (!session.active) return true;
    session.active = false;
    if (sessions.get(session.player.id) === session) sessions.delete(session.player.id);
    const { player, entity } = session;
    const alive = (() => {
        try {
            return player.isValid;
        } catch {
            return false;
        }
    })();
    if (alive) {
        try { player.camera.clear(); } catch {}
        try { player.camera.setFov(); } catch {}
        try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true); } catch {}
        try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, true); } catch {}
        try { player.onScreenDisplay.setActionBar(""); } catch {}
        try { player.removePropertyOverrideForEntity(entity, `${session.def.namespace}:viewer`); } catch {}
        if (reason !== "error") play(session, "close");
    }
    const kill = () => {
        try { if (entity.isValid) entity.remove(); } catch {}
    };
    if (entityDeferred) system.run(kill);
    else kill();
    return true;
}

// ---------- input ----------
export function acceptFocus(session) {
    if (!session.active) return;
    if (tickCount - session.openedTick < INPUT_GRACE_TICKS) return;
    const bone = (session.def.buttons?.[session.screenId] ?? [])[session.focus];
    if (!bone) return;
    const screen = session.meta.screenById[session.screenId];
    const el = screen?.elements?.find((e) => e.bone === bone && e.type === "button");
    if (!el || !evalCondition(session.player, session.def, el.visible_if)) return;
    play(session, "accept");
    runAction(session, el.action, bone);
}

export function exitPressed(session) {
    if (!session.active) return;
    if (tickCount - session.openedTick < INPUT_GRACE_TICKS) return;
    closeSession(session, "sneak");
}

function readDir(player) {
    const v = player.inputInfo.getMovementVector();
    const ax = Math.abs(v.x);
    const ay = Math.abs(v.y);
    if (ay > MOVE_THRESHOLD && ay >= ax) return v.y > 0 ? "up" : "down";
    if (ax > MOVE_THRESHOLD) return (v.x > 0) === MOVE_X_POSITIVE_IS_LEFT ? "left" : "right";
    return null;
}

function tickSession(session) {
    const { player, entity } = session;
    if (!player.isValid || !entity.isValid) {
        closeSession(session, "invalid");
        return;
    }
    if (tickCount >= session.reapplyAt && session.reapplyAt > 0) {
        session.reapplyAt = 0;
        session.props.clear(); // re-send everything once, in case the entity was not synced yet
        applyAllProps(session);
    }
    const dir = readDir(player);
    if (dir === null) session.lastDir = null;
    else if (dir !== session.lastDir && tickCount - session.lastMoveTick >= MOVE_DELAY_TICKS) {
        session.lastDir = dir;
        session.lastMoveTick = tickCount;
        setFocus(session, nextFocus(session, dir));
    }
    if (tickCount % REFRESH_TICKS === 0) refreshSession(session);
}

export function tickSessions() {
    tickCount++;
    for (const session of [...sessions.values()]) {
        try {
            tickSession(session);
        } catch (e) {
            console.warn(`[bb_ui] session error, closing: ${e}`);
            try { closeSession(session, "error"); } catch {}
        }
    }
}

// ---------- cleanup ----------
export function removeOrphans() {
    for (const id of ["overworld", "nether", "the_end"]) {
        try {
            for (const e of world.getDimension(id).getEntities({ families: ["bb_ui"] })) {
                try { e.remove(); } catch {}
            }
        } catch {}
    }
}

/** Remove display entities tagged for this player (stale from a previous session). */
export function removeEntitiesOf(playerId) {
    for (const id of ["overworld", "nether", "the_end"]) {
        try {
            for (const e of world.getDimension(id).getEntities({ tags: [`bb_ui:${playerId}`] })) {
                try { e.remove(); } catch {}
            }
        } catch {}
    }
}

export function dropSessionOnLeave(playerId) {
    const s = sessions.get(playerId);
    if (!s) return;
    s.active = false;
    sessions.delete(playerId);
    const entity = s.entity;
    system.run(() => {
        try { if (entity.isValid) entity.remove(); } catch {}
    });
}
