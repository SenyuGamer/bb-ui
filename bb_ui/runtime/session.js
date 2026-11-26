// BB UI sessions: one per player, one display entity per session.
import { world, system, InputPermissionCategory, InputMode, HudElement, HudVisibility } from "@minecraft/server";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import { getQueryNumber, evalCondition, substituteQueries } from "./queries.js";
import { nextFocus, visibleButtons, MODEL_RIGHT_SIGN } from "./nav.js";
import { runAction } from "./actions.js";

// getMovementVector(): x > 0 is a strafe to the LEFT (A key). Flip this constant if it turns out mirrored in game.
export const MOVE_X_POSITIVE_IS_LEFT = true;
export const MOVE_THRESHOLD = 0.5;
export const MOVE_DELAY_TICKS = 4;
export const REFRESH_TICKS = 10;
const INPUT_GRACE_TICKS = 5; // ignore Jump/Sneak right after opening (the opening click/jump)
const CAMERA_EASE_SECONDS = 0.3;
const CAMERA_FORWARD = 0.6; // blocks in front of the eyes, out of the player's head
const BACKDROP_MARGIN = 0.08; // the backdrop quad sits this far in front of the camera
// Mouse cursor (keyboard + mouse): turning the view this many degrees moves the cursor across the whole UI width
// (times display.cursor.sensitivity). The player's pitch is pulled back to 0 past CURSOR_PITCH_LIMIT.
const CURSOR_DEG_SPAN = 120;
const CURSOR_PITCH_LIMIT = 45;
// After the pitch is pulled back, the client may still report the old rotation for a few ticks: ignore deltas meanwhile,
// and treat any single-tick turn larger than this as a resync, not as mouse movement.
const CURSOR_RESYNC_TICKS = 4;
const CURSOR_MAX_STEP_DEG = 35;
// per-player multiplier of the cursor speed (settings form)
export const CURSOR_SENS_KEY = "bb_ui:cursor_sens";
export const CURSOR_SENS_MIN = 0.2;
export const CURSOR_SENS_MAX = 3;

export const SCALE_KEY = "bb_ui:scale";
const CALIB_MIN = 0.5;
const CALIB_MAX = 2.0;
const CALIB_STEP = 0.02;
const CALIB_REPEAT_TICKS = 3;
const CALIB_TEXT = "W/S: tamaño  ·  Saltar: guardar  ·  Agachar: por defecto";
const DEFAULT_FADE = { in: 0.15, hold: 0.3, out: 0.35, color: "#000000" }; // hold covers the client camera settling
// Closes that fade out; death, leave, error, invalid entity, open_ui and respawn clean up immediately.
const FADE_CLOSE_REASONS = new Set(["sneak", "action", "back", "api", "close"]);
// Every HudElement except TouchControls (needed for Jump/Sneak on mobile). The actionbar is not a HudElement, so it stays.
const HUD_HIDDEN = [
    "PaperDoll", "Armor", "ToolTips", "Crosshair", "Hotbar", "Health", "ProgressBar",
    "Hunger", "AirBubbles", "HorseHealth", "StatusEffects", "ItemText",
].map((n) => HudElement[n]).filter((v) => v !== undefined);

/** @type {Map<string, any>} playerId -> session */
export const sessions = new Map();
const metaCache = new Map();
const lastUi = new Map(); // playerId -> id of the last UI opened
export const getLastUiId = (playerId) => lastUi.get(playerId);
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

/** Everything except `viewer`: sent right after spawning (overrides reach the client late), before the UI becomes visible. */
function applyEarlyProps(session) {
    const { def, player } = session;
    const m = session.meta;
    setProp(session, "yaw", session.yaw);
    setProp(session, "screen", def.screenIndex[session.screenId] ?? 0);
    setProp(session, "focus", session.focus);
    if (def.display?.calibrate !== false) setProp(session, "calib", session.calib);
    if (def.display?.backdrop !== false) setProp(session, "bd", session.bd);
    if (def.cursor) {
        if (session.mouse) pushCursor(session);
        else setProp(session, "cur", false);
    }
    for (const n of m.numbers) setProp(session, `n${n.k}`, getQueryNumber(player, def, n.query));
    for (const c of m.conds) setProp(session, `v${c.k}`, evalCondition(player, def, c.cond));
}

