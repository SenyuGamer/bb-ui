// Query sources for BB UI: dynamic_property / scoreboard / script. Numbers are clamped to [0, 999999999].
import { world } from "@minecraft/server";

const scriptQueries = new Map();

/** Register a script query: (player) => number|string. Referenced by `{ source: "script", fn: name }`. */
export function registerUiQuery(name, fn) {
    scriptQueries.set(name, fn);
}

export function clampNumber(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(999999999, n));
}

/** Raw value of a named query of a UI definition (number or string). */
export function getQueryValue(player, def, name) {
    const q = def.queries?.[name];
    if (!q) return 0;
    const fallback = q.default ?? 0;
    try {
        switch (q.source) {
            case "dynamic_property": {
                const v = player.getDynamicProperty(q.key);
                return v === undefined || typeof v === "object" ? fallback : v;
            }
            case "scoreboard": {
                const obj = world.scoreboard.getObjective(q.objective);
                if (!obj) return fallback;
                const s = obj.getScore(player);
                return s === undefined ? fallback : s;
            }
            case "script": {
                const fn = scriptQueries.get(q.fn);
                if (!fn) return fallback;
                const v = fn(player);
                return v === undefined || v === null ? fallback : v;
            }
        }
    } catch (e) {
        console.warn(`[bb_ui] query '${name}' failed: ${e}`);
    }
    return fallback;
}

export function getQueryNumber(player, def, name) {
    return clampNumber(getQueryValue(player, def, name));
}

/** Evaluates a `visible_if` condition. */
export function evalCondition(player, def, cond) {
    if (!cond) return true;
    const a = getQueryValue(player, def, cond.query);
    const b = cond.value;
    switch (cond.op) {
        case "==": return a == b;
        case "!=": return a != b;
        case ">": return a > b;
        case ">=": return a >= b;
        case "<": return a < b;
        case "<=": return a <= b;
    }
    return true;
}

/** Replaces `{query}` in a text with the query values. Unknown names are left as they are. */
export function substituteQueries(text, player, def) {
    return String(text).replace(/\{(\w+)\}/g, (m, name) => {
        if (!def.queries?.[name]) return m;
        const v = getQueryValue(player, def, name);
        return typeof v === "number" ? String(clampNumber(v)) : String(v);
    });
}
