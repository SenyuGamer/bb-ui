// BB UI runtime entry. Import this file once from the add-on's main script.
import { world, system, InputButton, ButtonState } from "@minecraft/server";
import {
    sessions, tickSessions, getSession, acceptFocus, exitPressed, closeSession,
    removeOrphans, removeEntitiesOf, dropSessionOnLeave,
} from "./session.js";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import { initOpen } from "./open.js";

export * from "./api.js";

initOpen();

system.runInterval(tickSessions, 1);

world.afterEvents.playerButtonInput.subscribe((ev) => {
    if (ev.newButtonState !== ButtonState.Pressed) return;
    const s = getSession(ev.player);
    if (!s) return;
    try {
        if (ev.button === InputButton.Jump) acceptFocus(s);
        else if (ev.button === InputButton.Sneak) exitPressed(s);
    } catch (e) {
        console.warn(`[bb_ui] input error, closing: ${e}`);
        closeSession(s, "error");
    }
});

world.afterEvents.entityHurt.subscribe(
    (ev) => {
        try {
            ev.hurtEntity.getComponent("minecraft:health")?.resetToMaxValue();
        } catch {}
    },
    { entityTypes: [...new Set(Object.values(UI_REGISTRY).map((d) => d.entity))] },
);

world.beforeEvents.playerLeave.subscribe((ev) => dropSessionOnLeave(ev.player.id));

world.afterEvents.entityDie.subscribe((ev) => {
    const e = ev.deadEntity;
    if (e.typeId !== "minecraft:player") return;
    const s = sessions.get(e.id);
    if (s) closeSession(s, "death");
});

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const s = sessions.get(ev.player.id);
    if (s) closeSession(s, "spawn");
    removeEntitiesOf(ev.player.id);
});

world.afterEvents.worldLoad.subscribe(() => removeOrphans());
system.run(() => removeOrphans()); // also covers script reloads
