# BB UI runtime (Script API)

Copied by the `bb_ui` filter into `BP/scripts/<scriptsPath>/` (default `bb_ui`) together with
`generated/ui_registry.js`. Imported automatically when `autoImport` is on; otherwise add
`import "./bb_ui/index.js";` to your entry script. Needs `@minecraft/server` >= 2.8.0 (see the filter's
`MIN_SERVER_VERSION`). It does not use `@minecraft/server-ui`.

```js
import { registerUiFunction, registerUiQuery, openUi, closeUi, isUiOpen, gotoScreen, refreshUi } from "./bb_ui/api.js";
```

| Function | Purpose |
| --- | --- |
| `registerUiFunction(name, (player, ctx) => void)` | Handler for `{ "type": "script", "fn": name }` actions. `ctx = { uiId, screen, bone, args, session }`. |
| `registerUiQuery(name, (player) => number \| string)` | Value for queries declared with `"source": "script"`. |
| `openUi(player, id, { source? })` | Opens UI `id`. `source` = `{ block }` or `{ entity }` anchors `"anchor": "trigger"` UIs. Returns `true` if opened. |
| `closeUi(player)` | Closes the player's UI. |
| `isUiOpen(player)` | `true` while a UI is open for the player. |
| `gotoScreen(player, screenId)` | Switches screen. |
| `refreshUi(player)` | Re-reads queries now (numbers, conditions, actionbar). |

Controls: move = navigate, Jump = accept, Sneak = back/close. Opening methods (item, block, entity,
command) are wired from `ui.json` `open[]`. Full spec: `docs/CONTRACT.md`.
