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
| `animations.json` | plugin / Blockbench (export Bedrock animation) | **Opcional.** Animaciones en formato Bedrock estándar (`{"format_version":"1.8.0","animations":{"<nombre>":{...}}}`); se cablean por nombre, ver sección 3.1. |
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
    "height": 0,                      // desplazamiento vertical del CENTRO del panel respecto a los ojos (0 = centrado en pantalla)
    "xray": true,                     // true (def.): se dibuja encima de bloques/entidades (material sin depth test); false: los bloques la tapan
    "anchor": "player",               // "player" (delante del jugador) | "trigger" (sobre el bloque/entidad que la abrió, si hay)
    "backdrop": { "color": "#000000" }, // opcional; def. activado, opaco (`opacity` se acepta pero se ignora: un telón translúcido se dibuja encima de la UI); false = sin telón de fondo (ver 3, "Telón")
    "fade": { "in": 0.15, "hold": 0.3, "out": 0.35, "color": "#000000" }, // opcional; def. con estos valores; false = sin fundido (segundos)
    "hide_hud": true,                 // def. true: oculta el HUD (menos el actionbar) mientras la UI está abierta
    "calibrate": true,                // def. true: la primera vez que un jugador abre una UI calibra el tamaño (ver 4)
    "cursor": { "sensitivity": 1 },   // opcional; def. activado; false = sin cursor de ratón (ver 4, "Cursor")
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

### Idiomas / Languages (opcional)
```jsonc
"languages": ["es", "en", "pt"],      // el primero es el idioma por defecto; la función solo se activa con 2 o más
"translations": { "texto_en": "en" }  // hueso (y su subárbol) -> código; solo se ve cuando el jugador tiene ese idioma
```
- Validación: `languages` = códigos únicos (`es`, `pt_br`...); cada valor de `translations` debe estar en `languages` y cada clave debe ser un hueso de la geometría. Sin `languages` (o con un solo idioma) `translations` se ignora (con aviso) y la salida es idéntica a la de una UI sin idiomas.
- Propiedad de entidad `<ns>:lang` (int, rango `0..max(n-1,1)`, def. 0, `client_sync`; cuenta en el límite de 32). El runtime la pone al abrir la UI y al guardar los ajustes: índice del idioma del jugador en `languages`.
- Geometría: una por idioma (`geometry.bb_ui.<id>` para el primero, `geometry.bb_ui.<id>.lang<i>` para los demás). Cada una deja fuera los huesos traducidos a otro idioma (con su subárbol), y el render controller elige la del jugador con `Array.lang[q.property('<ns>:lang')]`. Así ninguna geometría lleva los huesos de todos los idiomas: Bedrock solo dibuja los primeros 127 huesos de una geometría, y el filtro avisa si una pasa de ahí.
- Idioma del jugador: dynamic property `bb_ui:lang` (código, compartida por todas las UIs); si falta o no está en `languages`, se usa el primero. El registro generado incluye `languages` y `translations`.
- La acción `settings` añade (si la UI tiene 2+ idiomas) un desplegable "Idioma / Language" con los nombres (es Español, en English, pt Português, fr, de, it, ja, ko, zh, ru; si no, el código) y lo aplica al momento. Los textos del formulario salen en es/en/pt según el idioma actual (por defecto español).

### Acciones (`action`)
| type | campos | efecto |
| --- | --- | --- |
| `goto` | `screen` | cambia de pantalla (se apila para `back`) |
| `back` | — | pantalla anterior; si no hay, cierra |
| `close` | — | cierra la UI |
| `settings` | — | abre el formulario de ajustes (`@minecraft/server-ui` ModalForm, la UI sigue abierta detrás): sensibilidad del ratón (deslizador en % de 20 a 300 en pasos de 10, porque los sliders de Bedrock solo manejan enteros; se guarda como 0.2..3 en la dynamic property del jugador `bb_ui:cursor_sens`; sin tooltips, que tapan el deslizador) y, si la UI calibra, "Recalibrar" (entra en calibración sin cerrar). Si alguna UI la usa, el filtro añade `@minecraft/server-ui` 2.0.0 al manifest cuando falta |
| `open_ui` | `ui` (id de otra UI) | cierra la UI actual y abre la otra para el mismo jugador (misma fuente `source`); si el id no existe, `console.warn` y no hace nada. El filtro avisa si `ui` no está entre las UIs del build |
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
  `minecraft:damage_sensor` (suffocation y all, deals_damage "no"), `minecraft:health` 1000000 (el runtime además restaura la vida en `entityHurt`), `minecraft:knockback_resistance` 1, `minecraft:type_family` ["bb_ui"]).