function applyAllProps(session) {
    setProp(session, "viewer", true);
    applyEarlyProps(session);
}

/**
 * Value of NS:yaw: yaw (degrees, Entity.getRotation().y convention: forward = (-sin, cos)) the entity would have if it
 * faced the camera horizontally. The body stays at yaw 0; the RP turns the root bone with this value.
 */
function yawToward(entityLoc, camLoc) {
    const dx = camLoc.x - entityLoc.x;
    const dz = camLoc.z - entityLoc.z;
    if (Math.hypot(dx, dz) < 1e-6) return 0.0001;
    return Math.round(((Math.atan2(-dx, dz) * 180) / Math.PI) * 1000) / 1000 || 0.0001;
}

// Entity body yaw is never changed (a rotation change is interpolated by the client over seconds).
const FIXED_ROTATION = { x: 0, y: 0 };

/**
 * Value of NS:bd: blocks from the entity origin to the camera along the view (horizontal, the entity faces the camera
 * horizontally), minus a margin so the backdrop quad sits just in front of the camera.
 */
function backdropOffset(entityLoc, camLoc) {
    return Math.min(16, Math.max(0, Math.round((Math.hypot(entityLoc.x - camLoc.x, entityLoc.z - camLoc.z) - BACKDROP_MARGIN) * 1000) / 1000));
}

function updateActionbar(session) {
    if (!session.revealed) return;
    if (session.calib) {
        session.player.onScreenDisplay.setActionBar(CALIB_TEXT);
        return;
    }
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
    clearPress(session);
    refreshSession(session);
    if (session.mouse) {
        session.hover = hoverIndex(session);
        if (session.hover >= 0) setFocus(session, session.hover, false);
    }
    return true;
}

/** Ends the press animation window (NS:press back to 0). Only exists when the UI has press.* animations. */
function clearPress(session) {
    if (!session.pressUntil) return;
    session.pressUntil = 0;
    setProp(session, "press", 0);
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

function computeLayout(player, def, source, scale = 1) {
    const display = def.display ?? {};
    const head = player.getHeadLocation();
    const dist = (display.distance ?? 2.5) / scale;
    const height = display.height ?? 0;
    const centerY = def.centerY ?? 0;
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
        const mid = c.y + centerY;
        const cam = { x: c.x + dx * dist, y: mid, z: c.z + dz * dist };
        return { entityLoc: c, camLoc: cam, faceLoc: { x: c.x, y: mid, z: c.z } };
    }
    const d = horizontalDir(player);
    // The camera sits CAMERA_FORWARD in front of the eyes: inside the head the game dithers the player's own model.
    // `distance` is measured from the camera; `height` is the offset of the panel CENTER from the eyes.
    const cam = { x: head.x + d.x * CAMERA_FORWARD, y: head.y, z: head.z + d.z * CAMERA_FORWARD };
    const e = { x: cam.x + d.x * dist, y: head.y + height - centerY, z: cam.z + d.z * dist };
    return { entityLoc: e, camLoc: cam, faceLoc: { x: e.x, y: e.y + centerY, z: e.z } };
}

function applyCamera(session, camLoc, faceLoc, easeTime = CAMERA_EASE_SECONDS) {
    const { player, def } = session;
    session.camLoc = camLoc;
    const opts = { location: camLoc, facingLocation: faceLoc };
    if (easeTime > 0) opts.easeOptions = { easeTime }; // no easeOptions at all = instant cut (hidden by the fade)
    player.camera.setCamera("minecraft:free", opts);
    if (def.display?.fov) player.camera.setFov({ fov: def.display.fov });
}

// ---------- fade / hud / scale helpers ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round(v * 100) / 100;

function hexToRgb(hex) {
    const n = (i) => parseInt(String(hex).slice(i, i + 2), 16) / 255;
    return { red: n(1), green: n(3), blue: n(5) };
}

/** display.fade merged with defaults, or null when disabled. */
function fadeConfig(def) {
    const f = def.display?.fade;
    if (f === false) return null;
    const c = { ...DEFAULT_FADE, ...(f && typeof f === "object" ? f : {}) };
    return {
        options: {
            fadeTime: { fadeInTime: c.in, holdTime: c.hold, fadeOutTime: c.out },
            fadeColor: hexToRgb(c.color),
        },
        // ticks until the screen is fully black (middle of the hold)
        blackTicks: Math.max(1, Math.round((c.in + c.hold / 2) * 20)),
    };
}

