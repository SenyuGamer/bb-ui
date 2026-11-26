// Focus navigation for BB UI.
import { evalCondition } from "./queries.js";

// Screen-right axis in model space. Verified in game: bones with negative X appear on the screen LEFT, so the
// viewer's right is model +X.
export const MODEL_RIGHT_SIGN = 1;

const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };

function buttonElement(session, screenId, bone) {
    const screen = session.meta.screenById[screenId];
    return screen?.elements?.find((e) => e.bone === bone && e.type === "button");
}

/** Indices (into def.buttons[screen]) of buttons currently visible. */
export function visibleButtons(session, screenId = session.screenId) {
    const { def, player } = session;
    const bones = def.buttons?.[screenId] ?? [];
    const out = [];
    bones.forEach((bone, i) => {
        if (evalCondition(player, def, buttonElement(session, screenId, bone)?.visible_if)) out.push(i);
    });
    return out;
}

/** Returns the new focus index, or the current one if nothing is reachable. */
export function nextFocus(session, dir) {
    const { def, screenId } = session;
    const bones = def.buttons?.[screenId] ?? [];
    const visible = visibleButtons(session);
    if (!visible.length) return session.focus;
    if (!visible.includes(session.focus)) return visible[0];
    const cur = bones[session.focus];
    const el = buttonElement(session, screenId, cur);
    if (el?.nav && Object.prototype.hasOwnProperty.call(el.nav, dir)) {
        const target = el.nav[dir];
        if (target === null || target === undefined) return session.focus; // explicit "no move"
        const idx = bones.indexOf(target);
        return idx >= 0 && visible.includes(idx) ? idx : session.focus;
    }
    const [dx, dy] = DIRS[dir];
    const p0 = def.bonePos?.[cur];
    if (!p0) return session.focus;
    let best = session.focus;
    let bestScore = Infinity;
    for (const i of visible) {
        if (i === session.focus) continue;
        const p = def.bonePos?.[bones[i]];
        if (!p) continue;
        const rx = (p[0] - p0[0]) * MODEL_RIGHT_SIGN;
        const ry = p[1] - p0[1];
        const along = rx * dx + ry * dy;
        const perp = Math.abs(rx * dy - ry * dx);
        if (along <= 1e-6 || perp > along * 2) continue; // outside ~63 degree cone
        const score = along + perp * 2;
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    }
    return best;
}
