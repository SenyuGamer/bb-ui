# BB UI — contrato (fuente de verdad para filtro, runtime y plugin)

Sistema de UIs 3D: la UI es una **entidad de display** con geometría hecha en Blockbench, vista con cámara
`minecraft:free` fija. Cada hueso es un elemento (botón, imagen, modelo, número). El estado (pantalla, foco,
valores) vive en **propiedades de entidad**, puestas por jugador con `Player.setPropertyOverrideForEntity`, y el
RP las lee con `q.property(...)`.

## 1. Fuente por UI: `<data>/bb_ui/<id>/`
(`<data>` = `dataPath` de Regolith, p. ej. `packs/data`; la subcarpeta se puede cambiar con el setting `dataPath` del filtro.)
| Archivo | Quién lo escribe | Uso |
| --- | --- | --- |
| `ui.json` | plugin / Claude / a mano | definición (sección 2). **Obligatorio.** |
| `geo.json` | plugin (Codecs.bedrock) / MCP `bbmodel_export_bedrock_geometry` | geometría Bedrock (`format_version` 1.12.0+, un `minecraft:geometry`). **Obligatorio.** |
| `texture.png` | plugin / a mano | textura única de la geometría. **Obligatorio.** |
| `model.bbmodel` | plugin | proyecto editable; el filtro lo **ignora**. Lleva `ui.json` también dentro, en la clave `bbui`. |

`<id>`: `[a-z0-9_]+`, único.

## 2. `ui.json`
```jsonc
{
  "format_version": 1,
  "id": "example",                    // = nombre de la carpeta
  "namespace": "bbui",                // namespace de todo lo generado (opcional: si falta, setting `defaultNamespace`)
  "display": {
    "fov": 70,                        // camera.setFov
    "distance": 2.5,                  // bloques entre la cámara y la entidad
    "height": 0,                      // desplazamiento vertical de la entidad respecto a los ojos
    "xray": true,                     // true (def.): se dibuja encima de bloques/entidades (material sin depth test); false: los bloques la tapan
    "anchor": "player",               // "player" (delante del jugador) | "trigger" (sobre el bloque/entidad que la abrió, si hay)
    "sounds": { "move": "random.click", "accept": "random.orb", "open": "random.pop", "close": "random.pop" } // opcional
  },
  "open": [                           // uno o varios métodos
    { "type": "item",    "item": "bbui:ui_example",
      "generate": { "name": "UI Example", "texture": "textures/items/book_normal" } },   // generate opcional: crea el item
    { "type": "block",   "block": "bbui:ui_table",
      "generate": { "name": "UI Table", "texture": "textures/blocks/crafting_table_top" } }, // generate opcional: crea el bloque cubo
    { "type": "entity",  "entity": "minecraft:villager_v2" },
    { "type": "command", "name": "bbui:example_ui", "permission": "any" }  // "any" | "gamedirectors" | "admin"
  ],
  "start_screen": "main",
  "screens": [
    {
      "id": "main",
      "bones": ["main_bg"],           // huesos decorativos visibles solo en esta pantalla (opcional)
      "default_focus": "btn_shop",
      "actionbar": "Monedas: {coins}",// opcional; {query} se sustituye
      "elements": [
        { "bone": "btn_shop", "type": "button",
          "nav": { "up": null, "down": "btn_close", "left": null, "right": "btn_cmd" },  // opcional; si falta, vecino más cercano
          "highlight": "btn_shop_hl",                     // opcional: hueso visible solo con foco
          "visible_if": { "query": "coins", "op": ">=", "value": 10 },  // opcional
          "action": { "type": "goto", "screen": "shop" } },
        { "bone": "logo", "type": "image" },
        { "bone": "chest_model", "type": "model" },
        { "bone": "coins_num", "type": "number", "query": "coins", "digits": 4, "align": "right" }
      ]
    }
  ],
  "queries": {
    "coins": { "source": "dynamic_property", "key": "bbui:coins", "default": 0 },
    "level": { "source": "script", "fn": "getLevel" },
    "score": { "source": "scoreboard", "objective": "money" }
  }
}
```
Bones: todos los huesos referenciados deben existir en `geo.json`. Huesos que no aparecen en ninguna pantalla ni
como elemento son **siempre visibles** (fondo común). Huesos de `screens[].bones` y de los elementos solo se ven en
su pantalla.

### Acciones (`action`)
| type | campos | efecto |
| --- | --- | --- |
| `goto` | `screen` | cambia de pantalla (se apila para `back`) |
| `back` | — | pantalla anterior; si no hay, cierra |
| `close` | — | cierra la UI |
| `command` | `command` (sin `/`), `as`: `"player"` (def.) \| `"server"` | `player.runCommand` o `dimension.runCommand`; `{player}` se sustituye por el nombre |
| `script` | `fn`, `args` (objeto opcional) | llama a la función registrada con `registerUiFunction` |
| `set` | `key`, `value` | `player.setDynamicProperty(key, value)` |
| `add` | `key`, `amount`, `min?`, `max?` | suma a una dynamic property numérica |
| `sequence` | `actions: [...]` | ejecuta varias en orden |

`op` de `visible_if`: `==`, `!=`, `>`, `>=`, `<`, `<=`.

## 3. Lo que genera el filtro (`bb_ui/main.js`, solo en `.regolith/tmp`; nunca toca las fuentes)
Prefijos: `NS = namespace`, `ID = id`.