function isAlive(player) {
    try {
        return player.isValid;
    } catch {
        return false;
    }
}

/** Saved calibration scale of a player (clamped), or undefined. */
export function readScale(player) {
    const v = player.getDynamicProperty(SCALE_KEY);
    return typeof v === "number" && Number.isFinite(v) ? clamp(v, CALIB_MIN, CALIB_MAX) : undefined;
}

export function calibrationEnabled(def) {
    return def.display?.calibrate !== false;
}

// ---------- open / close ----------
/** Visual part of opening (props, camera, HUD, actionbar). Runs after the fade-in when fading. */
function reveal(session, fading) {
    if (!session.active || session.revealed) return;
    session.revealed = true;
    const { player, def } = session;
    session.reapplyAt = tickCount + 3;
    session.props.clear();
    applyAllProps(session);
    applyCamera(session, session.camLoc, session.faceLoc, fading ? 0 : CAMERA_EASE_SECONDS);
    if (def.display?.hide_hud !== false) {
        try {
            player.onScreenDisplay.setHudVisibility(HudVisibility.Hide, HUD_HIDDEN);
            session.hudHidden = true;
        } catch (e) {
            console.warn(`[bb_ui] hide HUD failed: ${e}`);
        }
    }
    updateActionbar(session);
    play(session, "open");
}

/**
 * opts: { source?, calibrate? (force calibration), fade? (false: no fade-in) }
 */
export function openSession(player, id, opts = {}) {
    const def = UI_REGISTRY[id];
    if (!def) {
        console.warn(`[bb_ui] unknown UI '${id}'`);
        return undefined;
    }
    if (sessions.has(player.id)) return undefined;
    const calibOn = calibrationEnabled(def);
    const saved = calibOn ? readScale(player) : undefined;
    const calib = calibOn && (opts.calibrate === true || saved === undefined);
    const scale = saved ?? 1;
    const { entityLoc, camLoc, faceLoc } = computeLayout(player, def, opts.source, scale);
    const entity = player.dimension.spawnEntity(def.entity, entityLoc, { initialRotation: 0 });
    const fade = opts.fade === false ? null : fadeConfig(def);
    const session = {
        id,
        def,
        meta: meta(def),
        player,
        entity,
        active: true,
        revealed: false,
        hudHidden: false,
        scale,
        calib,
        camLoc,
        faceLoc,
        bd: backdropOffset(entityLoc, camLoc),
        yaw: yawToward(entityLoc, camLoc),
        screenId: def.start_screen,
        stack: [],
        focus: 0,
        props: new Map(),
        openedTick: tickCount,
        lastDir: null,
        lastMoveTick: -1000,
        reapplyAt: 0,
        previousScreens: [],
        source: opts.source,
        anchor: { loc: { ...player.location }, dim: player.dimension.id },
    };
    sessions.set(player.id, session);
    lastUi.set(player.id, id);
    try {
        entity.addTag(`bb_ui:${player.id}`);
        entity.teleport(entityLoc, { rotation: FIXED_ROTATION });
        session.focus = defaultFocus(session);
        applyEarlyProps(session); // yaw, bd, screen, focus, ...: before the fade reaches black; `viewer` waits for the reveal
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, false);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, false);
        if (fade) {
            player.camera.fade(fade.options);
            system.runTimeout(() => {
                try {
                    reveal(session, true);
                } catch (e) {
                    console.warn(`[bb_ui] open failed: ${e}`);
                    closeSession(session, "error");
                }
            }, fade.blackTicks);
        } else {
            reveal(session, false);
        }
    } catch (e) {
        console.warn(`[bb_ui] open failed: ${e}`);
        closeSession(session, "error");
        return undefined;
    }
    return session;
}

