// Public BB UI API (CONTRACT section 4).
import { registerUiFunction } from "./actions.js";
import { registerUiQuery } from "./queries.js";
import { openSession, closeSession, getSession, gotoScreen as gotoScreenInternal, refreshSession } from "./session.js";

export { registerUiFunction, registerUiQuery };

/** Opens a UI for a player. `source` ({ block?, entity? }) anchors "trigger" UIs. Returns true if opened. */
export function openUi(player, id, { source } = {}) {
    return !!openSession(player, id, { source });
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
