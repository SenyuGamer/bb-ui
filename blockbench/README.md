# BB UI Builder (plugin de Blockbench)

Disena UIs 3D de Minecraft Bedrock. Cada hueso del modelo es un elemento (boton, imagen, modelo, numero) y el plugin exporta
`ui.json` + `geo.json` + `texture.png` + `model.bbmodel` a `<regolith dataPath>/bb_ui/<id>/`. Contrato completo:
[`docs/CONTRACT.md`](../docs/CONTRACT.md).

## Instalar

Blockbench (escritorio, 4.10+) -> File -> Plugins -> icono "Load Plugin from File" -> elegir `blockbench/bb_ui_builder.js`.
Hay que recargarlo tras editar el archivo.

## Modo artista (por defecto)

Un solo panel, **UI** (barra derecha, modo UI), para quien solo dibuja ventanas, transiciones, personajes y dice a que ventana va cada boton.
Todo lo demas (paneles Ventanas, Inspector, Ajustes y Animaciones, menus avanzados) queda oculto hasta marcar **Modo programador** (casilla al final del panel).

- **Ventanas**: clic = ver solo esa ventana (mas la carpeta `comunes`) y encuadrar la vista; estrella = ventana inicial; lapiz = renombrar; X = borrar.
  *+ Ventana* crea la carpeta `ventana_<nombre>` y la ventana. `comunes` (se ve siempre) se crea al hacer comun una pieza o con una plantilla.
- **Seleccionado**: clic en el visor selecciona la pieza (grupo dentro de la carpeta de la ventana o de `comunes`). *Es: Decoracion / Boton*; un boton
  tiene *Al pulsar va a*: Ventana / Volver / Cerrar. Un personaje muestra *Tamano x* y *Quitar*.
- **Transicion al entrar**: Ninguna, deslizar (arriba, abajo, izquierda), zoom o Personalizada (animacion vacia `animation.screen.<id>`, abre el modo Animate).
- **+ Imagen / + Texto / + Boton** crean la pieza dentro de la carpeta de la ventana activa. **+ Personaje** pide un `.bbmodel`, lo une al proyecto dentro de
  `personaje_<nombre>`, **junta su textura con la principal** (debajo, la textura queda mas alta) y conserva sus animaciones (suenan siempre en el juego).
  Es una accion sin deshacer: guarda antes.
- **Probar en el juego**: guarda el proyecto dentro de `packs/data/bb_ui/<ui>/` (Guardar como), pulsa el boton y espera el aviso "Listo: abre el mundo y usa /<comando>".
  Al guardar a mano dentro de esa carpeta, el plugin exporta `ui.json`, `geo.json`, `texture.png` y `animations.json` ahi mismo (y pregunta una vez si el id debe llamarse como la carpeta).
- Un proyecto nuevo abre en modo UI y, si esta vacio, ofrece empezar con una plantilla. Las plantillas generan `comunes` (fondo) y una carpeta `ventana_<id>` por ventana; sin resaltados ni tooltips salvo en Modo programador.

## Flujo de trabajo del programador (Modo programador)

1. File -> New -> **Minecraft UI** (o *Nueva UI desde plantilla*). Arriba a la derecha hay un cuarto modo, **UI**. Al entrar, la camara pasa
   a una **vista de juego** (ortogonal, de frente, centrada en la UI) y se dibuja el **marco de pantalla** (16:9, activo por defecto).
   Al salir se restaura tu camara. La constante `VIEW_PRESET` (arriba del plugin) elige el angulo; el boton *Vista de juego* la reaplica.
2. Panel izquierdo **Ventanas**: botones grandes *+ Boton*, *+ Texto*, *+ Imagen*, *Probar* (navegacion con flechas/Enter/Esc),
   *Exportar* (exporta y construye si ya hay carpeta configurada), *Ajustes* y *Vista de juego*. Debajo, la lista de ventanas: clic = editar esa
   ventana, doble clic o lapiz = renombrar, estrella = ventana inicial, X = eliminar (pide confirmacion). Casillas: *Mostrar todas las capas*,
   *Marco de pantalla*, *Mostrar textos de ayuda*.
3. **Clic en el visor** para elegir un elemento: se selecciona el elemento entero de la ventana activa (boton, su resaltado o su texto de ayuda)
   y se puede arrastrar completo. Los grupos elegidos en el outliner se respetan tal cual.
4. Panel derecho **Inspector** (sigue a la seleccion):
   - nada seleccionado: la ventana (nombre, boton inicial; en *Avanzado* texto actionbar y decorado);
   - un boton: nombre, **Al pulsar** (ir a otra ventana, volver, cerrar, abrir ajustes, abrir otra UI, comando, funcion de script,
     guardar/sumar un valor, varias acciones), **Texto de ayuda**, **Resaltado al enfocar** (*Crear resaltado* dibuja un marco de 4 barras;
     usa la zona de textura del resaltado de la plantilla o la ultima elegida, y si no hay ninguna te deja elegirla) y *Avanzado*
     (navegacion, grupo del resaltado, `visible_if`);
   - imagen / numero / modelo: sus campos con nombres en castellano;
   - un grupo que no es de esta ventana: *Convertir en boton / imagen* o *Anadir como decorado*.
5. **+ Boton** crea un boton terminado (placa + texto "BOTON" si hay fuente + resaltado si se conoce su textura), ya registrado y seleccionado.
6. **Ajustes** abre el panel *Ajustes de la UI* (distancia, campo de vision, sonidos, como se abre, valores, cursor, fuentes, validar/exportar);
   desde ahi, *Animaciones...* abre *Animaciones de la UI* (roles animables, ver `docs/CONTRACT.md` 3.1). Ambos paneles solo existen mientras estan abiertos.
7. En tu proyecto Regolith: `regolith run build`. La primera exportacion pide la carpeta `<tu proyecto Regolith>/packs/data/bb_ui`.

Los menus **UI** siguen disponibles. Si venias de una version anterior y los paneles quedan mal colocados, restablece el layout de Blockbench.
Los datos viajan dentro del `.bbmodel` (clave `bbui`). Los huesos ocultos por la ventana activa se muestran temporalmente al exportar la geometria.

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