export function closeSession(session, reason = "close", { entityDeferred = false, noAnim = false } = {}) {
    if (!session.active) return true;
    const clean = FADE_CLOSE_REASONS.has(reason);
    if (session.closing && clean && !noAnim) return true; // closing animation already running
    // close animation (animations.json "close"): keep the entity closeTicks with NS:closing = true, then close normally
    if (!noAnim && clean && (session.def.closeTicks ?? 0) > 0 && session.revealed && isAlive(session.player)) {
        let started = false;
        try {
            if (session.entity.isValid) {
                setProp(session, "closing", true);
                started = true;
            }
        } catch {}
        if (started) {
            session.closing = true;
            system.runTimeout(() => {
                try {
                    closeSession(session, reason, { entityDeferred, noAnim: true });
                } catch (e) {
                    console.warn(`[bb_ui] close failed: ${e}`);
                }
            }, session.def.closeTicks);
            return true;
        }
    }
    session.active = false;
    if (sessions.get(session.player.id) === session) sessions.delete(session.player.id);
    const { player, entity, def } = session;
    const alive = isAlive(player);
    const fade = alive && session.revealed && FADE_CLOSE_REASONS.has(reason) ? fadeConfig(def) : null;
    // camera / FOV / HUD / actionbar / per-viewer entity visibility
    const restoreVisual = () => {
        if (!isAlive(player)) return;
        // a new session already took over the camera, HUD and actionbar (fast reopen during the fade): leave them
        if (!sessions.has(player.id)) {
            try { player.camera.clear(); } catch {}
            try { player.camera.setFov(); } catch {}
            if (session.hudHidden) {
                try { player.onScreenDisplay.resetHudElementsVisibility(); } catch {}
            }
            try { player.onScreenDisplay.setActionBar(""); } catch {}
        }
        try { player.removePropertyOverrideForEntity(entity, `${def.namespace}:viewer`); } catch {}
    };
    const kill = () => {
        try { if (entity.isValid) entity.remove(); } catch {}
    };
    if (alive) {
        try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true); } catch {}
        try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, true); } catch {}
        if (reason !== "error") play(session, "close");
    }
    if (fade) {
        try { player.camera.fade(fade.options); } catch {}
        system.runTimeout(() => {
            restoreVisual();
            kill();
        }, fade.blackTicks);
        return true;
    }
    restoreVisual();
    if (entityDeferred) system.run(kill);
    else kill();
    return true;
}

// ---------- calibration ----------
/** Re-places the entity (and the camera for trigger anchors) for a new scale. */
function applyScale(session, scale) {
    const { player, def, entity } = session;
    session.scale = scale;
    const { entityLoc, camLoc, faceLoc } = computeLayout(player, def, session.source, scale);
    entity.teleport(entityLoc, { rotation: FIXED_ROTATION });
    const c = session.camLoc;
    session.faceLoc = faceLoc;
    session.bd = backdropOffset(entityLoc, camLoc);
    session.yaw = yawToward(entityLoc, camLoc);
    setProp(session, "yaw", session.yaw);
    if (def.display?.backdrop !== false) setProp(session, "bd", session.bd);
    if (Math.hypot(c.x - camLoc.x, c.y - camLoc.y, c.z - camLoc.z) > 1e-4 || def.display?.anchor === "trigger") {
        applyCamera(session, camLoc, faceLoc, 0);
    } else {
        session.camLoc = camLoc;
    }
}

function finishCalibration(session, scale) {
    const { player } = session;
    scale = round2(clamp(scale, CALIB_MIN, CALIB_MAX));
    if (scale !== session.scale) applyScale(session, scale);
    player.setDynamicProperty(SCALE_KEY, scale);
    session.calib = false;
    session.openedTick = tickCount; // the Jump/Sneak that ended calibration must not also act on the UI
    setProp(session, "calib", false);
    if (session.mouse) {
        session.cursorHidden = false;
        pushCursor(session);
    }
    play(session, "accept");
    updateActionbar(session);
    refreshSession(session);
}

function calibrationTick(session) {
    if (!session.revealed) return;
    const dir = readDir(session.player);
    if (dir !== "up" && dir !== "down") return;
    if (tickCount - session.lastMoveTick < CALIB_REPEAT_TICKS) return;
    session.lastMoveTick = tickCount;
    const next = round2(clamp(session.scale + (dir === "up" ? CALIB_STEP : -CALIB_STEP), CALIB_MIN, CALIB_MAX));
    if (next !== session.scale) applyScale(session, next);
}

// ---------- mouse cursor ----------
export function readCursorSens(player) {
    const v = Number(player.getDynamicProperty(CURSOR_SENS_KEY));
    return Number.isFinite(v) && v > 0 ? clamp(v, CURSOR_SENS_MIN, CURSOR_SENS_MAX) : 1;
}

