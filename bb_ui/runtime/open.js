// Open triggers for BB UI: item use, block interact, entity interact, custom commands.
import { world, system, CommandPermissionLevel, CustomCommandStatus } from "@minecraft/server";
import { UI_REGISTRY } from "./generated/ui_registry.js";
import { openUi, isUiOpen, openCalibration } from "./api.js";
import { SCALE_KEY, calibrationEnabled } from "./session.js";

const PERMISSIONS = {
    any: CommandPermissionLevel.Any,
    gamedirectors: CommandPermissionLevel.GameDirectors,
    admin: CommandPermissionLevel.Admin,
};

function collect(type, key) {
    const map = new Map(); // key -> [uiId]
    for (const [id, def] of Object.entries(UI_REGISTRY)) {
        for (const o of def.open ?? []) {
            if (o.type !== type) continue;
            const k = o[key];
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(id);
        }
    }
    return map;
}

const pending = new Set(); // players with a deferred open in flight

function deferOpen(player, id, makeSource) {
    if (pending.has(player.id) || isUiOpen(player)) return;
    pending.add(player.id);
    system.run(() => {
        pending.delete(player.id);
        try {
            if (!player.isValid || isUiOpen(player)) return;
            openUi(player, id, { source: makeSource?.() });
        } catch (e) {
            console.warn(`[bb_ui] open failed: ${e}`);
        }
    });
}

export function initOpen() {
    const items = collect("item", "item");
    const blocks = collect("block", "block");
    const entities = collect("entity", "entity");
    const commands = [];
    for (const [id, def] of Object.entries(UI_REGISTRY)) {
        for (const o of def.open ?? []) if (o.type === "command") commands.push({ id, o });
    }

    if (items.size) {
        // generated items carry the "bb_ui:open" custom component (afterEvents.itemUse does not fire for them)
        system.beforeEvents.startup.subscribe(({ itemComponentRegistry }) => {
            const handler = (ev) => {
                const ids = items.get(ev.itemStack?.typeId);
                if (!ids || !ev.source || ev.source.typeId !== "minecraft:player") return;
                deferOpen(ev.source, ids[0]);
            };
            try {
                itemComponentRegistry.registerCustomComponent("bb_ui:open", { onUse: handler, onUseOn: handler });
            } catch (e) {
                console.warn(`[bb_ui] custom item component failed to register: ${e}`);
            }
        });
        world.afterEvents.itemUse.subscribe((ev) => {
            const ids = items.get(ev.itemStack?.typeId);
            if (!ids) return;
            if (isUiOpen(ev.source)) return;
            deferOpen(ev.source, ids[0]);
        });
        // itemUse does not fire when the player aims at a block: open on the block tap too
        // (sneaking keeps the normal block interaction, like block triggers)
        world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
            const ids = items.get(ev.itemStack?.typeId);
            if (!ids || ev.player.isSneaking) return;
            ev.cancel = true;
            if (!ev.isFirstEvent) return;
            deferOpen(ev.player, ids[0]);
        });
    }

    if (blocks.size) {
        world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
            const ids = blocks.get(ev.block.typeId);
            if (!ids) return;
            if (ev.player.isSneaking) return; // sneaking players place/interact normally
            ev.cancel = true; // read-only mode: open on the next tick
            if (!ev.isFirstEvent) return;
            const dim = ev.block.dimension;
            const loc = ev.block.location;
            deferOpen(ev.player, ids[0], () => {
                const block = dim.getBlock(loc);
                return block ? { block } : undefined;
            });
        });
    }

    if (entities.size) {
        world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
            const ids = entities.get(ev.target.typeId);
            if (!ids) return;
            ev.cancel = true;
            const target = ev.target;
            deferOpen(ev.player, ids[0], () => (target.isValid ? { entity: target } : undefined));
        });
    }

    // Bedrock requires all custom commands of a pack to share ONE namespace: use the UIs' namespace.
    const calibNs = Object.values(UI_REGISTRY).find(calibrationEnabled)?.namespace;
    const calibCmd = `${calibNs}:calibrate`;
    if (calibNs) {
        system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
            try {
                customCommandRegistry.registerCommand(
                    {
                        name: calibCmd,
                        description: "Recalibrate the size of 3D UIs",
                        permissionLevel: CommandPermissionLevel.Any,
                        cheatsRequired: false,
                    },
                    (origin) => {
                        const p = origin.sourceEntity ?? origin.initiator;
                        if (!p || p.typeId !== "minecraft:player") {
                            return { status: CustomCommandStatus.Failure, message: "Only players can calibrate" };
                        }
                        if (isUiOpen(p)) return { status: CustomCommandStatus.Failure, message: "Close the UI first" };
                        if (pending.has(p.id)) return { status: CustomCommandStatus.Success };
                        pending.add(p.id);
                        system.run(() => {
                            pending.delete(p.id);
                            try {
                                if (!p.isValid || isUiOpen(p)) return;
                                p.setDynamicProperty(SCALE_KEY, undefined);
                                openCalibration(p);
                            } catch (e) {
                                console.warn(`[bb_ui] calibrate failed: ${e}`);
                            }
                        });
                        return { status: CustomCommandStatus.Success };
                    },
                );
            } catch (e) {
                console.warn(`[bb_ui] command '${calibCmd}' failed to register: ${e}`);
            }
        });
    }

    if (commands.length) {
        system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
            for (const { id, o } of commands) {
                try {
                    customCommandRegistry.registerCommand(
                        {
                            name: o.name,
                            description: `Open the ${id} UI`,
                            permissionLevel: PERMISSIONS[o.permission ?? "any"] ?? CommandPermissionLevel.Any,
                            cheatsRequired: false,
                        },
                        (origin) => {
                            const p = origin.sourceEntity ?? origin.initiator;
                            if (!p || p.typeId !== "minecraft:player") {
                                return { status: CustomCommandStatus.Failure, message: "Only players can open this UI" };
                            }
                            deferOpen(p, id);
                            return { status: CustomCommandStatus.Success };
                        },
                    );
                } catch (e) {
                    console.warn(`[bb_ui] command '${o.name}' failed to register: ${e}`);
                }
            }
        });
    }
}
