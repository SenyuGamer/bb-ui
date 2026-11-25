// Example script hooks for the "example" UI (examples/packs/data/bb_ui/example).
import { registerUiFunction } from "./bb_ui/api.js";

registerUiFunction("exampleHello", (player) => {
    player.sendMessage(`§aHello ${player.name}, from BB UI!`);
});