- Propiedades (`description.properties`), `client_sync: true`:
  - `NS:viewer` bool, default false — solo el dueño la ve true (override).
  - `NS:screen` int [0, nScreens-1], default índice de `start_screen`.
  - `NS:focus` int [0, maxElementsPorPantalla], default 0 (índice dentro de los **botones** de la pantalla).
  - `NS:calib` bool, default false — solo si `display.calibrate !== false`; activa las esquinas de calibración (override por jugador).
  - `NS:closing` bool, default false — solo si `animations.json` tiene una animación `close`. El runtime la pone a true (override) durante la animación de cierre.
  - `NS:press` int [0, maxElementsPorPantalla], default 0 — solo si hay alguna `press.<hueso>`. 0 = ninguno; si no, índice del botón aceptado + 1 dentro de los botones de la pantalla (mismo índice que `focus`, +1). Override por jugador.
  - `NS:bd` float [0, 16], default 0 — solo si `display.backdrop !== false`. Bloques desde el origen de la entidad hacia la cámara a los
    que se coloca el telón: (distancia horizontal cámara-entidad) - 0.08, mínimo 0. El runtime la pone (override) al abrir/revelar y
    cada vez que cambia la escala de calibración (`distance/scale`; con anchor "trigger" se calcula de camLoc/entityLoc reales).
  - `NS:yaw` float [-360.5, 360.5], default 0.0001 (Bedrock rechaza números JSON de aspecto entero en floats) — siempre. Orientación: es el yaw (grados, convención de `Entity.getRotation().y`) que la entidad tendría si mirara a la cámara en horizontal: `atan2(-(cam.x-e.x), cam.z-e.z)`. El cuerpo de la entidad **nunca** gira (yaw 0 fijo); el RP gira el hueso raíz `__bbui_yaw` con esta propiedad. El runtime la pone (override) justo tras crear la entidad (antes del fundido) y la reenvía al revelar; cualquier cosa que mueva la entidad (calibración) la recalcula.
  - `NS:n<k>` int [0, 999999999] por cada elemento `number` (k = índice global de número).
  - `NS:v<k>` bool por cada elemento con `visible_if` (k = índice global).
  - Límite (cuenta también `NS:yaw`, `NS:bd`, y `NS:closing` / `NS:press` solo si se usan): máximo 32 propiedades por entidad → error claro si se pasa.
- `items/bb_ui/<item>.json` y `blocks/bb_ui/<block>.json` si `open[].generate` existe (item `format_version` 1.21.90 con `minecraft:icon` y el custom component `bb_ui:open` — el runtime lo registra y abre la UI en `onUse`/`onUseOn`; lang `item.<id>` e `item.<id>.name`;
  bloque cubo con `material_instances`; añadir entradas a `RP/textures/item_texture.json` / `terrain_texture.json`
  y nombres a todos los `RP/texts/*.lang`; si no hay ninguno se crea `en_US.lang` y su entrada en `languages.json`).
