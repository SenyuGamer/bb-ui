// BB UI runtime entry. Import this file once from the add-on's main script.
import { world, system, InputButton, ButtonState } from "@minecraft/server";
import {
    sessions, tickSessions, getSession, acceptFocus, exitPressed, closeSession, mouseClick,
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

// ---- mouse clicks while a UI is open
// A click reaches the server in different ways (arm swing, a hit on a block or a mob, using an item); every path counts as a
// click and the game effect is cancelled in the "before" event (no broken blocks, no hurt mobs). One click can fire several
// of them in the same few ticks, so clicks are deduplicated per player.
const CLICK_DEDUP_TICKS = 4;
const lastClick = new Map(); // playerId -> tick

function clickFrom(player) {
    const s = getSession(player);
    if (!s) return;
    const t = system.currentTick;
    if (t - (lastClick.get(player.id) ?? -1000) < CLICK_DEDUP_TICKS) return;
    lastClick.set(player.id, t);
    try {
        mouseClick(s);
    } catch (e) {
        console.warn(`[bb_ui] click error, closing: ${e}`);
        closeSession(s, "error");
    }
}
// "before" events are read-only: run the click on the next tick
const clickLater = (player) => system.run(() => { if (player.isValid) clickFrom(player); });
const isViewer = (entity) => entity?.typeId === "minecraft:player" && sessions.has(entity.id);

world.afterEvents.playerSwingStart.subscribe((ev) => clickFrom(ev.player));
world.beforeEvents.playerBreakBlock.subscribe((ev) => {
    if (!isViewer(ev.player)) return;
    ev.cancel = true;
    clickLater(ev.player);
});
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
    if (!isViewer(ev.player)) return;
    ev.cancel = true;
    if (ev.isFirstEvent) clickLater(ev.player);
});
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
    if (!isViewer(ev.player)) return;
    ev.cancel = true;
    clickLater(ev.player);
});
world.beforeEvents.itemUse.subscribe((ev) => {
    if (!isViewer(ev.source)) return;
    ev.cancel = true;
    clickLater(ev.source);
});
// a player looking at the UI must not hurt the mob that happens to be in front of them
world.beforeEvents.entityHurt.subscribe((ev) => {
    const attacker = ev.damageSource?.damagingEntity;
    if (!isViewer(attacker)) return;
    ev.cancel = true;
    clickLater(attacker);
});
world.afterEvents.entityHitBlock.subscribe((ev) => {
    if (isViewer(ev.damagingEntity)) clickFrom(ev.damagingEntity);
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