/** After the settings form: new sensitivity, and optionally re-enter calibration in place. */
export function applySettings(session, { recalibrate = false } = {}) {
    if (!session.active) return;
    session.sens = readCursorSens(session.player);
    session.prevRot = undefined;
    session.cursorSkipUntil = tickCount + CURSOR_RESYNC_TICKS;
    if (recalibrate && calibrationEnabled(session.def)) {
        session.calib = true;
        session.openedTick = tickCount; // the click that closed the form must not end calibration
        setProp(session, "calib", true);
        if (session.def.cursor) setProp(session, "cur", false);
        updateActionbar(session);
    }
}

function mouseWanted(session) {
    if (!session.def.cursor) return false;
    try {
        return session.player.inputInfo.lastInputModeUsed === InputMode.KeyboardAndMouse;
    } catch {
        return false;
    }
}

function pushCursor(session) {
    setProp(session, "cx", Math.round(session.cx * 100) / 100);
    setProp(session, "cy", Math.round(session.cy * 100) / 100);
    setProp(session, "cur", !session.cursorHidden);
}

/** Puts the cursor on the centre of the focused button (or of the UI). */
function cursorToFocus(session) {
    const { def } = session;
    const bone = (def.buttons?.[session.screenId] ?? [])[session.focus];
    const r = bone && def.cursor.rects?.[bone];
    const b = def.cursor.bounds;
    session.cx = r ? (r[0] + r[2]) / 2 : (b[0] + b[2]) / 2;
    session.cy = r ? (r[1] + r[3]) / 2 : (b[1] + b[3]) / 2;
}

function enterMouse(session) {
    session.mouse = true;
    session.cursorHidden = false;
    // the view stays on the UI camera; with Camera input on, the mouse turns the player and that drives the cursor
    try { session.player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true); } catch {}
    session.prevRot = session.player.getRotation();
    session.sens = readCursorSens(session.player);
    cursorToFocus(session);
    session.hover = hoverIndex(session);
    pushCursor(session);
}

function leaveMouse(session) {
    session.mouse = false;
    session.hover = -1;
    try { session.player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, false); } catch {}
    setProp(session, "cur", false);
}

/** Index (into def.buttons[screen]) of the visible button under the cursor, or -1. Hit areas include a margin, so they can
 * overlap: the button whose centre is nearest (relative to its size) wins. */
function hoverIndex(session) {
    const { def } = session;
    if (!def.cursor) return -1;
    const bones = def.buttons?.[session.screenId] ?? [];
    let best = -1;
    let bestArea = Infinity;
    for (const i of visibleButtons(session)) {
        const r = def.cursor.rects?.[bones[i]];
        if (!r) continue;
        if (session.cx < r[0] || session.cx > r[2] || session.cy < r[1] || session.cy > r[3]) continue;
        const dx = (session.cx - (r[0] + r[2]) / 2) / (r[2] - r[0] || 1);
        const dy = (session.cy - (r[1] + r[3]) / 2) / (r[3] - r[1] || 1);
        const d = dx * dx + dy * dy;
        if (d < bestArea) {
            bestArea = d;
            best = i;
        }
    }
    return best;
}

function cursorTick(session) {
    const { player, def } = session;
    if (session.formOpen) return;
    const rot = player.getRotation();
    const prev = session.prevRot ?? rot;
    session.prevRot = rot;
    if (tickCount < (session.cursorSkipUntil ?? 0)) return; // waiting for the client to catch up with a recentre
    const dYaw = ((((rot.y - prev.y) % 360) + 540) % 360) - 180;
    const dPitch = rot.x - prev.x;
    if (Math.abs(rot.x) > CURSOR_PITCH_LIMIT) {
        // keep the pitch away from +-90, where the mouse stops turning the player
        try {
            player.teleport(player.location, { keepVelocity: false, rotation: { x: 0, y: rot.y } });
            session.prevRot = undefined;
            session.cursorSkipUntil = tickCount + CURSOR_RESYNC_TICKS;
        } catch {}
    }
    if (Math.abs(dYaw) < 1e-3 && Math.abs(dPitch) < 1e-3) return;
    if (Math.abs(dYaw) > CURSOR_MAX_STEP_DEG || Math.abs(dPitch) > CURSOR_MAX_STEP_DEG) return; // a resync, not the mouse
    session.cursorHidden = false; // the mouse moved: show the cursor again (WASD hides it)
    const b = def.cursor.bounds;
    const k = ((b[2] - b[0]) / CURSOR_DEG_SPAN) * (def.cursor.sensitivity ?? 1) * (session.sens ?? 1);
    // turning right raises the yaw; looking down raises the pitch
    session.cx = clamp(session.cx + dYaw * k * MODEL_RIGHT_SIGN, b[0], b[2]);
    session.cy = clamp(session.cy - dPitch * k, b[1], b[3]);
    pushCursor(session);
    const h = hoverIndex(session);
    session.hover = h;
    if (h >= 0 && h !== session.focus) setFocus(session, h);
}