**BP**
- `entities/bb_ui/<ID>.json`: `NS:ui_<ID>`; `is_spawnable:false`, `is_summonable:true`; sin gravedad ni colisión
  (`minecraft:physics` has_gravity/has_collision false, `minecraft:collision_box` 0.0001, `minecraft:pushable` false,
  `minecraft:damage_sensor` all deals_damage "no", `minecraft:knockback_resistance` 1, `minecraft:type_family` ["bb_ui"]).
- Propiedades (`description.properties`), `client_sync: true`:
  - `NS:viewer` bool, default false — solo el dueño la ve true (override).
  - `NS:screen` int [0, nScreens-1], default índice de `start_screen`.
  - `NS:focus` int [0, maxElementsPorPantalla], default 0 (índice dentro de los **botones** de la pantalla).
  - `NS:n<k>` int [0, 999999999] por cada elemento `number` (k = índice global de número).
  - `NS:v<k>` bool por cada elemento con `visible_if` (k = índice global).
  - Límite: máximo 32 propiedades por entidad → error claro si se pasa.
- `items/bb_ui/<item>.json` y `blocks/bb_ui/<block>.json` si `open[].generate` existe (item con `minecraft:icon`,
  bloque cubo con `material_instances`; añadir entradas a `RP/textures/item_texture.json` / `terrain_texture.json`
  y nombres a todos los `RP/texts/*.lang`; si no hay ninguno se crea `en_US.lang` y su entrada en `languages.json`).
- `scripts/<scriptsPath>/generated/ui_registry.js` (`scriptsPath` = setting, por defecto `bb_ui`; el filtro copia aquí también el runtime): `export const UI_REGISTRY = { <ID>: { ...ui.json normalizado,
  entity: "NS:ui_<ID>", screenIndex: {id: n}, buttons: {screenId: [bone,...]}, numbers: {bone: k}, conditions: {bone: k},
  bonePos: {bone: [x,y,z]} } }`.

**RP**
- `models/entity/bb_ui/<ID>.geo.json`: copia de `geo.json` con identifier `geometry.bb_ui.<ID>`.
- `models/entity/bb_ui/<ID>_digits.geo.json`: `geometry.bb_ui.<ID>.digits`; por cada número, `digits` posiciones ×
  10 cubos planos (`<bone>_<pos>_<0-9>`) colocados sobre el cubo del hueso `number` (repartido en anchura).
- `textures/bb_ui/<ID>.png` (copia) y `textures/bb_ui/digits.png` (10 glifos generados con el codificador PNG propio `bb_ui/lib/png.js`, 0-9 en tira horizontal).
- `entity/bb_ui/<ID>.entity.json`: dos texturas/geometrías, material `entity_alphatest` (sin iluminación:
  `"ignore_lighting": true` en el render controller), render controllers `controller.render.bb_ui.<ID>` y `...digits`,
  animaciones de foco.
- `render_controllers/bb_ui/<ID>.json` con `part_visibility`:
  - `"*": "q.property('NS:viewer')"` (todo oculto para los demás).
  - Hueso de pantalla s: `q.property('NS:viewer') && q.property('NS:screen') == s`.
  - Con `visible_if`: además `&& q.property('NS:v<k>')`.
  - `highlight` del botón i en pantalla s: además `&& q.property('NS:focus') == i`.
  - Dígitos: `math.mod(math.floor(q.property('NS:n<k>') / math.pow(10, p)), 10) == d` (p = posición desde la derecha),
    ocultando ceros a la izquierda salvo la última posición.
- `animations/bb_ui/<ID>.animation.json`: `animation.bb_ui.<ID>.focus_<s>_<i>` = scale 1.08 del hueso del botón (loop);
  en el entity file `scripts.animate` con condición `q.property('NS:screen') == s && q.property('NS:focus') == i`.

## 4. Runtime (`BP/scripts/<scriptsPath>/`, copiado por el filtro; con `autoImport` se antepone `import "./<scriptsPath>/index.js"` al `entry` del módulo script del manifest BP)
- Lee `UI_REGISTRY`. Una sesión por jugador (`Map<playerId, Session>`), una entidad por sesión.
- Abrir: spawnea la entidad (anchor), pone `viewer`/`screen`/`focus`/`n*`/`v*` con `setPropertyOverrideForEntity` para el
  dueño (y valores reales por defecto = vacío), `camera.setCamera("minecraft:free", {location, facingLocation, easeOptions})`,
  `camera.setFov`, desactiva `InputPermissionCategory.Camera` y `LateralMovement`. Guarda el tag `bb_ui:<playerId>` en la entidad.
- Loop `runInterval` 1 tick: movimiento (`inputInfo.getMovementVector()`, umbral 0.5, retardo 4 ticks, solo al cambiar),
  refresca queries cada 10 ticks (números, condiciones, actionbar) y comprueba que la entidad sigue válida.
- Aceptar: `world.afterEvents.playerButtonInput` Jump Pressed. Salir: Sneak Pressed. También cierra en muerte, al salir del
  mundo (`playerLeave`), en spawn inicial y si la entidad se invalida. Al iniciar el mundo, elimina entidades
  de familia `bb_ui` huérfanas.
- Cerrar: `camera.clear()`, `setFov` por defecto (`camera.clear` + `setDefaultCamera` si hace falta), restaura permisos,
  elimina la entidad, limpia actionbar.
- API pública (`BP/scripts/<scriptsPath>/api.js`, reexportada por `index.js`):
  `registerUiFunction(name, (player, ctx) => void)`, `registerUiQuery(name, (player) => number|string)`,
  `openUi(player, id, {source?})`, `closeUi(player)`, `isUiOpen(player)`, `gotoScreen(player, screenId)`,
  `refreshUi(player)`. `ctx = { uiId, screen, bone, args, session }`.