- `scripts/<scriptsPath>/generated/ui_registry.js` (`scriptsPath` = setting, por defecto `bb_ui`; el filtro copia aquí también el runtime): `export const UI_REGISTRY = { <ID>: { ...ui.json normalizado,
  entity: "NS:ui_<ID>", screenIndex: {id: n}, buttons: {screenId: [bone,...]}, numbers: {bone: k}, conditions: {bone: k},
  bonePos: {bone: [x,y,z]}, centerY: <centro vertical de los cubos del geo, en bloques>,
  bbox: { min: [x,y,z], max: [x,y,z] } /* bbox mundial de todos los cubos del geo, en bloques */,
  closeTicks: <n>, pressTicks: <n>, pressBones: [bone,...] /* ver 3.1; 0 / 0 / [] si no hay animaciones close / press */ } }`. El runtime coloca el origen de la entidad en `ojos + height - centerY`, de modo que `height` desplaza el CENTRO del panel respecto a los ojos.
Bone/cube `pivot`+`rotation` and the `parent` chain are honoured when computing `bonePos` (world bbox center of the bone and its descendants), `centerY` and the xray draw order (Bedrock rotation order ZYX, i.e. Rz*Ry*Rx, around the pivot). Duplicate bone names in `geo.json` fail the build.
With `xray` on, cubes outside the bones used as `elements[].bone`/`highlight` (and their descendants) are baked to world space and merged into `__bbui_g<n>` bones, one per effective visibility condition, with cubes sorted back to front by world z; element/highlight bones keep their pivot/rotation but absorb all their descendants' cubes (baked into the bone's local frame, sorted back to front), since Bedrock does not draw separate bones in list order.

**RP**
- `models/entity/bb_ui/<ID>.geo.json`: copia de `geo.json` con identifier `geometry.bb_ui.<ID>`.
- **Hueso raíz de orientación.** En TODAS las geometrías de la entidad (UI, `_digits`, `_backdrop`; la de la UI tras el aplanado xray) se añade primero el hueso `__bbui_yaw` (pivote `[0,0,0]`, sin cubos) y todos los huesos que eran raíz pasan a tener `parent: "__bbui_yaw"`; el orden de la lista (y por tanto el de dibujado) no cambia. `animation.bb_ui.<ID>.yaw` (loop, sin condición: siempre activa) fija `__bbui_yaw.rotation = [0, q.property('NS:yaw'), 0]`. Signo: Bedrock dibuja una entidad con yaw θ girando el modelo `180 - θ` (anti-horario visto desde arriba, mano derecha, en espacio Blockbench) y la rotación Y de un hueso Bedrock es el negativo de la de Blockbench; el yaw extra θ respecto a yaw 0 es por tanto `rotation Y = +θ` (igual que la animación vanilla `look_at`, que pone `q.target_y_rotation` directo en el hueso). `yaw` es nombre reservado (como `backdrop`) y `__bbui_yaw` nombre de hueso reservado. Como el telón y la calibración son hijos de la raíz, su `position` de la animación (`-NS:bd*16` en Z) va en el espacio local ya girado.
- `models/entity/bb_ui/<ID>_digits.geo.json`: `geometry.bb_ui.<ID>.digits`; por cada número, `digits` posiciones ×
  10 cubos planos (`<bone>_<pos>_<0-9>`) colocados sobre el cubo del hueso `number` (repartido en anchura).
