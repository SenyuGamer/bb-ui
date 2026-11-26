// Action runner for BB UI (CONTRACT section 2).
import { system } from "@minecraft/server";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import { gotoScreen, backScreen, closeSession, refreshSession, openSession } from "./session.js";

const uiFunctions = new Map();

/** Register a script function: (player, ctx) => void. Referenced by `{ type: "script", fn: name }`. */
export function registerUiFunction(name, fn) {
    uiFunctions.set(name, fn);
}

function subst(text, player) {
    return String(text).replace(/\{player\}/g, player.name);
}

export function runAction(session, action, bone) {
    if (!action || !session.active) return;
    const { player } = session;
    switch (action.type) {
        case "goto":
            gotoScreen(session, action.screen);
            break;
        case "back":
            backScreen(session);
            break;
        case "close":
            closeSession(session, "action");
            break;
        case "open_ui": {
            if (typeof action.ui !== "string" || !UI_REGISTRY[action.ui]) {
                console.warn(`[bb_ui] open_ui: unknown UI '${action.ui}'`);
                break;
            }
            const source = session.source;
            closeSession(session, "open_ui");
            system.run(() => {
                try {
                    if (player.isValid) openSession(player, action.ui, { source, fade: false });
                } catch (e) {
                    console.warn(`[bb_ui] open_ui failed: ${e}`);
                }
            });
            break;
        }
        case "command": {
            const cmd = subst(action.command, player);
            if (action.as === "server") player.dimension.runCommand(cmd);
            else player.runCommand(cmd);
            break;
        }
        case "script": {
            const fn = uiFunctions.get(action.fn);
            if (!fn) {
                console.warn(`[bb_ui] script function '${action.fn}' is not registered`);
                break;
            }
            fn(player, { uiId: session.id, screen: session.screenId, bone, args: action.args ?? {}, session });
            break;
        }
        case "set":
            player.setDynamicProperty(action.key, action.value);
            break;
        case "add": {
            const cur = Number(player.getDynamicProperty(action.key) ?? 0) || 0;
            let v = cur + (Number(action.amount) || 0);
            if (typeof action.min === "number") v = Math.max(action.min, v);
            if (typeof action.max === "number") v = Math.min(action.max, v);
            player.setDynamicProperty(action.key, v);
            break;
        }
        case "sequence":
            for (const a of action.actions ?? []) {
                if (!session.active) break; // an earlier step may have closed the UI
                runAction(session, a, bone);
            }
            break;
        default:
            console.warn(`[bb_ui] unknown action type '${action.type}'`);
    }
    if (session.active) refreshSession(session);
}
