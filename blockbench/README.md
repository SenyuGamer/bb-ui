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
4. Panel **UI Element** (con un grupo seleccionado): rol, pantalla, accion del boton (goto/back/close/settings/command/script/set/add/open_ui/sequence),
   navegacion arriba/abajo/izquierda/derecha, highlight, tooltip, `visible_if`, y query/digits/align para numeros.
   La accion `settings` (sin campos) abre en juego el formulario de ajustes del jugador; en *Preview navigation* solo muestra un aviso.
5. Panel **UI Settings**: id, namespace, display, **cursor**, metodos de apertura (item/block/entity/command, con `generate` opcional) y queries.
6. Panel **UI Animations**: lista todos los roles animables (`idle`, `open`, `close`, `screen.<id>`, `focus.<boton>`, `press.<boton>`) y si ya
   existe una animacion de Blockbench para cada uno. **Crear** anade la animacion con el nombre correcto (`animation.<id de la UI>.<rol>` para
   idle/open/close, `animation.<rol>` para screen/focus/press), el loop del contrato (idle/screen/focus en loop; open/close/press una vez) y una
   duracion por defecto (open 0.5 s, close 0.5 s, press 0.25 s, el resto 2 s; focus 0.5 s) y la selecciona; **Editar** cambia al modo Animate con
   esa animacion. Las animaciones con un nombre que no encaja salen como avisos: `screen.<id>` / `focus.<hueso>` / `press.<hueso>` con pantalla u
   hueso inexistente hacen fallar el build; cualquier otro nombre (p. ej. `pulse`) se reproduce siempre mientras la UI esta abierta. La
   exportacion ya escribe `animations.json` con todas las animaciones del proyecto.
7. **UI: Validate** y **UI: Export to pack**. La primera vez pide la carpeta `<tu proyecto Regolith>/packs/data/bb_ui` (se recuerda; "Set export folder" la cambia).
   La exportacion valida primero y se aborta si hay errores.
8. En tu proyecto Regolith: `regolith run build`.

Los datos viajan dentro del `.bbmodel` (clave `bbui`). Los huesos ocultos por la pantalla activa se muestran temporalmente al exportar la geometria.

### Tooltips

Selecciona un boton -> panel **UI Element** -> caja *Tooltip*: texto, fuente (de las de UI Settings -> Fonts), lado (derecha / izquierda / arriba / abajo)
y fondo opcional (**Elegir fondo** abre el selector de rectangulos de la textura; **Quitar** lo borra). Se regenera solo al cambiar (con una pequena
pausa) o con **Generar**. El plugin crea un grupo `<highlight>_tip` dentro del hueso highlight del boton (si no tiene, crea `<boton>_hl` vacio y
lo asigna): fondo + texto, junto al boton y un poco por delante. El runtime solo dibuja el highlight con el foco, asi que el tooltip aparece
solo en el boton enfocado. Borrar el texto elimina el grupo. Los datos van en `editor.tooltips[<hueso>]` (solo editor, no se exporta; renombrar el
hueso los mantiene). "Mostrar tooltips" en UI Screens los oculta en el editor. Supone una UI plana sin rotacion, mirando a -Z.

### Cursor de raton

UI Settings -> *Cursor*: casilla "Cursor de raton" (apagada = `display.cursor: false`), "Sensibilidad" (`display.cursor.sensitivity`, solo se
escribe si no es 1) e "Imagen del cursor": cualquier otra textura del proyecto, que se exporta como `cursor.png` (la punta es el pixel de arriba a
la izquierda). Sin imagen se usa la flecha por defecto y se borra un `cursor.png` antiguo. La eleccion se guarda en `editor.cursorTexture`.

### Plantillas

Menu **UI -> Nueva UI desde plantilla**: *Menu con botones* (N opciones con `goto` a pantallas de ejemplo + Salir), *Libro con paginas* (N paginas
con flechas anterior/siguiente y cerrar) o *Confirmacion Si/No* (Si ejecuta `say Confirmado` y cierra; cambia el `command`). Eliges titulo
(solo A-Z, 0-9 y `. , ! ? : -`) y los colores de panel, boton, texto y resaltado. Genera una textura `ui_atlas` de 128x128 (panel, boton, marco de
resaltado, flechas y una fuente de pixeles 5x7 registrada como `ui_font`), los grupos planos mirando a -Z sin rotacion, las pantallas, los
highlights, la navegacion automatica, las acciones y un tooltip por boton, ademas de `start_screen`, `default_focus`, `display.distance` y, si no
habia, un metodo de apertura por comando. Funciona sobre el proyecto Minecraft UI actual (avisa si ya tiene grupos y reemplaza las pantallas).
La textura se marca como principal en `editor.mainTexture`. Queda listo para exportar y construir sin pasos manuales.

### Datos solo del editor

`Project.bbui.editor` (tooltips, textura del cursor, textura principal) viaja en el `.bbmodel` pero `exportTo` lo elimina de `ui.json`, igual que `fonts`.

## Como se traduce a juego

| En el plugin | En `ui.json` / juego |
| --- | --- |
| Grupo sin rol | hueso siempre visible (fondo comun) |
| Decoracion de pantalla | `screens[].bones`: visible solo en esa pantalla |
| Boton / Imagen / Modelo / Numero | `screens[].elements[]` con `type` button/image/model/number |
| Highlight | `highlight`: visible solo con ese boton enfocado |
| Navegacion `auto` | sin clave `nav.<dir>`: vecino mas cercano con la regla del runtime (cono de ~63 grados, posiciones del geo exportado: x de Blockbench negada); `ninguno` escribe `null` |
| Accion | `action` ejecutada al aceptar (Saltar) |
| visible_if / numero | propiedades de entidad `v<k>` / `n<k>` (maximo 32 por entidad, el validador lo cuenta) |

## Scripting

`window.BBUIBuilder = { getData, setData, exportTo(path, {force}), exportAndBuild, validate, core, addImage, addText, addFont, applyTemplate(opts), generateTooltip(bone), setTooltip(bone, {text, font, side, bg}, now), createUiAnimation(rol), editUiAnimation(rol), previewMove, previewAccept, bonePositions, ... }`.

## Limitaciones

- No hay etiqueta con el tipo de accion en el outliner (solo se ve en el panel UI Element).
- Renombrar un hueso en el outliner no actualiza `ui.json`; el validador avisa de los huesos que faltan.