- Telón (si `display.backdrop !== false` o `display.calibrate !== false`): `models/entity/bb_ui/<ID>_backdrop.geo.json`
  (`geometry.bb_ui.<ID>.backdrop`, textura 4x2) con el hueso `backdrop` (un quad de 6x6 bloques, sin profundidad, centrado en x=0 y
  en el centro vertical del panel, en z = 0 del origen de la entidad, cara norte = -Z hacia el espectador; la animación
  `animation.bb_ui.<ID>.backdrop` —loop, `scripts.animate` con condición `NS:viewer`— lo desplaza con
  `position: [0, 0, "-q.property('NS:bd') * 16"]`: px, 16 por bloque; en animaciones Bedrock solo X va espejado, Z es el eje de la
  geo, y la UI mira al espectador por -Z, así que -Z = hacia la cámara) y, si `calibrate`, el hueso
  `calib` (8 quads: 4 esquinas en L de 1.5 px de grosor y hasta 24 px de brazo, **por fuera** de las esquinas de `bbox` en x/y, en
  z = zMin - 0.5 px). `textures/bb_ui/<ID>_backdrop.png` (4x2 generado: 2 columnas izquierdas = color del telón con alfa = `opacity`,
  2 derechas = amarillo opaco #ffd23c para las esquinas). Render controller `controller.render.bb_ui.<ID>.backdrop`:
  `"*": viewer` (telón visible solo para el dueño), `calib`: `viewer && NS:calib`; si no hay telón el hueso `backdrop` no existe.
  Materiales nuevos en `RP/materials/entity.material`: `bb_ui.backdrop` (base `entity_alphatest`, solo `-FANCY`: **con** test y escritura de profundidad.
  Con `DisableDepthTest` la GPU tampoco escribe profundidad y las nubes/agua/partículas, dibujadas después, se veían por encima de la UI;
  ahora el telón oculta lo que hay detrás y lo dibujado después. Como ya hace test de profundidad, el quad se pega a la cámara con
  `NS:bd` para que ningún bloque entre cámara y UI lo tape) y, para que la UI se dibuje DESPUÉS del telón en el mismo pase
  de mezcla, `bb_ui.xray_blend` / `bb_ui.flat_blend` (bases `entity_alphablend`; mismos estados que `bb_ui.xray` / `bb_ui.flat`). Con telón
  activo la entidad usa las variantes `_blend` para la UI y el render controller del telón va **el primero** en `render_controllers`.
- `textures/bb_ui/<ID>.png` (copia) y `textures/bb_ui/digits.png` (10 glifos generados con el codificador PNG propio `bb_ui/lib/png.js`, 0-9 en tira horizontal).
- `entity/bb_ui/<ID>.entity.json`: dos texturas/geometrías, material `entity_alphatest` (sin iluminación:
  `"ignore_lighting": true` en el render controller), render controllers `controller.render.bb_ui.<ID>` y `...digits`,
  animaciones de foco y las de `animations.json`.
- `render_controllers/bb_ui/<ID>.json` con `part_visibility`:
  - `"*": "q.property('NS:viewer')"` (todo oculto para los demás).
  - Hueso de pantalla s: `q.property('NS:viewer') && q.property('NS:screen') == s`.
  - Con `visible_if`: además `&& q.property('NS:v<k>')`.
  - `highlight` del botón i en pantalla s: además `&& q.property('NS:focus') == i`.
  - Dígitos: `math.mod(math.floor(q.property('NS:n<k>') / math.pow(10, p)), 10) == d` (p = posición desde la derecha),
    ocultando ceros a la izquierda salvo la última posición.
- `animations/bb_ui/<ID>.animation.json`: `animation.bb_ui.<ID>.focus_<s>_<i>` = scale 1.08 del hueso del botón (loop);
  en el entity file `scripts.animate` con condición `q.property('NS:screen') == s && q.property('NS:focus') == i`
  (salvo que `animations.json` defina `focus.<hueso>` para ese botón, ver 3.1).

### 3.1 Animaciones de Blockbench (`animations.json`, opcional)
Formato Bedrock estándar. El filtro copia cada animación a `animations/bb_ui/<ID>.animation.json` como
`animation.bb_ui.<ID>.<S>` (junto a las de foco y `backdrop`), la declara en `animations` del entity file con el mismo nombre corto `<S>` y la añade a
`scripts.animate` con la condición de la tabla. Una animación no hace falta que esté en loop: se respeta lo que traiga (`loop`, `hold_on_last_frame`, `animation_length`).

**Nombre → rol.** Del nombre del documento se obtiene `N`: si empieza por `animation.`, el resto `R` se usa tal cual si empieza por `screen.`, `focus.` o `press.`;
si no, y `R` contiene un punto, se descarta el primer segmento hasta el primer punto (`animation.<modelo>.<N>`, lo que escribe Blockbench); si no, `N = R`.
Sin prefijo `animation.`, `N` es el nombre entero. `N` vacío es error. (Limitación: un modelo de Blockbench llamado `screen`, `focus` o `press` se confundiría con el rol.)
`S` = `N` en minúsculas con todo carácter fuera de `[a-z0-9_]` cambiado por `_` (`screen.shop` → `screen_shop`). Es error que dos animaciones den el mismo `S`, que `S` sea `backdrop` o `focus_<n>_<n>`.

| `N` | Condición en `scripts.animate` (P = `q.property('NS:…')`) | Efecto |
| --- | --- | --- |
| `idle` | `viewer` | siempre mientras la UI está abierta (típicamente loop) |
| `open` | `viewer` | una vez al aparecer la UI (pensada sin loop) |
| `close` | `viewer && closing` | una vez al cerrar; ver runtime. Necesita duración (`animation_length` o, si falta, el último keyframe) > 0 |
| `screen.<screenId>` | `viewer && screen == k` | mientras esa pantalla está activa (k = índice de la pantalla) |
| `focus.<hueso>` | `(screen == s && focus == i) \|\| …` una por cada pantalla s donde el hueso es botón (i = su índice de botón) | **sustituye** la escala 1.08 por defecto de ese botón |
| `press.<hueso>` | `(screen == s && press == i+1) \|\| …` análogo | una vez al aceptar ese botón |
| cualquier otro (p. ej. `model.spin`, `pulse`) | `viewer` | siempre mientras la UI está abierta (modelos importados en loop) |

**Una sola vez por activación.** Los roles `screen.<id>`, `open`, `close` y `press.<hueso>` que NO hacen bucle no van
directo en `scripts.animate` (una entrada condicional no vuelve a empezar al reactivarse: visto en juego, la transición se
quedaba en su primer fotograma). El filtro genera `controller.animation.bb_ui.<ID>.<S>` en
`RP/animation_controllers/bb_ui/<ID>.ac.json` con estados `default` → `play` (cuando la condición pasa a verdadera, la
animación arranca desde 0) → `default` (cuando deja de serlo), lo declara en el entity como `<S>_ctrl` y lo pone siempre en
`animate`. Si la animación no declara `loop`, el filtro le pone `hold_on_last_frame`. Con `loop: true` siguen directos.

**Validación.** Son errores (build falla): JSON inválido o sin objeto `animations`; `screen.<id>` con pantalla inexistente; `focus.<hueso>` / `press.<hueso>` con un hueso que no está en `geo.json` o que no es `button` en ninguna pantalla; `S` duplicado/reservado; `close` sin duración; que el total de propiedades supere 32.
Es un aviso (`console.warn`): un hueso animado (clave de `bones`) que no está en `geo.json` (se elimina de la animación).
`closing` y `press` solo existen (y solo cuentan para el límite de 32) si hay animación `close` / alguna `press.*`.

**Xray.** Todo hueso con clave en `bones` de **cualquier** animación de `animations.json` es "raíz preservada" al aplanar (ver 3): conserva nombre, pivote y padres, y absorbe los cubos de sus descendientes.

**Runtime.** `closeTicks` = `ceil(animation_length_close * 20)` (con tolerancia de 1e-6) (0 si no hay `close`); `pressTicks` = máximo `ceil(length*20)` (mín. 1) de las `press.*` (0 si no hay); `pressBones` = huesos con `press.*`.
- Cerrar (solo cierres limpios: `sneak`, `close`, `back`, `api`, ver Fundido): si `closeTicks > 0` y la UI ya se reveló, la sesión pasa a *closing*: pone `NS:closing = true`, ignora entrada (Saltar/Agachar/movimiento) y espera `closeTicks` ticks con la entidad intacta; después sigue el camino normal (fundido, restaurar cámara/HUD, eliminar entidad). Muerte, salida, error, `open_ui` y entidad inválida cierran al instante, también durante *closing*. Una sesión en *closing* sigue ocupando al jugador: `openUi` no abre otra hasta que termine.
- Aceptar un botón con `press.*` (tras comprobar `visible_if`): `NS:press = índice+1` y a los `pressTicks` ticks vuelve a 0 (también al cambiar de pantalla). La acción se ejecuta inmediatamente, sin esperar. Pulsar otra vez el mismo botón dentro de esa ventana no reinicia la animación.

## 4. Runtime (`BP/scripts/<scriptsPath>/`, copiado por el filtro; con `autoImport` se antepone `import "./<scriptsPath>/index.js"` al `entry` del módulo script del manifest BP)
- Lee `UI_REGISTRY`. Una sesión por jugador (`Map<playerId, Session>`), una entidad por sesión.
- Abrir: spawnea la entidad (anchor) con `initialRotation: 0` y la teletransporta solo con posición y `rotation {x:0,y:0}` (nunca `facingLocation`: el cliente interpolaría el yaw del cuerpo durante segundos). Justo después, antes del fundido, pone `yaw`, `bd`, `screen`, `focus`, `calib`, `n*`, `v*` con `setPropertyOverrideForEntity` (los overrides llegan tarde al cliente); solo `viewer` (que hace visible la UI) espera al revelado, donde además se reenvían `yaw` y `bd`. Pone `viewer`/`screen`/`focus`/`n*`/`v*` con `setPropertyOverrideForEntity` para el
  dueño (y valores reales por defecto = vacío), `camera.setCamera("minecraft:free", {location, facingLocation, easeOptions})`,
  `camera.setFov`, desactiva `InputPermissionCategory.Camera` y `LateralMovement`. Guarda el tag `bb_ui:<playerId>` en la entidad.
- Loop `runInterval` 1 tick: movimiento (`inputInfo.getMovementVector()`, umbral 0.5, retardo 4 ticks, solo al cambiar),
  refresca queries cada 10 ticks (números, condiciones, actionbar) y comprueba que la entidad sigue válida.
- Aceptar: `world.afterEvents.playerButtonInput` Jump Pressed. Salir: Sneak Pressed. También cierra en muerte, al salir del
  mundo (`playerLeave`), en spawn inicial y si la entidad se invalida. Al iniciar el mundo, elimina entidades
  de familia `bb_ui` huérfanas.
- Fundido (`display.fade`): al abrir y al cerrar (cierres "limpios": sneak, `close`, `back`, API) llama `player.camera.fade({ fadeTime: { fadeInTime, holdTime, fadeOutTime }, fadeColor: {red, green, blue} /* 0..1 */ })`.
  Al abrir, la parte visual (propiedades `viewer`, cámara con ease 0, ocultar HUD) se retrasa `round((in + hold/2) * 20)` ticks, hasta
  que la pantalla está en negro; al cerrar, la restauración visual (cámara, FOV, HUD, `viewer`, entidad, actionbar) se retrasa igual.
  Muerte, salida, error, `open_ui` y entidad inválida cierran al instante y sin fundido.
- HUD (`display.hide_hud`): al abrir `onScreenDisplay.setHudVisibility(HudVisibility.Hide, [PaperDoll, Armor, ToolTips, Crosshair, Hotbar, Health,
  ProgressBar, Hunger, AirBubbles, HorseHealth, StatusEffects, ItemText])`. El actionbar no es un `HudElement`, por lo que no se oculta;
  `TouchControls` se deja visible (hacen falta para Saltar/Agachar en móvil). Al cerrar (toda ruta) `resetHudElementsVisibility()`.
- Cursor (`display.cursor`, def. activado): mientras `player.inputInfo.lastInputModeUsed === InputMode.KeyboardAndMouse` la cámara
  del jugador se desbloquea (la vista sigue fija en la UI) y el giro del jugador mueve un cursor: girar `120 / sensitivity` grados
  recorre todo el ancho de la UI (derecha = +X del modelo, mirar abajo = cursor abajo); el pitch vuelve a 0 al pasar de ±45°. El botón
  visible cuyo rectángulo (bbox de sus cubos + 0.75 px, mínimo 6x6 px) contiene la punta recibe el foco. Clic = cualquier vía por la que
  llegue: `playerSwingStart`, `entityHitBlock`, y los eventos before `playerBreakBlock`, `playerInteractWithBlock`,
  `playerInteractWithEntity`, `itemUse` y `entityHurt` (atacante = el jugador), que además se cancelan (con la UI abierta no se rompen
  bloques ni se hiere a mobs); se deduplican 4 ticks por jugador. El clic pulsa el botón bajo el cursor. WASD oculta el cursor
  (`NS:cur` = false) y lo lleva al botón enfocado; con el cursor oculto el clic pulsa el botón enfocado; al mover el ratón reaparece.
  Filtro: propiedades `NS:cur` (bool) y `NS:cx`/`NS:cy` (float, px del modelo; cuentan 3 en el límite de 32), geometría
  `geometry.bb_ui.<ID>.cursor` (hueso `__bbui_cursor` bajo `__bbui_yaw`, alto = 4.5% del de la UI), textura
  `textures/bb_ui/<ID>_cursor.png` (la de `data/bb_ui/<ID>/cursor.png` si existe, punta en el píxel de arriba a la izquierda; si no, una
  flecha generada), render controller `controller.render.bb_ui.<ID>.cursor` (último: se dibuja encima, material `bb_ui.xray`, visible
  con `viewer && NS:cur`) y `animation.bb_ui.<ID>.cursor` (`position = [NS:cx, NS:cy, 0]`). El registro lleva
  `cursor: { sensitivity, bounds: [x0,y0,x1,y1], rects: { <hueso>: [x0,y0,x1,y1] } }` (null si `cursor:false`).
  Velocidad final = `ancho / 120°` × `display.cursor.sensitivity` × sensibilidad del jugador (`bb_ui:cursor_sens`, def. 1). Tras
  recentrar el pitch se ignoran 4 ticks de giro y cualquier giro de más de 35° en un tick (resincronización, no ratón).
  Rectángulos de clic: bbox + 1.2% del alto de la UI, mínimo 5% del alto; si se solapan gana el centro más cercano.
  Tooltips: no hay campo propio; el hueso `highlight` solo se ve con el foco, así que un texto dentro de él hace de tooltip.
- Calibración (`display.calibrate`, def. true): dynamic property del jugador `bb_ui:scale` (número, sin valor por defecto). Distancia efectiva =
  `display.distance / scale` (escala fijada a 0.5..2.0; si la UI tiene `calibrate:false` se ignora). Al abrir cualquier UI con `bb_ui:scale`
  sin definir se hace primero una sesión de calibración en esa misma UI: se muestra normal + `NS:calib = true` (esquinas de `bbox`), el actionbar
  es `W/S: tamaño  ·  Saltar: guardar  ·  Agachar: por defecto` (los botones de la UI no responden). W/S: ±0.05 de escala cada 2 ticks
  mientras se mantiene, recolocando la entidad en vivo. Saltar guarda `bb_ui:scale` y continúa a la UI normal (`calib = false`);
  Agachar guarda 1.0 y continúa. Comando `<namespace>:calibrate` (namespace de las UIs: Bedrock exige un solo namespace para todos los comandos custom del pack; permiso `any`, registrado si alguna UI tiene `calibrate !== false`): borra
  `bb_ui:scale` y abre la calibración en la última UI abierta por el jugador (o la primera del registro con calibración).
- Cerrar: `camera.clear()`, `setFov` por defecto (`camera.clear` + `setDefaultCamera` si hace falta), restaura permisos,
  elimina la entidad, limpia actionbar.
- API pública (`BP/scripts/<scriptsPath>/api.js`, reexportada por `index.js`):
  `registerUiFunction(name, (player, ctx) => void)`, `registerUiQuery(name, (player) => number|string)`,
  `openUi(player, id, {source?})`, `closeUi(player)`, `isUiOpen(player)`, `gotoScreen(player, screenId)`,
  `refreshUi(player)`, `openCalibration(player, uiId?)` (abre la UI en modo calibración aunque `bb_ui:scale` ya exista; `uiId` def. última abierta / primera con calibración; no borra `bb_ui:scale`). `ctx = { uiId, screen, bone, args, session }`.
