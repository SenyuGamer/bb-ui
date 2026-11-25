# bb-ui

3D user interfaces for Minecraft Bedrock, designed in Blockbench and built by a Regolith filter. No npm dependencies.

## How it works

1. A UI is a display entity whose geometry you model in Blockbench; every bone is an element (button, image, model, number).
2. The Blockbench plugin exports `ui.json` + `geo.json` + `texture.png` (+ `model.bbmodel`) to `<data>/bb_ui/<id>/`.
3. The `bb_ui` Regolith filter generates the BP entity, the RP client entity, geometry, render controller, animations,
   optional items/blocks, and a `ui_registry.js`, then copies the Script API runtime into your BP scripts.
4. In game the player gets a fixed `minecraft:free` camera on the entity; screen, focus and values are entity
   properties set per player (`setPropertyOverrideForEntity`) and read by the RP with `q.property(...)`.
5. Move to navigate, Jump to accept, Sneak to go back/close. Actions: goto/back/close/command/script/set/add/sequence.

## Install the filter

```
regolith install github.com/SenyuGamer/bb-ui/bb_ui
```

Add it to a profile in `config.json` (the installed name is `bb_ui`):

```json
{ "filter": "bb_ui", "settings": { "scriptsPath": "bb_ui" } }
```

Requires `@minecraft/server` 2.8.0 or newer (tested with 2.9.0) in the BP manifest (the filter warns otherwise) and Node.js (or Bun) for
Regolith's `nodejs` runner. Put UIs in `<regolith dataPath>/bb_ui/<id>/` (e.g. `packs/data/bb_ui/<id>/`).

| Setting | Default | Meaning |
| --- | --- | --- |
| `dataPath` | `"bb_ui"` | UI source folder, relative to Regolith's `data/` |
| `scriptsPath` | `"bb_ui"` | Folder under `BP/scripts` that receives the runtime and `generated/ui_registry.js` |
| `autoImport` | `true` | Prepend `import "./<scriptsPath>/index.js";` to the BP script entry. If the manifest has no script module, one is added (with `@minecraft/server`) and a warning is printed. Set `false` to import it yourself |
| `defaultNamespace` | `"bbui"` | Namespace used when a `ui.json` omits `namespace` |

If there are no UIs the filter does nothing. It only writes into Regolith's temp copy, never your sources.
Generated: lang lines are appended to every `RP/texts/*.lang` (an `en_US.lang` is created if none exists);
`item_texture.json` / `terrain_texture.json` are merged or created.

## Blockbench plugin

Blockbench desktop 4.10+: File > Plugins > Load Plugin from File > `blockbench/bb_ui_builder.js`.
Then File > New > **Minecraft UI**, add buttons/images/numbers/model slots from the **UI** menu, and use
**UI: Export to pack** (first run asks for your `<Regolith project>/packs/data/bb_ui` folder). See
[`blockbench/README.md`](blockbench/README.md).

## Workflow

Model in Blockbench -> Export to pack -> `regolith run` -> open the UI in game (item, block, entity or command, as
declared in `open[]`). A complete minimal project is in [`examples/`](examples): `cd examples && regolith run build`.

## Script API

```js
import { registerUiFunction, registerUiQuery, openUi, closeUi, isUiOpen, gotoScreen, refreshUi } from "./bb_ui/api.js";
```

See [`bb_ui/runtime/README.md`](bb_ui/runtime/README.md) and the spec in [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Limits

- One UI per player at a time; max 32 entity properties per UI (3 base + one per `number` + one per `visible_if`).
- Numbers are non-negative integers up to 999999999, drawn with a built-in 3x5 digit font.
- One texture per UI; geometry must be a single `minecraft:geometry` (format 1.12.0+).
- Needs the Script API camera/input APIs; no touch-specific controls are provided beyond movement/jump/sneak.
- Game behavior was developed on Bedrock 1.21.90+; the example has not been re-tested in game after being split out.

## Claude / MCP

The `bbmodel` MCP (headless Blockbench) preserves the `bbui` field stored in `.bbmodel` files, so agents can edit a UI's
definition and geometry without opening Blockbench, then export `geo.json`/`ui.json` into `<data>/bb_ui/<id>/`.
Do not edit the same file in Blockbench and headless at once.

## License

MIT
