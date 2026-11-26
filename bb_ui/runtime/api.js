// Public BB UI API (CONTRACT section 4).
import { registerUiFunction } from "./actions.js";
import { registerUiQuery } from "./queries.js";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import {
    openSession, closeSession, getSession, gotoScreen as gotoScreenInternal, refreshSession,
    getLastUiId, calibrationEnabled,
} from "./session.js";

export { registerUiFunction, registerUiQuery };

/** Opens a UI for a player. `source` ({ block?, entity? }) anchors "trigger" UIs. Returns true if opened. */
export function openUi(player, id, { source } = {}) {
    return !!openSession(player, id, { source });
}

/**
 * Opens a UI in calibration mode (size adjustment) even if the player already has a saved `bb_ui:scale`.
 * `uiId` defaults to the last UI the player opened, or the first UI of the registry that supports calibration.
 * It does not clear `bb_ui:scale` (the `bb_ui:calibrate` command does). Returns true if opened.
 */
export function openCalibration(player, uiId) {
    if (getSession(player)) return false;
    let id = uiId ?? getLastUiId(player.id);
    if (!id || !UI_REGISTRY[id]) id = Object.keys(UI_REGISTRY).find((k) => calibrationEnabled(UI_REGISTRY[k]));
    const def = id ? UI_REGISTRY[id] : undefined;
    if (!def || !calibrationEnabled(def)) {
        console.warn(`[bb_ui] openCalibration: UI '${id}' does not support calibration`);
        return false;
    }
    return !!openSession(player, id, { calibrate: true });
}

export function closeUi(player) {
    const s = getSession(player);
    return s ? closeSession(s, "api") : false;
}

export function isUiOpen(player) {
    return !!getSession(player);
}

export function gotoScreen(player, screenId) {
    const s = getSession(player);
    return s ? gotoScreenInternal(s, screenId) : false;
}

export function refreshUi(player) {
    const s = getSession(player);
    if (!s) return false;
    refreshSession(s);
    return true;
}