/** Left/right click with the mouse: presses the button under the cursor. */
export function mouseClick(session) {
    if (!session.active || session.closing || !session.mouse) return;
    if (session.calib) {
        acceptFocus(session);
        return;
    }
    // cursor hidden by WASD: the click presses the button chosen with the keys
    if (session.cursorHidden || (session.hover >= 0 && session.hover === session.focus)) acceptFocus(session);
}

// ---------- input ----------
export function acceptFocus(session) {
    if (!session.active || session.closing) return;
    if (tickCount - session.openedTick < INPUT_GRACE_TICKS) return;
    if (session.calib) {
        if (session.revealed) finishCalibration(session, session.scale);
        return;
    }
    const bone = (session.def.buttons?.[session.screenId] ?? [])[session.focus];
    if (!bone) return;
    const screen = session.meta.screenById[session.screenId];
    const el = screen?.elements?.find((e) => e.bone === bone && e.type === "button");
    if (!el || !evalCondition(session.player, session.def, el.visible_if)) return;
    play(session, "accept");
    if (session.def.pressBones?.includes(bone)) {
        // press.<bone> animation: NS:press = button index + 1 for pressTicks; the action runs right away
        setProp(session, "press", session.focus + 1);
        session.pressUntil = tickCount + Math.max(1, session.def.pressTicks ?? 1);
    }
    runAction(session, el.action, bone);
}

export function exitPressed(session) {
    if (!session.active || session.closing) return;
    if (tickCount - session.openedTick < INPUT_GRACE_TICKS) return;
    if (session.calib) {
        if (session.revealed) finishCalibration(session, 1);
        return;
    }
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
    // keep the player pinned (WASD / creative double-jump flight still move them with LateralMovement off)
    const a = session.anchor;
    const pl = player.location;
    if (a && (player.dimension.id !== a.dim || Math.hypot(pl.x - a.loc.x, pl.y - a.loc.y, pl.z - a.loc.z) > 0.05)) {
        player.teleport(a.loc, { dimension: world.getDimension(a.dim), keepVelocity: false, rotation: player.getRotation() });
    }
    if (session.revealed && tickCount >= session.reapplyAt && session.reapplyAt > 0) {
        session.reapplyAt = 0;
        session.props.clear(); // re-send everything once, in case the entity was not synced yet
        applyAllProps(session);
    }
    if (session.pressUntil && tickCount >= session.pressUntil) clearPress(session);
    if (session.closing) return; // close animation running: no navigation, no refresh
    if (session.calib) {
        calibrationTick(session);
        if (tickCount % REFRESH_TICKS === 0) refreshSession(session);
        return;
    }
    if (session.revealed) {
        const wantMouse = mouseWanted(session);
        if (wantMouse && !session.mouse) enterMouse(session);
        else if (!wantMouse && session.mouse) leaveMouse(session);
        if (session.mouse) cursorTick(session);
    }
    const dir = readDir(player);
    if (dir === null) session.lastDir = null;
    else if (dir !== session.lastDir && tickCount - session.lastMoveTick >= MOVE_DELAY_TICKS) {
        session.lastDir = dir;
        session.lastMoveTick = tickCount;
        const before = session.focus;
        setFocus(session, nextFocus(session, dir));
        if (session.mouse) {
            // WASD while using the mouse: hide the cursor (it comes back on the focused button when the mouse moves)
            session.cursorHidden = true;
            if (session.focus !== before) cursorToFocus(session);
            session.hover = session.focus;
            pushCursor(session);
        }
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
