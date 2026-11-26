# BB UI Builder (plugin de Blockbench)

Disena UIs 3D de Minecraft Bedrock. Cada hueso del modelo es un elemento (boton, imagen, modelo, numero) y el plugin exporta
`ui.json` + `geo.json` + `texture.png` + `model.bbmodel` a `<regolith dataPath>/bb_ui/<id>/`. Contrato completo:
[`docs/CONTRACT.md`](../docs/CONTRACT.md).

## Instalar

Blockbench (escritorio, 4.10+) -> File -> Plugins -> icono "Load Plugin from File" -> elegir `blockbench/bb_ui_builder.js`.
Hay que recargarlo tras editar el archivo.

## Flujo de trabajo

1. File -> New -> **Minecraft UI**. Se crean los datos por defecto (id desde el nombre, namespace `bbui`, pantalla `main`).
   Arriba a la derecha aparece un cuarto modo, **UI** (junto a Editar / Pintar / Animar): ahi estan los paneles UI Screens,
   UI Element y UI Settings, con el outliner y las texturas. Modela en Editar y pinta en Pintar; todo lo de UI se hace en el modo UI.
2. Menu **UI** (o el "+" del outliner): *Add Button / Image / Number / Model Slot*. Cada uno crea un grupo con un plano plano
   mirando al norte (-Z) y lo asigna a la pantalla activa. *Add Button* crea ademas `btn_N_hl` (resaltado, un poco mas grande y detras).
   Pinta la textura (unica) como siempre.
3. Panel **UI Screens**: anade/renombra/elimina pantallas, elige la de inicio, activa una (oculta los huesos de las demas; "Mostrar todo"
   los enseña), `default_focus` y `actionbar`. *Preview navigation*: foco con flechas/Enter/Esc usando la misma regla que el runtime.
4. Panel **UI Element** (con un grupo seleccionado): rol, pantalla, accion del boton (goto/back/close/command/script/set/add/open_ui/sequence),
   navegacion arriba/abajo/izquierda/derecha, highlight, `visible_if`, y query/digits/align para numeros.
5. Panel **UI Settings**: id, namespace, display, metodos de apertura (item/block/entity/command, con `generate` opcional) y queries.
6. **UI: Validate** y **UI: Export to pack**. La primera vez pide la carpeta `<tu proyecto Regolith>/packs/data/bb_ui` (se recuerda; "Set export folder" la cambia).
   La exportacion valida primero y se aborta si hay errores.
7. En tu proyecto Regolith: `regolith run build`.

Los datos viajan dentro del `.bbmodel` (clave `bbui`). Los huesos ocultos por la pantalla activa se muestran temporalmente al exportar la geometria.

## Como se traduce a juego

| En el plugin | En `ui.json` / juego |
| --- | --- |
| Grupo sin rol | hueso siempre visible (fondo comun) |
| Decoracion de pantalla | `screens[].bones`: visible solo en esa pantalla |
| Boton / Imagen / Modelo / Numero | `screens[].elements[]` con `type` button/image/model/number |
| Highlight | `highlight`: visible solo con ese boton enfocado |
| Navegacion `auto` | sin clave `nav.<dir>`: vecino mas cercano (derecha de pantalla = -X del modelo); `ninguno` escribe `null` |
| Accion | `action` ejecutada al aceptar (Saltar) |
| visible_if / numero | propiedades de entidad `v<k>` / `n<k>` (maximo 32 por entidad, el validador lo cuenta) |

## Scripting

`window.BBUIBuilder = { getData, setData, exportTo(path, {force}), validate, core }`.

## Limitaciones

- No hay etiqueta con el tipo de accion en el outliner (solo se ve en el panel UI Element).
- Renombrar un hueso en el outliner no actualiza `ui.json`; el validador avisa de los huesos que faltan.
