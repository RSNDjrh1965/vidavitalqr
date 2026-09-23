
# Estado del sistema de envío automático — VidaVitalQR

Última actualización: 2026-09-22

## 1. Corrección: restauración incompleta al renovar una ficha

**Problema:** al renovar una ficha (persona o mascota), el formulario precargaba los datos de texto correctamente, pero la fotografía, la tabla de medicamentos, los archivos importantes adjuntos y (en mascotas) el estado de vacunas quedaban vacíos.

**Causa:** el objeto `datosFormulario` que se guarda en `login/<folio>.json` al procesar una ficha nunca incluía esos campos, así que no había nada que restaurar.

**Solución aplicada** (en `ficha.html` y `ficha-mascota.html`):
- Se agregaron `fotoBase64`, `medicamentos` (solo persona), `archivosImportantes` y `vacunas` (solo mascota) al objeto `datosFormulario` que se envía al guardar.
- Se refactorizó el manejo de archivos adjuntos: de un arreglo de objetos `File` (no serializable a JSON) a un arreglo de objetos planos `{name, size, dataUrl}`, para que puedan guardarse y restaurarse correctamente.
- `precargarDatosFicha()` ahora restaura la foto, la tabla de medicamentos, los archivos adjuntos y el estado de vacunas.

Confirmado funcionando en producción por el usuario con la ficha `VVITALQR00000071`.

## 2. Corrección: la edad no se recalculaba al renovar

**Problema:** al precargar una ficha para renovación, el campo "Edad" quedaba en blanco aunque la fecha de nacimiento sí se restauraba.

**Causa:** el campo de fecha de nacimiento tiene un listener en el evento `input` que calcula la edad, pero al restaurar el valor programáticamente (`.value = ...`) ese evento no se dispara solo.

**Solución:** se agregó `$('fnac').dispatchEvent(new Event('input'));` justo después de restaurar la fecha, en ambos formularios. Verificado con pruebas automatizadas contra las fechas exactas reportadas por el usuario.

## 3. Recuperación de PIN por autoservicio (tres factores)

Se creó una sección de "¿Olvidaste tu PIN?" en el panel de renovación de todos los formularios de ficha, que permite recuperar el código sin depender de WhatsApp.

**Verificación de identidad (tres factores):** folio de la ficha + nombre completo (o descripción, para objetos) + fecha (de nacimiento, o de registro, para objetos), tal como quedaron guardados. Se exige el folio además de los otros dos datos porque estos, por sí solos, son datos que otra persona podría conocer o adivinar.

**Backend:** función `netlify/functions/recuperar-ficha.js`. Nunca revela cuál de los tres datos falló — siempre el mismo mensaje genérico de error, para no facilitar que alguien vaya probando combinaciones.

**Diseño de la experiencia (definido junto con el usuario):**
- El botón "Buscar mi PIN" se mantiene (no se auto-revela mientras se escribe) — el usuario decide cuándo iniciar la verificación.
- Una vez verificados los tres datos, se ofrecen **dos opciones**:
  1. **"Ver mi PIN en pantalla (15 seg.)"** — muestra el PIN en texto durante 15 segundos con una cuenta atrás visible ("se ocultará en N segundos"), y luego lo oculta automáticamente (cambia el campo a tipo contraseña) para no dejarlo expuesto en una computadora compartida. El campo de PIN queda cargado igual, así que "Continuar" sigue funcionando después de que se oculta.
  2. **"Enviármelo por correo"** — envía el folio y el PIN al correo de contacto registrado en la ficha (nunca se devuelve el PIN en la respuesta del servidor en este caso, solo se confirma el correo de destino enmascarado, ej. `ca***@example.com`).

Ambas opciones dejan el campo de PIN cargado (visible u oculto según la opción) para poder continuar la renovación en la misma sesión sin volver a buscarlo.

## 4. Correo del contacto 1 obligatorio + envío automático del código (folio + PIN)

**Cambios en todos los formularios de ficha:**
- El campo de correo del contacto 1 pasó de opcional a **obligatorio**, con validación en el propio formulario antes de generar el PDF.
- El texto de ayuda explica que ese correo es obligatorio, que ahí se recibirá el código de acceso cada vez que se cree o actualice la ficha, el aviso automático cuando alguien escanee el QR, y cualquier información importante relacionada con la ficha.

**Cambio en `netlify/functions/send-ficha.js`:**
- Función `enviarCodigoPorCorreo()` que envía el folio + PIN vigente, por correo (Resend), a **todos** los contactos que tengan correo registrado (contacto 1 y, si también tiene correo, contacto 2 — deduplicados), cada vez que se procesa una ficha — sea nueva o una actualización. Así cualquiera de los contactos siempre tiene a la mano el código más reciente, sin depender de que el titular lo guarde por su cuenta.
- Este correo lleva **solo el folio y el PIN** — el código QR nunca se envía por correo (ver la corrección del punto 17); el QR solo se muestra en pantalla al crear o renovar la ficha.
- **2026-09-15 (ver punto 30):** esta función no revisaba si Resend realmente aceptaba el envío — solo un fallo de red hacía que se registrara algo; un rechazo de Resend (por ejemplo, dominio no verificado) quedaba completamente invisible. Corregido — ver punto 30.

## 5. Organización de los buckets por tipo (personas/ vs mascotas/ vs objetos/)

El usuario pidió poder revisar los buckets de S3 con más orden, separando cada tipo de ficha. Se optó por carpetas dentro de cada bucket existente (no buckets nuevos), para no tener que mover nada de lo ya guardado.

**Cómo se decide la carpeta:** el folio mismo ya distingue el tipo sin ambigüedad — el de persona siempre empieza con `VVITALQR`, el de mascota con `VVMASCOTA`, y el de objeto (agregado en el punto 15) con `VVOBJETO` (contadores independientes, prefijos distintos). Se agregó una función `carpetaTipo(tipo, folio)` (o su equivalente en línea) en cada función afectada, que usa el folio como fuente de verdad y el campo `tipo` solo como respaldo.

**Cada ficha nueva o renovada guarda:**
- PDF y foto en `personas/`, `mascotas/` u `objetos/` dentro del bucket `vidavitalqr`.
- El código QR en la misma carpeta correspondiente dentro de `vidavitalqr-qr`.
- El registro de acceso (folio + PIN) en `<carpeta>/login/` dentro de `resumen-vidavitalqr`.
- El cuadro resumen, separado por tipo: `personas/resumen.xlsx`, `mascotas/resumen.xlsx` y `objetos/resumen.xlsx`.
- **Desde el punto 42:** también la dirección de envío, en `<carpeta>/envio/` dentro de `resumen-vidavitalqr` (bucket privado — ver ese punto).

**Compatibilidad con lo ya existente:** nada de lo guardado antes de este cambio se movió. `login-ficha.js`, `recuperar-ficha.js` y `ver.js` revisan primero la carpeta nueva y, si no encuentran el dato ahí, buscan en la ubicación anterior (sin carpeta).

Verificado con pruebas simuladas (S3 y Resend simulados) para los tres tipos de ficha, incluyendo el flujo completo de objeto (ver punto 15).

## 6. Sección "Garantías y políticas" en el landing (index.html)

Sección `#garantias`. Originalmente 4 tarjetas (garantía de la placa, tiempo de entrega, renovación anual, política de reembolso); **el 2026-09-14 se redujo a 3 tarjetas** — ver punto 21.

## 7. Archivos afectados en el proyecto hasta ahora

- `ficha.html` — restauración de foto/medicamentos/archivos, corrección de edad, correo obligatorio, panel de recuperación de PIN, código QR desplegado en pantalla al crear/renovar, generación de la imagen del "Identificador QR" (punto 18), envío del estilo de placa elegido (punto 18), corrección `placaEstilo is not defined` (punto 20), modo "actualizar" con validación de 12 meses (punto 22), corrección `esRenovacion is not defined` (punto 29), despliegue de la fecha de inicio de vigencia al confirmar código/PIN (punto 35), corrección del flujo de regreso al landing tras enviar/actualizar la ficha, ya confirmada funcionando en producción (punto 36), corrección para que el folio quede visible debajo de la foto en el PDF generado (punto 38), desde el punto 41: indicador discreto "En proceso" junto a los botones mientras se genera el PDF/se guarda la ficha, desde el punto 43: compresión de adjuntos más agresiva y validación de peso total antes de enviar (mitigación del error 413), desde el punto 52: nuevo aviso de pantalla completa "Procesando su ficha…" (con mensaje de no cerrar ni recargar la página), que se muestra justo antes de generar el PDF, reforzando al indicador "En proceso" que ya existía, **desde el punto 54: sistema completo de 4 idiomas (ES/EN/FR/PT) agregado por primera vez a este formulario — selector `#langbar`, objeto `TEXTOS_FICHA` con 103 claves por idioma, `data-i18n`/`data-i18n-html`/`data-i18n-ph`/`data-i18n-title` en toda la interfaz, y el idioma elegido (`LANG_FICHA`) ahora viaja junto con la ficha al backend (campo `idioma` en el envío a `send-ficha.js`) — ver ese punto para el detalle completo**, desde el punto 55: texto del nombre de marca, las 2 etiquetas verticales laterales y el número de folio ligeramente agrandados, y la fotografía ampliada de 250×250px a 278×278px, en la generación del "Identificador QR" (`generateTarjetaBlob`) — ver ese punto para el detalle completo, y **desde el punto 56: el idioma inicial ya no se detecta del navegador — siempre arranca en español salvo que la persona ya tenga un idioma guardado (`localStorage`) o llegue con `?lang=` explícito — ver ese punto.**
- `ficha-mascota.html` — mismos cambios base, adaptados a mascota (incluye restauración de vacunas), sistema de 4 idiomas (punto 19), modo "actualizar" con validación de 12 meses (punto 22), corrección `esRenovacion is not defined` (punto 29), despliegue de la fecha de inicio de vigencia (punto 35), corrección del flujo de regreso al landing, ya confirmada funcionando en producción (punto 36), desde el punto 41: indicador "En proceso" (traducido a los 4 idiomas, clave `procBadgeTexto`), desde el punto 43: misma mitigación del error 413, desde el punto 52: mismo aviso de pantalla completa "Procesando su ficha…", traducido a los 4 idiomas (claves `procOverlayTitulo`/`procOverlayTexto`), y desde el punto 54: el idioma elegido (`LANG_FICHA`) ahora también viaja junto con la ficha al backend (campo `idioma`), igual que en las otras dos fichas — el sistema de idiomas en sí ya existía desde el punto 19, sin cambios ahí. Ya tenía correcto el folio visible en el PDF desde antes (referencia usada para el punto 38 en las otras dos fichas). Sin cambios en el punto 55. **Desde el punto 56: mismo cambio de idioma por defecto a español que las otras dos fichas.**
- `ficha-objeto.html` — ficha de identificación de objetos, mismo flujo y formato que las otras dos (folio `VVOBJETO`, PIN, renovación, recuperación de PIN, código QR en pantalla), modo "actualizar" con validación de 12 meses (punto 22), corrección `esRenovacion is not defined` (punto 29), despliegue de la fecha de inicio de vigencia (punto 35), corrección del flujo de regreso al landing, ya confirmada funcionando en producción (punto 36), corrección para que el folio quede visible debajo de la foto en el PDF generado (punto 38), desde el punto 41: indicador "En proceso", desde el punto 43: misma mitigación del error 413, desde el punto 52: mismo aviso de pantalla completa "Procesando su ficha…", y desde el punto 54: sistema completo de 4 idiomas agregado por primera vez (mismo esquema que `ficha.html`, 106 claves por idioma, adaptadas a los campos propios de un objeto), con el idioma elegido viajando también al backend. Sin cambios en el punto 55. **Desde el punto 56: mismo cambio de idioma por defecto a español que las otras dos fichas.**
- `netlify/functions/send-ficha.js` — envío automático del código (folio + PIN, sin QR) por correo a todos los contactos con correo registrado, en cada guardado; organización por carpetas (`personas/` / `mascotas/` / `objetos/`); subida del "Identificador QR" y guardado del estilo de placa elegido; reinicia la fecha de inicio de vigencia (`creado`) solo cuando el envío viene marcado como renovación pagada (punto 22); ahora detecta y reporta (en el correo de aviso al administrador) cuando Resend rechaza el envío del código a algún contacto (punto 30); desde el punto 39, el texto del estilo de placa que se reporta al administrador incluye también el número (1-4) y las medidas exactas de la placa elegida; desde el punto 54: recibe y valida el idioma elegido al llenar la ficha (`idioma`, uno de ES/EN/FR/PT, con respaldo a español ante cualquier valor inesperado), lo guarda junto con la ficha en el JSON público que consulta `avisar-escaneo.js`, y el correo de código de acceso (`enviarCodigoPorCorreo`) ahora se envía traducido a ese mismo idioma — ver ese punto para el detalle completo. Sin cambios en el punto 55 ni en el punto 56.
- `netlify/functions/recuperar-ficha.js` — recuperación de PIN por tres factores; organización por carpetas incluyendo `objetos/`.
- `netlify/functions/login-ficha.js` — organización por carpetas incluyendo `objetos/`, con respaldo a la ubicación anterior; ahora también devuelve la fecha `creado` de la ficha (punto 22), usada desde el punto 35 para mostrarla explícitamente al usuario.
- `netlify/functions/ver.js` — organización por carpetas incluyendo `objetos/`; visor público adaptado para mostrar los campos propios de un objeto (tipo, marca, señas particulares); ya no envía el aviso de escaneo él mismo (ver punto 10); solicita permiso de ubicación exacta al celular de quien escanea (persona, mascota u objeto por igual) y avisa a `avisar-escaneo.js` con o sin coordenadas según la respuesta — confirmado de nuevo en el punto 41, sin cambios necesarios en ese momento. Desde el punto 49: ya no depende únicamente del diálogo nativo del navegador (que solo pregunta la primera vez por sitio) — ahora la propia página muestra un recuadro con una pregunta explícita ("¿Autoriza compartir su ubicación exacta...?", Sí/No) antes de intentar obtener ninguna coordenada, y solo si la persona elige "Sí" se llama a la geolocalización del navegador; aplica igual a los 3 tipos de ficha. Confirmado por el usuario funcionando correctamente en producción (2026-09-18). Revisado a fondo en el punto 55 (observación 1 del documento del 2026-09-22): el código actual ya traduce correctamente el 100% de su contenido en los 4 idiomas — la falla que reportó el usuario corresponde a una versión anterior todavía publicada en producción, no a un bug del código actual. **Desde el punto 56: mismo cambio de idioma por defecto a español (arranca en español salvo `localStorage` o `?lang=` explícito), consistente con el resto del sitio.**
- `netlify/functions/avisar-escaneo.js` — envía el aviso de escaneo con la ubicación; adaptado para folios de objeto (mensaje y asunto propios); el texto del correo ya distingue explícitamente si la ubicación es la exacta compartida por quien escaneó o una aproximada calculada por IP (confirmado en el punto 41, sin cambios necesarios). Desde el punto 48: la línea "Ficha completa: ..." ya no muestra la URL completa del bucket de S3 — se muestra una versión acortada/enmascarada, y la versión HTML del correo (agregada en ese mismo punto) mantiene ese texto acortado como un enlace real y funcional hacia el PDF verdadero. Corregido en el punto 53: el enlace de la ubicación (Google Maps) había dejado de ser clickeable en la versión HTML del correo — solo el enlace "Ficha completa" seguía funcionando — ver ese punto para el detalle completo del bug y la corrección. Desde el punto 54: el correo completo (asunto, introducción, explicación, textos de ubicación exacta/aproximada, etiqueta "Ficha completa" y nota final) ahora se envía en el idioma que la persona tenía elegido al llenar o renovar su ficha (leído de `datos.idioma`, guardado por `send-ficha.js`), con la fecha/hora del escaneo también formateada según ese idioma — ver ese punto para el detalle completo. Investigado en el punto 55 (observación 6): no fue posible probar ni cambiar el servicio de geolocalización por IP (`ipwho.is`) en este entorno de trabajo por falta de salida a internet hacia servicios externos; se documentó la limitación inherente de la geolocalización por IP (ubica la salida del proveedor de datos móviles, no el dispositivo). Sin cambios de código en el punto 55 ni en el punto 56.
- `netlify/functions/get-testimonials.js`, `list-pending-testimonials.js`, `moderar-testimonial.js` — sistema de moderación y despliegue público de opiniones aprobadas.
- `netlify/functions/crear-pago.js` — crea la Checkout Session alojada en ONVO Pay para el pago real; primera fase solo renovaciones (punto 31), ampliada a cualquier combinación de productos del carrito (punto 33), con el precio de la Placa con código QR actualizado a $13 (punto 34); desde el punto 40, valida y transmite en la metadata de ONVO Pay cuál de las 4 placas (estilo) eligió el comprador de "Placa con código QR — Personal". Desde el punto 55: agrega un costo de envío de $8.50 (una sola vez por pedido, cubre hasta 5 productos físicos) cuando el carrito incluye al menos un producto físico (placa, pulsera, cadena o Identificador QR), recalculado siempre en el servidor y nunca confiando en el monto que mande el navegador; el envío se suma antes del IVA (13%) y viaja en la metadata de ONVO Pay (`envio`) para que `onvo-webhook.js` lo reporte. Sin cambios en el punto 56.
- `netlify/functions/onvo-webhook.js` — recibe el webhook de ONVO Pay, confirma el pago consultando directamente a su API, y avisa por correo al administrador; ampliado en el punto 33 para reportar una lista de productos (no solo una renovación) por sesión de pago; desde el punto 38, el aviso de pago confirmado llega a `roljamher@hotmail.com` (antes `vidavitalqr@zohomail.com`) y además del texto plano incluye una versión HTML con los productos comprados resaltados visualmente; desde el punto 40, además traduce cada producto a su nombre real (en vez del identificador interno, ej. "plate_personal") y, para la placa personal, indica cuál de las 4 (número y medidas) se compró. Este correo solo llega al administrador (nunca al comprador), así que no forma parte del alcance de idiomas del punto 54 — se mantiene siempre en español. Desde el punto 55: agrega la línea "Envío: $8.50" (texto plano y HTML) cuando el pedido incluyó costo de envío. Sin cambios en el punto 56.
- `admin-opiniones.html` — panel privado, sin enlace en el menú, para aprobar o rechazar opiniones. Desde el punto 54: se le agregó, a pedido explícito del usuario, el mismo sistema de idioma (selector ES/EN/FR/PT) que las fichas — solo el texto de la interfaz del panel (título, botones, mensajes) cambia de idioma; el nombre, rol, texto y fecha de cada opinión, escritos por la propia persona que la envió, nunca se traducen. Sin cambios en el punto 55. **Desde el punto 56: el idioma inicial de este panel también pasó a ser siempre español por defecto (ya no se detecta el idioma del navegador), igual que el resto del sitio — sigue permitiendo cambiarlo manualmente y sigue sin traducir jamás el contenido de las opiniones.**
- `admin-envios.html` — panel privado, sin enlace en el menú, protegido con la misma contraseña que `admin-opiniones.html` (`ADMIN_OPINIONES_PASSWORD`), para consultar por folio la dirección de envío guardada e imprimir la etiqueta (ver punto 42 y siguientes para el detalle completo de su historial). Desde el punto 54: por instrucción explícita del usuario, este panel NO recibió opción de idioma — la dirección de envío es algo que el usuario organiza directamente por correo local, y este panel es de uso exclusivamente interno. Revisado en el punto 55 (observación 2, impresión de etiquetas): sin cambios de código todavía — diagnóstico pendiente, ver ese punto. Sin cambios en el punto 56 (no tiene selector de idioma, por lo que el cambio de idioma-por-defecto no le aplica).
- `netlify/functions/guardar-envio.js` / `netlify/functions/obtener-envio.js` — guardan y consultan, respectivamente, la dirección de envío de una ficha en el bucket privado `resumen-vidavitalqr` (nunca en el bucket público `vidavitalqr`). Sin cambios desde su creación (punto 42).
- `index.html` — sección "Garantías y políticas", menú de navegación por secciones, fotos de producto reemplazadas, reducción de texto por sección, franja de diferenciadores únicos, botones de "Presentaciones físicas"/checkout reestructurados por rol persona/mascota/objeto, producto "Identificador QR" con selector de estilo de placa, despliegue de opiniones aprobadas, corrección de entidades HTML sin decodificar (punto 21), texto de la historia del fundador actualizado (punto 20), sección "Contenido" reestructurada en 3 apartados Personal/Mascotas/Objetos (punto 23), botones "Actualizar"/"Renovar" con validación de 12 meses (punto 22), corrección de superposición visual en la tarjeta del código QR del hero (punto 24), eliminación de la sección aparte "También para su mascota" con renumeración del menú y de las secciones (punto 25), activación del botón flotante de WhatsApp (punto 26), traducción completa a los 4 idiomas de todos los textos nuevos (punto 28), primera fase de pago real de renovación con ONVO Pay (punto 31), mensaje más claro en el recuadro de pago cuando el carrito está vacío pero ya hay una ficha asociada (punto 32), pago real extendido a todos los productos del carrito (punto 33), botón de selección en verde con redirección al recuadro de pago, precio de la placa a $13, y "Concepto de pago" visible junto al monto (punto 34), corrección del flujo de regreso desde la ficha (ya no se abre una segunda copia vacía del sitio), verificada en 11 productos distintos y confirmada funcionando en producción (punto 36), desde el punto 38: texto correcto ("Pago confirmado") en la pantalla de éxito cuando el pago es real con ONVO Pay, y nuevo botón "Hacer otra compra", desde el punto 39: miniaturas de la "Placa con código QR — Personal" numeradas de 1 a 4, y corrección de un bug real que impedía elegir el estilo de placa, desde el punto 40: el estilo de placa elegido ahora viaja también con el producto del carrito de pago, desde el punto 41: textos de alcance ampliados, nuevo texto de introducción del servicio, textos de "Cómo funciona" reescritos, nota resaltada de QR permanente, opiniones aprobadas reubicadas, sección "Presentaciones" renombrada, sección de renovación renombrada, eliminación de secciones del mockup de pago, aclaración del FAQ, desde el punto 42: modal "Dirección de envío", desde el punto 43: sección "06 — Presentaciones" con 9 viñetas, desde el punto 44: texto recortado, dos fotografías nuevas, más espaciado, desde el punto 45: pulido visual consistente en todas las tarjetas, y desde los puntos 46/47/48/49/50/51/52/53/54: sin cambios (ese trabajo estuvo únicamente en `admin-envios.html`, `avisar-escaneo.js`, `ver.js`, las 3 fichas y `admin-opiniones.html`). Desde el punto 55: ~55 elementos de texto estático adicionales (incluidos los 2 "section-num" reportados, el modal de "Dirección de envío", las 5 preguntas frecuentes, el botón de WhatsApp, y 16 atributos `alt`/`aria-label`) conectados al sistema de idiomas por primera vez (`TEXTOS_LANDING` de 193 a 302 claves); corregido que las etiquetas del carrito y el recuadro de resumen de pago no se traducían al cambiar de idioma; agregado el costo de envío de $8.50 al mockup del carrito (mismo cálculo que en `crear-pago.js`). **Desde el punto 56: la sección `.hero` (portada con el título "Código QR listo para escanear.", la maqueta del código QR, el botón "Ver cómo funciona" y la franja de diferenciadores) se movió para ser el primer contenido de la página, antes de la sección "01 — Alcance" (antes aparecía después, sin verdadera "bienvenida" al entrar al sitio); corregido que las 3 apariciones de la etiqueta "Acero inoxidable" en la sección de materiales no se traducían (nueva clave `fmatAceroInox`, agregada a `TEXTOS_LANDING` en los 4 idiomas); las dos imágenes de muestra que llevaban texto en inglés fijo dentro de la imagen (el QR de ejemplo con la palabra "EJEMPLO", y la vista previa del Identificador QR de bolsillo) ahora cambian junto con el idioma de la página, mostrando una versión distinta por idioma (`IMG_VARIANTS_QR_EJEMPLO`, `IMG_VARIANTS_IDCARD`); el idioma por defecto pasó a ser siempre español (ya no se detecta el idioma del navegador); y se agregó un indicador visual (degradado + flecha) en el menú de secciones para dejar claro que tiene más opciones hacia la derecha con scroll horizontal — ver ese punto para el detalle completo de los 5 cambios. **Desde el punto 57: nota junto a la línea "Envío" del resumen del carrito, nuevo recuadro de aclaración en la sección "Presentaciones" sobre el cargo de $8.50, y corrección de dos textos que quedaban contradictorios con esa política (la viñeta de "Envío por correo..." y el texto `cxP3` del mockup de renovación) — ver ese punto.**

## 8. Tercera revisión de mercado (2026-09-07)

Se entregó un tercer documento de revisión ("Revision_VidaVitalQR_Mercado_3.docx"), sin comparar precios (a petición del usuario). El detalle completo está en `claude/revision-mercado-vidavitalqr.md`. El punto 15 de esta bitácora implementa varias de sus recomendaciones. Ver también la cuarta revisión (2026-09-16, con precios) en ese mismo documento.

## 9. Ajustes de texto en index.html tras la tercera revisión

Se quitaron o ajustaron varias frases (moderación de opiniones, explicación de renovación vs. QR digital, nota de gastos de envío, y la frase "48 horas" que contradecía la política de 5 días hábiles).

## 10. Ubicación de quien escanea el código, sumada al aviso de escaneo

Al abrir la página del código QR, se le pide permiso de ubicación a quien escaneó (persona, mascota u objeto). Si lo concede, se usa su ubicación GPS exacta; si no, una ubicación aproximada por IP. `avisar-escaneo.js` arma y envía el correo con esa información a los contactos registrados. El texto del correo distingue explícitamente cuál de los dos casos es (ver punto 41). Desde el punto 49: la propia página pregunta explícitamente, con un recuadro y dos botones, antes de intentar usar la geolocalización del navegador — ver ese punto. Confirmado funcionando correctamente en producción por el usuario (2026-09-18).

## 11. Selector de idioma para quien escanea el código (ya existía, confirmado con el usuario)

`ver.js` detecta el idioma del navegador de quien escanea y ofrece botones ES/EN/FR/PT.

## 12. Menú de navegación por secciones en el encabezado de index.html

Franja de botones tipo píldora en el encabezado, con scroll suave hacia cada sección.

## 13. Fotos de producto mejoradas

Fotos nuevas (fondo claro, mejor encuadre) para "Cadena con incrustación religiosa" y "Placa con código QR", recortadas a 4:3.

**Pendiente:** la foto de la "Pulsera con placa de acero inoxidable" ($16) aún no se ha tomado y sigue con la foto original.

## 14. Reducción de texto por sección — landing más ligero de leer

Historia del fundador acortada (texto reemplazado de nuevo el 2026-09-14, ver punto 20), viñetas/pasos numerados en "Presentaciones físicas", separación de la exclusión de garantía, y nota de privacidad legal colapsable. De paso se corrigió un bug real: faltaba una clase CSS `.hidden` genérica en el sitio (solo existía `.pay-fields.hidden`); se agregó `.hidden{ display:none !important; }` sin afectar el uso existente.

## 15. Ampliación siguiendo las recomendaciones de la revisión de mercado (2026-09-11)

A partir de la revisión de mercado (punto 8) y de una lista de 5 puntos entregada por el usuario, se implementó lo siguiente en `index.html` y en el backend:

**1) Código QR desplegado en pantalla al generar/renovar cualquier ficha.** Ya existía la generación del QR (SVG); se agregó su despliegue en el modal de PIN al momento de crear o renovar la ficha, en `ficha.html`, `ficha-mascota.html` y la nueva `ficha-objeto.html`. (El envío del QR por correo se probó brevemente y luego se retiró — ver punto 17: por instrucción del usuario, el QR nunca se envía por correo, solo se muestra en pantalla.)

**2) Confirmación en la página de que existe el aviso de escaneo con ubicación.** Ya estaba implementado desde el punto 10 de esta bitácora; se reforzó su visibilidad agregándolo como uno de los 5 diferenciadores únicos en el hero de `index.html` ("Aviso y ubicación al escanear").

**3) Franja de diferenciadores únicos.** Nueva franja `.hero-highlights` en la parte superior de `index.html`, con 5 distintivos: Precio transparente, Código QR dinámico, Disponible en 4 idiomas, Historia real del fundador, y Aviso y ubicación al escanear. Traducida a los 4 idiomas.

**4) Precio como argumento de venta.** Se omitió, por instrucción explícita del usuario, la comparación de precio contra competidores nombrados (MedicAlert, Road iD, etc.); el precio se refuerza únicamente a través del diferenciador "Precio transparente" del punto anterior.

**5) Nueva ficha para objetos, con las mismas funciones que las demás.** Se creó `ficha-objeto.html`, con el mismo formato y flujo que `ficha.html`/`ficha-mascota.html`: folio propio (`VVOBJETO`, contador con su propio namespace), datos de identificación del objeto (tipo, marca, color, señas particulares, foto), contactos de emergencia (correo del contacto 1 obligatorio), ubicación, comentarios, adjuntos, generación de PDF, PIN de acceso, renovación, recuperación de PIN (usando descripción del objeto + fecha de registro como los otros dos factores), y despliegue del código QR en pantalla. El backend (`send-ficha.js`, `avisar-escaneo.js`, `recuperar-ficha.js`, `login-ficha.js`, `ver.js`) se amplió para reconocer el folio `VVOBJETO` y la carpeta `objetos/` (ver punto 5), y `ver.js` muestra los campos propios de un objeto en el visor público que se abre al escanear.

**Reestructuración de los botones de "Presentaciones físicas" y checkout**, también parte de esta ampliación:
- "Código QR (sin presentación física)": un botón → dos botones ("Agregar a mi pago — Personal" / "— Objeto").
- "Placa con código QR" ($12 en ese momento; ver punto 34 para el precio actual de $13): un botón → tres botones ("— Personal" / "— Mascota" / "— Objeto"), mismo precio en los tres casos.
- Se eliminó el apartado "Acero inoxidable — placa para collar de mascota" (dos tarjetas, perro y gato); sus fotografías se reutilizaron para reemplazar las imágenes existentes de perro y gato en la sección "Alcance".
- En la sección de renovación anual (`#pago`) se agregó una tercera tarjeta "Para su objeto", paralela a "Para usted" y "Para su mascota".
- El JavaScript de checkout de `index.html` (`ITEMS`, `ITEM_TIPO`, `RENEWAL_ITEMS`) se reescribió para enrutar cada botón a la ficha correcta (`ficha.html` / `ficha-mascota.html` / `ficha-objeto.html`) y mostrar la etiqueta correcta según el rol (Personal/Mascota/Objeto) en los 4 idiomas.

**Verificado:** sintaxis de los 4 bloques `<script>` de `index.html` y del script de `ficha-objeto.html` sin errores; revisión visual con Playwright (escritorio y móvil, español e inglés) de la franja de diferenciadores, los botones reestructurados, y las tarjetas de renovación; prueba end-to-end simulada (S3 y Resend en memoria) del flujo completo de una ficha de objeto — creación, correo de código de acceso, visor público, aviso de escaneo, login por PIN y recuperación de PIN — con resultado exitoso en los 6 pasos.

## 16. Corrección: el correo de código de acceso no debe llevar el código QR (2026-09-11)

Poco después de la entrega del punto 15, el usuario aclaró: el código QR **no** debe enviarse por correo — solo el folio y el PIN — y ese correo debe llegar a **ambos** contactos de emergencia cuando los dos tengan correo registrado (no solo al contacto 1).

**Verificación de lo ya existente:** el envío a ambos contactos ya funcionaba correctamente desde el punto 4 (la función recopila los correos de todos los contactos con email, deduplicados) — no fue necesario ningún cambio ahí.

**Cambio aplicado** (`netlify/functions/send-ficha.js`): se quitó el adjunto del código QR (SVG) y el enlace directo al QR del cuerpo del correo `enviarCodigoPorCorreo()`. Ese correo ahora contiene únicamente el folio y el PIN de acceso, con el texto explicativo de siempre. La generación y subida del QR a S3, y su despliegue en pantalla en el modal de PIN al crear/renovar una ficha, no cambiaron — el QR se sigue mostrando ahí, tal como pidió el usuario.

**Verificado:** sintaxis de `send-ficha.js` sin errores; prueba end-to-end simulada repetida con dos contactos (ambos con correo) confirmando que el correo de código de acceso llega a los dos destinatarios, sin adjuntos y con el folio y el PIN correctos en el cuerpo.

## 18. Reconciliación con la versión real en producción (2026-09-11)

**Causa raíz identificada:** el archivo `index.html` que se venía editando en esta conversación nunca se había comparado directamente contra el archivo realmente publicado en GitHub/Netlify. Como resultado, funciones agregadas directamente en producción (fuera de esta conversación) quedaron ausentes de la copia de trabajo, y cada entrega corría el riesgo de "retroceder" el sitio sin darse cuenta. Esto explica los reportes repetidos del usuario de que el landing desplegado "es uno viejo".

**Resolución:** el usuario subió un ZIP con la última versión que tenía de producción (fechado 2026-09-09). Se comparó a fondo contra la copia de trabajo y se fusionaron ambas ramas en una sola versión, sin perder ninguna función de ninguno de los dos lados:

**Incorporado desde producción (antes ausente en la copia de trabajo):**
- Sistema completo de opiniones/testimonios: además de la captura ya existente, se agregaron las funciones `get-testimonials.js`, `list-pending-testimonials.js` y `moderar-testimonial.js`, y el panel privado `admin-opiniones.html`.
- Producto "Identificador QR" ($12): tarjeta de bolsillo para la billetera.
- Selector de estilo de placa (clásica / llavero / ranuras / dije) en la tarjeta "Placa — Personal". (Ver punto 39: este selector nunca funcionó realmente en producción por un bug de alcance de función, corregido recién ahí; ver punto 40: además, ese estilo no viajaba con el producto del carrito de pago hasta ahora.)

**Conservado de la copia de trabajo (ausente en el ZIP de producción):** `ficha-objeto.html` y todo el soporte de fichas de objeto (`VVOBJETO`) en las 5 funciones backend, la franja de diferenciadores únicos, la reestructuración de botones personal/mascota/objeto, y la corrección del punto 16 — todo esto se mantuvo intacto durante la fusión.

**No se tocó:** `plate_mascota` se dejó tal cual estaba en la copia de trabajo — pendiente de decidir con el usuario si prefiere unificarlo.

**Verificado:** sintaxis de todos los archivos `.js` nuevos y modificados sin errores; se confirmó por revisión de texto que ninguna de las funciones de ambas ramas se perdió en la fusión.

## 19. ficha-mascota.html: se le agregó el sistema de 4 idiomas (2026-09-11)

El usuario pegó el código completo de una versión de `ficha-mascota.html` que sí tenía el sistema de idiomas ES/EN/FR/PT (selector de idioma, objeto `TEXTOS_FICHA`, función `aplicarIdiomaFicha()`) — el mismo esquema que ya usa `index.html` y que se sincroniza con él vía `localStorage`. La copia de trabajo de `ficha-mascota.html` nunca había recibido ese sistema y seguía solo en español.

**Fusión aplicada:** se adoptó el archivo pegado (con el sistema de 4 idiomas) como el nuevo `ficha-mascota.html`, y se le agregó de vuelta el despliegue del QR en el modal de PIN (`mostrarPinModal(pin, folio, qrUrl)`, con el texto y el `alt` de la imagen ya traducidos en los 4 idiomas mediante nuevas claves `pinModalQrTexto` y `pinModalQrAlt`).

**Verificado:** sintaxis del bloque `<script>` de `ficha-mascota.html` sin errores; conteo de claves `pinModalQrTexto`/`pinModalQrAlt` (4 cada una, una por idioma) confirmando que las 4 traducciones quedaron completas.

## 20. Correcciones a partir del documento "Obsrvaciones a corregir 20260914.docx" (2026-09-14)

El usuario subió un documento Word con una lista de bugs y cambios a corregir. Se procesó en orden:

**Bug: "placaEstilo is not defined" al hacer clic en "Enviar" (ficha.html).** La variable `placaEstilo` estaba declarada dentro de un IIFE y se usaba fuera de su ámbito en el manejador de envío. Se promovió su declaración al ámbito global del script.

**Bug relacionado: el correo de código+PIN y el guardado de la ficha no ocurrían al enviar.** Ver punto 29 para el resto (mismo patrón de bug, en las 3 fichas, con la variable `esRenovacion`).

**Aviso de escaneo con ubicación:** se revisó `ver.js` y `avisar-escaneo.js` a fondo — no se encontró ningún bug en ese momento (ver punto 49 para el ajuste posterior, que sí fue necesario).

**Texto de la historia del fundador:** reemplazado en `index.html` con el texto exacto provisto por el usuario. Traducido a los 4 idiomas — ver punto 28.

**Entidades HTML sin decodificar:** el texto de `privacyNoteFull` dentro de `TEXTOS_LANDING.es` tenía esas entidades escritas literalmente dentro de un string de JavaScript. Se reemplazaron por los caracteres reales.

## 21. Sección "Garantías y políticas": se quitó la tarjeta de reembolso y se amplió la garantía de la placa (2026-09-14)

Por instrucción del usuario: se eliminó por completo la tarjeta "Política de reembolso" de `#garantias` en `index.html` (quedan 3 tarjetas). Se agregó al final del texto de la garantía de la placa la frase: "Cualquier defecto de fabricación se resuelve mediante esta garantía de reposición." — en los 4 idiomas (ver punto 28).

## 22. Renovación anual: botones "Actualizar" y "Renovar" con validación de 12 meses (2026-09-14)

Por instrucción del usuario, se separó la renovación anual (pago) de la actualización de datos (gratis):

- **"Actualizar"**: abre la ficha correspondiente en modo `?actualizar=1`, PIN obligatorio, bloquea la edición si ya pasaron 12 meses desde `creado`. Confirmado y reforzado en el punto 35, y desde el punto 36 este modo ya nunca redirige al mockup de pago.
- **"Renovar"**: mismo flujo de siempre, marcado como `esRenovacionPago: true` para que el backend reinicie la fecha de inicio de vigencia.

**Cambios en el backend:** `cargarOCrearLogin()` recibe `resetCreado`; `login-ficha.js` devuelve `creado`.

**Cambios en las 3 fichas:** modo `?actualizar=1`, exigencia de PIN, cálculo de meses transcurridos, aviso de bloqueo. Introdujo la variable `esRenovacion` (bug de alcance corregido en el punto 29; `esActualizacion` corregido en el punto 36).

## 23. Sección "Contenido" reestructurada en 3 apartados: Personal / Mascotas / Objetos (2026-09-14)

La sección `#lo-esencial` de `index.html` tiene ahora 3 subapartados (Personal, Mascotas, Objetos), cada uno con sus tarjetas. Traducidos a los 4 idiomas — ver punto 28.

## 24. Revisión de superposición de recuadros (2026-09-14)

Se corrigió la etiqueta flotante "Lectura inmediata" que tapaba texto en la tarjeta de muestra del código QR del hero.

## 25. Eliminación de la sección aparte "También para su mascota" (2026-09-14)

Eliminada por completo; su contenido ya vivía en el apartado "Mascotas" de "Contenido" (punto 23). Se renumeraron el menú y los encabezados de las secciones siguientes.

## 26. Activación del botón flotante de WhatsApp (2026-09-14)

El botón pasó a ser un enlace real a `https://wa.me/50660933090`.

## 27. Archivos de esta sesión subidos a GitHub — cambios en producción (2026-09-14)

El usuario confirmó que subió manualmente los 6 archivos modificados hasta ese momento. Esa versión llevaba el bug del punto 29, corregido después.

## 28. Traducción completa a los 4 idiomas de todos los textos nuevos (2026-09-14)

Se revisó `TEXTOS_LANDING` en `index.html` y se completaron todas las claves faltantes en en/fr/pt (historia del fundador, subtítulos de Objetos, frase de garantía, botones de renovación). `ficha-mascota.html` ya tenía sus 4 idiomas completos desde el punto 19; `ficha.html` y `ficha-objeto.html` eran, hasta el punto 54, formularios solo en español (sin sistema de idiomas) — ver ese punto para su incorporación al sistema de 4 idiomas.

## 29. Corrección: "esRenovacion is not defined" al guardar la ficha, en las 3 fichas (2026-09-15)

Mismo patrón de bug que `placaEstilo` (punto 20), esta vez con `esRenovacion`, presente en las 3 fichas. Corregido promoviendo su declaración al ámbito global.

**Verificación exhaustiva adicional:** ESLint (`no-undef`) sobre todo el proyecto — cero errores.

## 30. Corrección: fallo silencioso al enviar el correo de código (folio + PIN) a los contactos (2026-09-15)

`enviarCodigoPorCorreo()` no revisaba si Resend realmente aceptaba el envío. Corregido para registrar y reportar los rechazos al administrador.

## 31. Primera fase de pago real de renovación anual con ONVO Pay, en modo prueba (2026-09-15)

Alcance: solo renovaciones anuales, checkout alojado por ONVO Pay. Archivos nuevos: `crear-pago.js` y `onvo-webhook.js` (ver su forma multi-producto en el punto 33).

## 32. Confirmación de prueba end-to-end exitosa y aclaración de la interfaz de pago (2026-09-15)

Se aclaró la diferencia entre la sección `#pago` real y el mockup de checkout. El usuario confirmó el pago real funcionando de punta a punta.

## 33. Pago real con ONVO Pay ampliado a todos los productos del carrito (2026-09-15)

`crear-pago.js` reescrito para recibir un carrito completo; `onvo-webhook.js` reporta la lista completa de productos.

## 34. Botón de selección en verde con redirección al pago, "Concepto de pago" visible, y precio de la Placa a $13 (2026-09-15)

Cambios visuales y de precio en `index.html` y `crear-pago.js`.

## 35. Fecha de inicio de vigencia visible en cada ficha, y confirmación del bloqueo de "Actualizar" tras 12 meses (2026-09-15)

Nuevo elemento `renewalFechaInicio` en las 3 fichas.

## 36. Corrección del flujo de regreso al landing tras enviar o actualizar una ficha — confirmada funcionando en producción (2026-09-16)

Se corrigió que la pestaña de la ficha abriera una segunda copia vacía del sitio al terminar. Ahora usa `postMessage` + cierre de pestaña (`avisarOpenerYCerrar`). Se corrigió también el bug gemelo de `esActualizacion`.

**Confirmado por el usuario:** funcionó correctamente en producción, 11/11 productos.

## 38. Cuatro correcciones tras la primera prueba de pagos reales: folio en el PDF, checkout desbloqueado, reporte de pago al administrador y detalle resaltado (2026-09-16)

1) Folio faltante en el PDF (filtro `#openCounter` agregado a `ficha.html`/`ficha-objeto.html`).
2) Botón "Hacer otra compra" agregado; texto corregido para pago real (ya no dice "simulado").
3) Aviso de pago confirmado redirigido a `roljamher@hotmail.com`.
4) Versión HTML resaltada del correo de aviso de pago.

## 39. Placas numeradas 1-4 con sus medidas, y corrección de un bug real que impedía elegir el estilo (2026-09-16)

Numeración y medidas de las 4 placas; corregido el bug de alcance de `selectPlateThumb` (expuesta en `window`).

## 40. Corrección: el correo de pago confirmado no indicaba cuál de las 4 placas se compró (2026-09-16)

El estilo de placa ahora viaja con el ítem del carrito de pago, se valida en `crear-pago.js`, y se traduce a nombre real en el correo de `onvo-webhook.js`.

## 41. Correcciones a partir del documento "observaciones por corregir 2020917.docx" (2026-09-17)

11 puntos de ajustes de texto/presentación en `index.html`: indicador "En proceso" en las 3 fichas, ampliación de "a quién va dirigido", nuevo texto de introducción, textos de "Cómo funciona" reescritos, nota de QR permanente, opiniones reubicadas, sección "Presentaciones" renombrada, sección de renovación renombrada, secciones del mockup eliminadas, recuadro de opiniones centrado, FAQ aclarado. Más dos preguntas sobre ubicación al escanear, respondidas sin cambios de código en ese momento (ver punto 49).

## 42. Dirección de envío antes del pago, guardada de forma privada, y etiqueta imprimible tamaño tarjeta de crédito (2026-09-17)

Nuevo modal "Dirección de envío" en `index.html`, guardado en el bucket **privado** `resumen-vidavitalqr` (nunca en el público). Nuevos: `guardar-envio.js`, `obtener-envio.js`, `admin-envios.html`.

## 43. Error 413 al enviar la ficha (mitigación), restauración de las 4 viñetas originales de "Presentaciones", y fotos de deportistas pendientes (2026-09-17)

Mitigación del límite de ~6MB de Netlify/AWS: compresión más agresiva de adjuntos + validación de peso previa. Restauradas las 4 viñetas originales de "Presentaciones" (quedan 9 en total).

## 44. Ajustes finales: recuadro de opiniones confirmado, texto de "Cómo funciona" recortado, fotos de deportistas insertadas, más espaciado en "Presentaciones", y entrega del ZIP completo (2026-09-17)

Texto recortado en "Tres pasos sencillos"; dos fotos de deportistas insertadas; más espaciado en "Presentaciones".

## 45. Pulido visual del landing (sombras, franjas de acento, hover), sin cambiar ningún texto — antes/después aprobado por el usuario, y ZIP entregado (2026-09-17)

Sombras, franjas de acento, hover con elevación aplicados consistentemente a todas las tarjetas del sitio. Aprobado por el usuario.

## 46. Corrección: la etiqueta de envío no se mostraba en `admin-envios.html` aunque la búsqueda fuera exitosa (2026-09-17)

Bug real: `etiquetaWrap.style.display = '';` no sobreescribía el `display:none` del CSS. Corregido a `'block'`.

## 47. Corrección de raíz del bug de "3 páginas al imprimir" la etiqueta, tamaño exacto 3in x 2in, descarga como imagen PNG, más presentación visual, y ajuste para impresión en blanco y negro (2026-09-18)

Solución: ventana de impresión aparte con solo el HTML de la etiqueta. Tamaño 3in x 2in exacto. Nueva descarga como PNG a 300 DPI. Ajuste a blanco y negro con el sitio web como referencia.

## 48. Corrección: el correo de aviso de escaneo mostraba la URL completa del bucket de S3 en vez de una versión acortada (2026-09-18)

Nueva función `urlAcortada()` en `avisar-escaneo.js`; nueva versión HTML del correo con el enlace real detrás del texto acortado.

## 49. El aviso de ubicación no preguntaba de forma visible cada vez — nuevo recuadro de consentimiento explícito en la página del código QR (2026-09-18)

`ver.js` ahora muestra un recuadro propio con la pregunta explícita antes de llamar a la geolocalización del navegador. Confirmado funcionando en producción por el usuario.

## 50. Corrección: la etiqueta se cortaba al imprimir desde el botón "Imprimir etiqueta" — rotación 90° para la orientación real de la impresora de etiquetas (2026-09-18)

La impresora del usuario alimenta en vertical (2in x 3in); la ventana de impresión ahora envía el contenido rotado 90° dentro de una página vertical.

## 51. Rediseño de la distribución y del tamaño de letra de la etiqueta de envío, con aprobación visual previa del usuario (2026-09-21)

Provincia/Cantón/Distrito como 3 columnas, letra de tamaño intermedio, "Otras señas" limitado a 2 líneas con recorte automático. Aprobado por el usuario tras revisar vistas previas.

**Pendiente:** subir `admin-envios.html` (con esta corrección y la del punto 50) a producción.

## 52. Aviso de pantalla completa "Procesando su ficha…", para que ya no se sienta la página congelada al enviar (2026-09-21)

Nuevo aviso de pantalla completa en las 3 fichas, que se activa justo antes de generar el PDF (el paso más pesado, `html2canvas()`), reforzando al indicador pequeño que ya existía desde el punto 41. Traducido en `ficha-mascota.html` (claves `procOverlayTitulo`/`procOverlayTexto`).

**Pendiente:** subir las 3 fichas a producción.

## 53. Corrección: el enlace de ubicación (Google Maps) dejó de ser clickeable en el correo de aviso de escaneo (2026-09-21)

El usuario reportó, con dos capturas de un correo real, que el enlace a la ubicación de quien escaneó el código ya no se podía abrir, mientras que el enlace "Ficha completa" sí seguía funcionando — y pidió corregirlo "en todas partes" (los 3 tipos de ficha).

**Causa:** al agregarse la versión HTML del correo en el punto 48, la línea de ubicación se armó como un solo string (prefijo + URL + nota) que se escapaba e insertaba dentro de un `<p>` de la versión HTML **sin envolver la URL en un `<a href>`** — a diferencia del enlace "Ficha completa", que sí se armó correctamente con su propio `<a href>` en ese mismo punto. Como los clientes de correo no auto-detectan URLs sueltas dentro de HTML (solo dentro de texto plano), la ubicación dejó de ser clickeable en cuanto la versión HTML empezó a mostrarse en vez de la de texto plano — el enlace de la ficha nunca tuvo este problema porque sí se había armado bien desde el principio.

**Solución aplicada en `netlify/functions/avisar-escaneo.js`:** se separaron los datos de ubicación en partes independientes (`{prefijo, url, nota}` en ese momento, luego generalizado en el punto 54 a datos crudos `{tipo, url, etiqueta?}`) precisamente para poder envolver la URL en un `<a href>` real al armar la versión HTML del correo, igual que ya se hacía con el enlace de la ficha. La versión en texto plano no cambió — sigue mostrando la URL completa incrustada en el texto, donde el propio cliente de correo la detecta y la vuelve clickeable automáticamente, tal como funcionaba antes del punto 48.

**Aplicado a los 3 tipos de ficha:** como `avisar-escaneo.js` es una sola función genérica que arma el correo para persona, mascota y objeto por igual (no hay una versión distinta por tipo), esta corrección aplica automáticamente a los 3 sin necesidad de tocar ningún otro archivo — cumpliendo el pedido explícito del usuario de corregirlo "en todas partes".

**Verificado:** `node --check` sin errores; prueba directa confirmando que el HTML generado produce exactamente `<a href="https://www.google.com/maps?q=...">https://www.google.com/maps?q=...</a>` para la ubicación, igual que ya lo hacía el enlace de la ficha.

**Entregado:** `netlify/functions/avisar-escaneo.js` corregido (después ampliado con el trabajo de idiomas del punto 54, en el mismo archivo).

## 54. Traducción a los 4 idiomas de todo el proceso de llenado de ficha, con el idioma elegido viajando también a los correos automáticos — y opción de idioma agregada a `admin-opiniones.html` (2026-09-21/22)

El usuario pidió, en un mensaje con varias ideas juntas: que "todo se pueda traducir a 4 idiomas" y que se verificara que todos los textos que aparecen durante todo el proceso tuvieran esa posibilidad. Se le preguntó el alcance exacto antes de empezar, y su respuesta fue explícita: **los nombres propios, los nombres de los medicamentos y los archivos adjuntos nunca deben traducirse — solo el texto de la interfaz** (todo lo demás sí debe poder cambiar de idioma). Con esa guía se acordó el alcance en tres partes, confirmadas una por una con el usuario:

**1) `ficha.html` y `ficha-objeto.html` — sistema completo de 4 idiomas, agregado por primera vez.** Hasta este punto, de los 3 formularios de ficha, solo `ficha-mascota.html` tenía sistema de idiomas (desde el punto 19); `ficha.html` y `ficha-objeto.html` estaban solo en español desde su creación. Se les agregó el mismo esquema ya probado: selector `#langbar` (ES/EN/FR/PT), objeto `TEXTOS_FICHA` con todas las cadenas de la interfaz (103 claves por idioma en `ficha.html`, 106 en `ficha-objeto.html`, verificado que las 4 traducciones de cada archivo tienen exactamente el mismo juego de claves), función `aplicarIdiomaFicha()`, atributos `data-i18n`/`data-i18n-html`/`data-i18n-ph`/`data-i18n-title` en toda la interfaz visible, y persistencia del idioma elegido en `localStorage` bajo la misma clave (`vidavitalqr_lang`) que ya usan `index.html`, `ver.js` y `ficha-mascota.html` — así el idioma queda consistente en todo el sitio para la misma persona. Los mensajes generados por JavaScript (progreso al generar el PDF, errores del servidor, confirmaciones, marcadores de la tabla de medicamentos, etc.) también se enrutaron a través de este sistema. **Lo que nunca se traduce, tal como pidió el usuario:** el nombre completo de la persona/mascota/descripción del objeto, los nombres de medicamentos que la persona escribe, y el nombre/contenido de los archivos adjuntos — todos esos siguen siendo texto libre que el usuario escribió, mostrado tal cual sin pasar por ningún diccionario de traducción.

**2) El idioma elegido al llenar la ficha ahora viaja con ella, para que los correos automáticos posteriores lleguen en ese mismo idioma.** Las 3 fichas ahora envían `idioma: LANG_FICHA` junto con el resto de los datos al guardar. En `netlify/functions/send-ficha.js`, ese valor se valida contra los 4 códigos reales (`es`/`en`/`fr`/`pt`) — cualquier otro valor, o su ausencia, cae a español por defecto, sin confiar nunca ciegamente en lo que mande el navegador. El idioma validado se guarda en dos lugares: (a) junto con el resto de la ficha, en el JSON público que `avisar-escaneo.js` ya leía por folio (para poder usarlo después, al escanear el código); y (b) se usa de inmediato para traducir el **correo de código de acceso** (`enviarCodigoPorCorreo`, el que llega a los contactos con el folio + PIN cada vez que se crea o actualiza una ficha) — nuevo diccionario `TEXTOS_CODIGO_CORREO` con el asunto y el cuerpo completos en los 4 idiomas.

**3) El correo de aviso de escaneo (`avisar-escaneo.js`) también se envía en el idioma de la ficha.** Aprovechando que ese archivo ya leía la ficha completa de S3 por folio (para nunca confiar en datos del navegador de quien escaneó — ver el propio archivo), ahora lee también `datos.idioma` de ahí. Nuevo diccionario `TEXTOS_AVISO_ESCANEO` con el asunto, la introducción, la explicación, los textos de ubicación exacta/aproximada, la etiqueta "Ficha completa" y la nota final, completos en los 4 idiomas — con cuidado especial en la gramática de cada idioma (por ejemplo, las contracciones "del"/"do"/"da" en vez de "de el"/"de o"/"de a"). La fecha y hora del escaneo que aparece en el correo también se formatea según el idioma (nombres de mes, orden, hora AM/PM vs. 24 horas), aunque la hora en sí sigue siendo siempre la de Costa Rica sin importar el idioma. El correo de pago confirmado (`onvo-webhook.js`) se excluyó deliberadamente de este alcance porque, según ya estaba documentado desde el punto 38, ese correo llega únicamente al administrador (`roljamher@hotmail.com`), nunca al comprador — no tiene sentido traducirlo.

**4) `admin-opiniones.html` — opción de idioma agregada, a diferencia de `admin-envios.html`.** El usuario aclaró explícitamente que estos dos paneles internos (sin enlace en el menú, protegidos con contraseña, de uso exclusivo del propio usuario) debían tratarse distinto: **las opiniones sí deben tener opción de idioma**, mientras que **la dirección de envíos no, porque eso lo organiza directamente por correo local**. Se agregó a `admin-opiniones.html` el mismo esquema de selector de idioma (`#langbar`, diccionario `TEXTOS_PANEL` con 17 claves en los 4 idiomas, función `aplicarIdiomaPanel()`) para el texto de la interfaz del panel (título, subtítulo, etiquetas, botones, mensajes de carga/error/éxito) — pero, tal como se aclaró con el usuario antes de implementarlo, el nombre, rol, texto y fecha de cada opinión (escritos por la persona que la envió desde el formulario público) nunca se traducen, se muestran exactamente como llegaron. `admin-envios.html` no se tocó en absoluto.

**Verificado:**
- Sintaxis (`node --check` / extracción y `new Function()` de cada bloque `<script>`) de los 6 archivos afectados (`ficha.html`, `ficha-objeto.html`, `send-ficha.js`, `avisar-escaneo.js`, `admin-opiniones.html`, y `ficha-mascota.html` por el nuevo campo `idioma` en su envío): sin errores en ninguno.
- Paridad de claves entre los 4 idiomas verificada programáticamente (mismo juego exacto de claves en es/en/fr/pt) en los 4 diccionarios nuevos o ampliados: `TEXTOS_FICHA` de `ficha.html` (103 claves) y de `ficha-objeto.html` (106 claves), `TEXTOS_CODIGO_CORREO` de `send-ficha.js`, `TEXTOS_AVISO_ESCANEO` de `avisar-escaneo.js`, y `TEXTOS_PANEL` de `admin-opiniones.html` (17 claves).
- Verificación de que ningún ID/función crítica de trabajo previo se duplicó ni se perdió al agregar el sistema de idiomas a `ficha.html`/`ficha-objeto.html` (`#procOverlay`, `#procBadge`, `#openCounter`, `#btnEmail`, `avisarOpenerYCerrar`, `generatePdfBlob`, `mostrarPinModal`, cada uno presente exactamente una vez).
- Prueba con Playwright cambiando entre los 4 idiomas en `ficha.html`, `ficha-objeto.html` y `admin-opiniones.html`, confirmando en pantalla que el texto de la interfaz cambia correctamente en cada uno (título, subtítulos, botones), sin errores nuevos de JavaScript en la consola (aparte del bloqueo esperado de recursos externos por la falta de salida a internet de este entorno, ya documentado en sesiones anteriores).
- Prueba directa de `TEXTOS_AVISO_ESCANEO` y `fechaHoraCR()` con datos de ejemplo (persona, mascota y objeto, en los 4 idiomas) confirmando que el asunto, la introducción y el texto de ubicación aproximada se arman correctamente y sin errores gramaticales en ninguno de los 4 idiomas, incluida la corrección de las contracciones en español y portugués.

**No se pudo verificar en este entorno (limitación ya documentada repetidas veces):** el envío real de un correo (Resend) ni la generación real de un PDF completo con `html2canvas`/`jsPDF`, porque este entorno de trabajo no tiene salida a internet hacia esos recursos externos — se verificó en su lugar la lógica completa de construcción de los textos y del enrutamiento del idioma, con datos de ejemplo, en todos los puntos de la cadena.

**Entregado:** `ficha.html`, `ficha-mascota.html`, `ficha-objeto.html`, `netlify/functions/send-ficha.js`, `netlify/functions/avisar-escaneo.js` y `admin-opiniones.html` — los 6 archivos de este punto.

**Pendiente:** subir estos 6 archivos a producción (GitHub/Netlify) — igual que el trabajo de los puntos 51 y 52, todavía no se ha confirmado la subida. Ninguno de estos cambios está activo en el sitio en vivo todavía.

## 55. Seis observaciones del documento "Observaciones de landing page 20260922.docx" (2026-09-22)

El usuario subió un documento Word con 6 observaciones numeradas sobre el landing y las fichas, con capturas de pantalla, y pidió expresamente verificar que nada NO mencionado en ese documento se modificara. Se procesó cada punto por separado:

**1) y 3) Textos que no se traducían al cambiar de idioma (tanto en la ficha pública escaneada como en el landing).** El usuario mostró una captura de la ficha pública (`ver.js`) en francés con textos como "Información urgente" y "Grupo sanguíneo" todavía en español, y otra del landing con "Preguntas frecuentes" sin traducir mientras el subtítulo de abajo sí cambiaba de idioma. Se hizo una auditoría completa de `index.html` (1.86 MB): se encontraron y corrigieron cerca de 55 elementos de texto estático sin ningún atributo `data-i18n` (entre ellos los 2 encabezados de sección "section-num" que coinciden exactamente con la captura del punto 3, el modal "Dirección de envío" completo, las 5 preguntas frecuentes, el botón de WhatsApp, y 16 atributos `alt`/`aria-label` de imágenes — se agregó soporte nuevo para `data-i18n-alt`/`data-i18n-aria`), además de 2 bugs de JavaScript más profundos: las etiquetas de los productos del carrito quedaban "congeladas" en español la primera vez que se dibujaban y nunca se volvían a traducir, y el recuadro de resumen de pago tampoco se volvía a traducir al cambiar de idioma porque la función que lo dibuja nunca se ejecutaba de nuevo. Ambos corregidos (`aplicarIdiomaLanding()` ahora vuelve a dibujar el resumen de pago en cada cambio de idioma). `TEXTOS_LANDING` creció de 193 a 302 claves, verificado que las 4 traducciones tienen exactamente el mismo juego de claves.

Para el punto 1 (la ficha pública, `ver.js`), en cambio, se revisó el código actual a fondo y **está funcionando correctamente**: una prueba con Playwright confirmó que el visor público traduce el 100% de su contenido en los 4 idiomas. La redacción exacta que aparece en la captura del usuario ("Paga", el texto de consentimiento tal como se ve ahí) no se encontró en ninguna parte del código actual de este proyecto, lo que indica que **la captura corresponde a una versión anterior, ya desactualizada, de `ver.js` que sigue publicada en producción** — no a un bug del código actual. Se recomienda al usuario confirmar en Netlify que el último despliegue realmente corresponde al `ver.js` más reciente subido a GitHub (revisando la fecha/hora del último deploy), y probar de nuevo escaneando un código después de confirmarlo.

**2) Impresión de la etiqueta de envío todavía incorrecta en ambas orientaciones.** El usuario confirmó el navegador (Chrome) y el modelo de impresora (MHT-L1081, la misma ya referenciada en el punto 50). El código actual de `admin-envios.html` ya incluye la corrección de rotación 90° del punto 50 (pensada específicamente para esta impresora) y el rediseño del punto 51, ninguno de los dos aún subido a producción según el punto 17. Como este entorno de trabajo no tiene una impresora física ni salida a internet para simular el driver de la MHT-L1081, no fue posible reproducir ni verificar el resultado impreso en esta sesión. **Queda pendiente**, con dos caminos posibles antes de tocar más código: (a) confirmar primero si el problema persiste con las correcciones de los puntos 50/51 ya subidas a producción (todavía no se han subido, según el punto 17) — es posible que ya esté resuelto y el usuario esté viendo la versión vieja; o (b) si sigue fallando después de subir esos cambios, revisar junto con el usuario la vista previa de impresión de Chrome (antes de imprimir) y el tamaño de papel configurado en "Propiedades de impresora" de la MHT-L1081 en Windows, ya que muchas impresoras de etiquetas térmicas solo imprimen correctamente cuando el tamaño de página que pide el navegador coincide exactamente con un tamaño de papel ya registrado en el driver de Windows — si el driver no tiene registrado 2in x 3in (50.8mm x 76.2mm), Chrome puede recortar o escalar la etiqueta aunque el código pida el tamaño correcto.

**4) Costo de envío de $8.50, hasta 5 productos físicos por dirección.** El usuario aclaró que un solo cargo de $8.50 cubre hasta 5 productos físicos enviados a la misma dirección. Implementado en los tres lugares donde debe coincidir: `index.html` (mockup del carrito, nueva línea "Envío" que se suma antes del IVA), `netlify/functions/crear-pago.js` (recalculado siempre desde cero en el servidor, nunca confía en ningún monto de envío que mande el navegador — se agrega una sola vez si el pedido incluye algún producto físico, sin importar cuántos) y `netlify/functions/onvo-webhook.js` (nueva línea "Envío" en el correo de aviso de pago confirmado al administrador). **Nota de diseño no confirmada explícitamente con el usuario:** se decidió que el IVA (13%) también se cobra sobre el costo de envío, igual que sobre los productos — si el usuario prefiere que el envío no lleve IVA, es un cambio sencillo de ajustar.

**5) Identificador QR: texto un poco más grande (discreto) y fotografía más amplia.** Ajustado en `ficha.html` (única ficha con esta tarjeta de bolsillo): el nombre de marca, las dos etiquetas verticales laterales y el número de folio se agrandaron ligeramente (por ejemplo 13px→14.5px, 18-19px→19.5-20.5px), y la fotografía pasó de 250×250px a 278×278px con esquinas más redondeadas. Verificado visualmente con una imagen de muestra renderizada: el texto se lee más claro sin dejar de ser discreto, y la foto es notablemente más grande, sin que nada se corte ni se superponga dentro de la tarjeta.

**6) Ubicación aproximada por IP, varios km de distancia cuando no se comparte ubicación exacta.** Se investigó si el servicio usado (`ipwho.is`, en `ubicacionPorIp()` de `avisar-escaneo.js`) podía cambiarse por uno más preciso, pero este entorno de trabajo no tiene salida a internet hacia ningún servicio externo de geolocalización (confirmado: la conexión de prueba fue rechazada por el propio filtro de salida del entorno, no fue un simple error de red), así que no fue posible probar ni comparar alternativas en esta sesión. Más allá de esa limitación del entorno, hay una explicación honesta que aplica sin importar el servicio que se use: **la geolocalización por IP nunca ubica el dispositivo real — ubica la salida a internet del proveedor de datos móviles**, que en Costa Rica (como en la mayoría de países) puede estar a varios kilómetros de distancia del teléfono, especialmente con datos móviles (4G/5G) en vez de wifi. Ningún servicio de geolocalización por IP, por bueno que sea, puede corregir esa limitación — es inherente a cómo funciona la red celular, no un defecto del código. La única forma de obtener una ubicación realmente precisa sigue siendo que la persona que escanea acepte compartir su ubicación exacta (ya implementado desde el punto 49, con el recuadro de consentimiento explícito). No se aplicó ningún cambio de código para este punto — solo esta aclaración.

**Verificado que nada fuera de estos 6 puntos se modificó:** las secciones de `index.html`, `crear-pago.js` y `onvo-webhook.js` tocadas corresponden exactamente a lo descrito arriba; no se tocaron `ver.js`, `avisar-escaneo.js` (más allá de la investigación, sin cambios de código), `admin-opiniones.html`, `admin-envios.html`, `ficha-mascota.html` ni `ficha-objeto.html` en este punto.

**Entregado:** `index.html`, `netlify/functions/crear-pago.js`, `netlify/functions/onvo-webhook.js`, `ficha.html`.

**Pendiente:**
- Subir estos 4 archivos a producción (se suman a lo ya pendiente de subir desde los puntos 50-54).
- Confirmar con el usuario, después de subir `ver.js` a producción si hiciera falta, que el visor público ya muestra el texto traducido correctamente (punto 1) — probablemente sin necesidad de ningún cambio de código.
- Diagnosticar la impresión de la etiqueta (punto 2) una vez que los puntos 50/51 estén en producción; si el problema persiste, revisar junto con el usuario la vista previa de impresión de Chrome y el tamaño de papel configurado en el driver de la MHT-L1081 en Windows.
- ~~Confirmar con el usuario si el envío ($8.50) debe llevar IVA o no~~ — **confirmado en el punto 57: sí, el IVA se cobra sobre todo (productos y envío), tal como ya estaba implementado.**

## 56. Revisión de experiencia de usuario "como visitante" del sitio, con las mejoras aprobadas implementadas (2026-09-22)

El usuario pidió una revisión honesta, en primera persona, de cómo se siente usar el sitio como un visitante cualquiera: qué tan amigable y fácil de entender es la presentación, y qué cambiaría o mejoraría. Se navegó el sitio real (los archivos actuales del proyecto, no una descripción del código) con Playwright, tomando capturas de cada sección tal como las vería una persona, y probando los controles reales (menú, selector de idioma, botones). De esa revisión salieron varias observaciones; el usuario las aprobó todas ("Me parecen bien las observaciones. Procedamos."), con dos precisiones explícitas: generar una versión de las imágenes de muestra por idioma, y dejar el español como idioma por defecto del sitio (con selección manual de otro idioma por conveniencia del usuario, ya no detección automática del navegador). Se implementaron las cinco mejoras siguientes:

**1) La portada (hero) ahora es lo primero que se ve al entrar — antes aparecía después de la sección "01 — Alcance".** En el código de `index.html`, la sección `<section class="hero">` (título "Código QR listo para escanear.", maqueta del código QR, botón "Ver cómo funciona", nota de confianza y la franja de 5 diferenciadores) estaba ubicada físicamente después de la sección "A quién va dirigido", así que un visitante nuevo entraba directo a un bloque de texto explicativo en vez de a una verdadera portada de bienvenida — la primera impresión más fuerte del sitio quedaba enterrada. Se reordenaron ambos bloques para que el hero sea el primer contenido de `<main>`. Verificado con Playwright: el primer hijo de `<main>` es ahora la sección `hero`.

**2) Corrección de un texto que no se traducía: "Acero inoxidable" en la sección de materiales.** Se encontró, con una revisión de la interfaz en inglés, que la etiqueta "Acero inoxidable" (que aparece 3 veces, junto a distintos productos) seguía en español al cambiar de idioma, a diferencia de su etiqueta hermana "Solo digital" que sí cambiaba — un descuido real: le faltaba el atributo `data-i18n` que sí tenían las demás. Se agregó una nueva clave (`fmatAceroInox`) a `TEXTOS_LANDING` en los 4 idiomas ("Acero inoxidable" / "Stainless steel" / "Acier inoxydable" / "Aço inoxidável") y se conectaron las 3 apariciones. Verificado: el texto ahora cambia correctamente en los 4 idiomas.

**3) Versión por idioma de las dos imágenes de muestra que llevaban texto fijo (a pedido explícito del usuario).** Dos imágenes de la página mostraban texto en un solo idioma sin importar el idioma elegido: el código QR de ejemplo (con la palabra "EJEMPLO" dibujada dentro de la imagen) y la vista previa del "Identificador QR" tipo tarjeta de bolsillo (con textos de ejemplo como "Solo escanear" y "Titular"). Se generó una versión de cada imagen por idioma (ES/EN/FR/PT) y se conectaron al sistema de idiomas existente, para que cambien junto con el resto de la página:
   - El QR de ejemplo es una ilustración vectorial (SVG) con el texto como elemento editable — se generaron las 4 variantes cambiando solo ese texto ("EJEMPLO"/"SAMPLE"/"EXEMPLE"/"EXEMPLO"), manteniendo el nombre de marca sin traducir.
   - La vista previa del Identificador QR era una única fotografía fija (PNG) siempre en español. Se reconstruyó su diseño visual (a partir del mismo generador que ya usa `ficha.html` para la tarjeta real) y se renderizaron las 4 versiones con sus textos correspondientes, además quedando cada una considerablemente más liviana que el archivo original (pasó de un solo archivo de 613 KB a cuatro versiones de entre 65 y 90 KB), lo que también ayuda a que la página cargue más rápido.
   Ambas imágenes ahora cambian automáticamente su `src` dentro de la misma función que ya cambia el resto de los textos al seleccionar un idioma. Verificado visualmente en los 4 idiomas: el texto se lee correctamente y nada se corta ni se superpone.

**4) Español como idioma por defecto en todo el sitio (a pedido explícito del usuario).** Hasta ahora, si la persona no había elegido nunca un idioma en ese navegador, el sitio detectaba el idioma configurado en el navegador y arrancaba en ese idioma automáticamente — lo que podía mostrarle el sitio en inglés, francés o portugués a un visitante costarricense sin que lo pidiera. Se quitó esa detección automática en los 6 archivos del sitio que la tenían (`index.html`, `ficha.html`, `ficha-mascota.html`, `ficha-objeto.html`, `admin-opiniones.html` y `netlify/functions/ver.js`): ahora todos arrancan siempre en español, salvo que la persona ya haya elegido otro idioma antes en ese mismo navegador (guardado en `localStorage`) o haya llegado por un enlace con el idioma indicado explícitamente en la URL (`?lang=`, donde ya existía ese mecanismo). La selección manual del idioma, con los botones ES/EN/FR/PT ya existentes, sigue funcionando exactamente igual en los 6 archivos. Verificado con Playwright: al cargar el sitio sin ningún idioma guardado, el idioma inicial es siempre español, con el botón "ES" marcado como activo.

**5) Indicador visual de que el menú de secciones tiene más opciones hacia la derecha.** El menú de botones tipo píldora en el encabezado (que permite saltar a cada sección) se desborda horizontalmente en pantallas angostas y requiere deslizar para ver todas las opciones, pero no había ninguna señal visual de que hubiera más contenido oculto — un visitante podía no darse cuenta de que existen más secciones a la derecha. Se agregó un degradado sutil y una flecha (›) al lado derecho del menú, que aparecen solo cuando realmente hay más contenido para deslizar y desaparecen automáticamente al llegar al final del menú. Verificado con Playwright: el indicador está visible al cargar la página (hay desborde real) y se oculta correctamente al deslizar el menú hasta el final.

**Verificado (revisión final):** los 4 bloques `<script>` de `index.html` y los bloques de los otros 5 archivos modificados pasan la verificación de sintaxis (`new Function()` / `node --check`) sin errores; un recorrido con Playwright en los 4 idiomas por todo el sitio no arrojó ningún error nuevo de JavaScript en la consola.

**Entregado:** `index.html`, `ficha.html`, `ficha-mascota.html`, `ficha-objeto.html`, `admin-opiniones.html`, `netlify/functions/ver.js` — los 6 archivos de este punto.

**Pendiente:** subir estos 6 archivos a producción — se suman a todo lo ya pendiente de subir de los puntos 50-55. Ninguno de los cambios de este punto está activo en el sitio en vivo todavía.

## 57. Aclaración de los gastos de envío en `index.html`, y confirmación de que el IVA se cobra sobre todo (productos y envío) (2026-09-22)

El usuario reportó que, al revisar el sitio, no encontró en ninguna parte una explicación clara de los gastos de envío para un visitante — el cargo de $8.50 (agregado en el punto 55) aparecía en el resumen del carrito como una simple línea con un número, sin ninguna nota que explicara qué cubre. Al revisar el código se confirmó el problema, y además se encontraron dos textos ya existentes que quedaron **contradictorios** con la política real del cargo único de $8.50:

- La viñeta "Envío por correo dentro de Costa Rica" en la sección "Presentaciones" (punto 43) sonaba como si el envío estuviera incluido/gratis, sin ninguna mención de costo.
- El texto del mockup de renovación (`cxP3`) todavía decía "Los gastos de envío no están incluidos en este monto y se cobran aparte, **según corresponda** (dentro o fuera del área metropolitana)" — una redacción de antes del punto 55, que ya no refleja el cargo fijo de $8.50 que realmente se cobra hoy.

**Confirmación explícita del usuario sobre el IVA:** el IVA (13%) se cobra sobre **todo** — tanto los productos como el envío. Esto coincide exactamente con cómo ya estaba implementado desde el punto 55 (el 13% se calcula sobre el subtotal de productos + envío, en `index.html` y en `netlify/functions/crear-pago.js`), así que **no fue necesario ningún cambio de código** para este punto — solo queda confirmado y ya no pendiente de definir.

**Cambios aplicados en `index.html`** (los tres que pidió el usuario):

1. **Nota junto a la línea "Envío" del resumen del carrito**, visible automáticamente cada vez que el pedido incluye algún producto físico: *"Cargo único de $8.50 por pedido — cubre hasta 5 productos físicos enviados a la misma dirección."* (nueva clave `shippingNote`, agregada dentro de `renderOrder()` justo debajo de la línea de envío).
2. **Nuevo recuadro de aclaración en la sección "Presentaciones"**, con el mismo estilo visual que el recuadro de precio que ya existía ahí ("Pensado para ser accesible"), con el ícono 📦: *"El envío es un costo aparte. Se cobra un cargo único de $8.50 por pedido dentro de Costa Rica, que cubre hasta 5 productos físicos enviados a la misma dirección — no es necesario pagar envío por cada artículo."* (nuevas claves `shippingCalloutStrong`/`shippingCalloutText`).
3. **Corrección de los dos textos contradictorios:** la viñeta de "Presentaciones" ahora dice "Envío por correo dentro de Costa Rica (costo aparte — ver detalle abajo)" (apunta al nuevo recuadro del punto anterior), y el texto del mockup de renovación (`cxP3`) se actualizó para reflejar la política real: "El envío es un costo aparte: se cobra un cargo único de $8.50 por pedido, que cubre hasta 5 productos físicos enviados a la misma dirección."

Las 5 claves nuevas/modificadas (`shippingNote`, `shippingCalloutStrong`, `shippingCalloutText`, `presBulletA4`, `cxP3`) se agregaron/actualizaron en los 4 idiomas de `TEXTOS_LANDING`.

**Verificado:** los 4 bloques `<script>` de `index.html` pasan la verificación de sintaxis (`new Function()`) sin errores; paridad de claves confirmada programáticamente entre los 4 idiomas (307 claves exactas en cada uno, sin faltantes ni sobrantes).

**Entregado:** `index.html`.

**Pendiente:** subir este archivo a producción — se suma a todo lo demás ya pendiente de subir (puntos 50-56).

## 58. Opción de pagar en colones (CRC), con tipo de cambio automático del BCCR + 2% de margen (2026-09-23)

El usuario preguntó cómo unificar que el catálogo de WhatsApp Business exige colones pero el sitio cobra en dólares; se le recomendó no duplicar precios y usar el sitio (en dólares) como precio oficial. Luego preguntó específicamente si el mockup/checkout de ONVO Pay podía ofrecer pagar en dólares y/o colones, y si el tipo de cambio se podía mantener actualizado automáticamente con la tasa de referencia del Banco Central de Costa Rica (BCCR) — pidió explícitamente sumar un margen del 2% y redondear hacia arriba.

**Se implementó la opción de pagar en CRC, apagada por defecto hasta que el usuario complete dos pasos pendientes (ver "Pendiente" más abajo).**

Archivos nuevos:
- `netlify/functions/lib/bccr.js` — consulta el servicio web público del BCCR (indicador 318 = tipo de cambio de referencia de **venta**; se prefirió sobre el 317 de compra porque protege mejor el margen del negocio), vía su binding HTTP GET (`.../ObtenerIndicadoresEconomicosXML?Indicador=318&...`), consultando un rango de 7 días para cubrir fines de semana/feriados y tomando el valor más reciente.
- `netlify/functions/actualizar-tipo-cambio.js` — función **programada** (una vez al día, 9:00 a.m. hora de Costa Rica) que llama a `lib/bccr.js`, le suma el 2% de margen pedido y redondea siempre hacia arriba al colón entero, y guarda el resultado en el bucket privado de resumen (`config/tipo-cambio.json`, mismo bucket que usa `guardar-envio.js`). También se puede disparar a mano para forzar una actualización o probarla.
- `netlify/functions/tipo-cambio.js` — endpoint público de solo lectura que expone ese tipo de cambio guardado, usado por `index.html` únicamente para la vista previa en pantalla (nunca para el cobro real).
- `netlify.toml` (nuevo en `site_combined` — antes no existía) — declara la carpeta de funciones y el horario (`schedule = "0 15 * * *"`, 15:00 UTC = 9:00 a.m. CR) de `actualizar-tipo-cambio`.

Archivos modificados:
- `netlify/functions/crear-pago.js` — acepta `moneda: "USD" | "CRC"` en el body; si es CRC, vuelve a calcular el total SIEMPRE desde el total en USD (nunca desde lo que mande el navegador) usando el tipo de cambio guardado, y se lo manda a ONVO Pay con `currency: "CRC"`. Queda protegido detrás de la variable de entorno `HABILITAR_PAGO_CRC` (debe valer exactamente `"true"`) — ver "Pendiente".
- `netlify/functions/onvo-webhook.js` — cuando un pedido se cobró en colones, el aviso de pago al administrador ahora también muestra "Cobrado en: colones (CRC)", el equivalente en dólares y el tipo de cambio usado en ese pedido específico (texto y HTML).
- `index.html` — nuevo selector "US$ Dólares / ₡ Colones" en el recuadro de pago, oculto por defecto y que solo aparece si `tipo-cambio.js` devuelve un valor válido (o sea, después de que la función programada haya corrido al menos una vez con éxito). `fmt()` ahora convierte a colones para la vista previa cuando el cliente elige esa moneda; `iniciarPagoReal()` manda el campo `moneda` a `crear-pago.js`.

**Pendiente antes de poder activar el pago en colones (el usuario indicó que todavía no tiene la cuenta del BCCR):**
1. Registrarse (gratis) en el servicio web de indicadores económicos del BCCR — el primer enlace que se le dio (`frmServiciosWebHermes.aspx`) estaba mal (apunta al servicio de consulta, no al registro); se le corrigió a `https://gee.bccr.fi.cr/Indicadores/Suscripciones/UI/Suscripcion`. El usuario reportó (2026-09-23) que ya completó la inscripción pero no le llegó/mostró el token para entrar — pendiente de resolver eso con el usuario (probablemente llega por correo, o hay un paso de confirmación de correo previo).
2. Una vez con correo/token, configurarlos en Netlify como `BCCR_CORREO` y `BCCR_TOKEN`, correr manualmente `actualizar-tipo-cambio` una primera vez, y hacer una transacción de prueba real en colones con ONVO Pay (en modo prueba) para confirmar que procesa bien el monto en colones enteros. Solo después de confirmar esto se debe poner `HABILITAR_PAGO_CRC=true` en Netlify.

**Decisión confirmada por el usuario (2026-09-23): trabajar siempre con colones ENTEROS (sin decimales), redondeando hacia ARRIBA al entero más cercano tanto en el tipo de cambio (ya lo hacía, punto 58 original) como en el monto final que se le manda a ONVO Pay.** Se ajustó `crear-pago.js`: `totalCRC` y `unitAmount` ahora usan `Math.ceil` (antes `Math.round`), y `ONVO_CRC_SUBUNIT_MULTIPLIER` queda documentado como "1 = colones enteros, la decisión tomada" en vez de "pendiente de verificar".

**No se tradujo el texto del nuevo selector de moneda a los 4 idiomas todavía** (quedó fijo en español/símbolos "US$"/"₡", que se entienden en cualquier idioma) — pendiente si el usuario lo pide.

**Verificado:** sintaxis de los 4 archivos `.js` nuevos/modificados (`node -c`) y de los 4 bloques `<script>` de `index.html`, sin errores.

**Entregado:** `netlify/functions/lib/bccr.js`, `netlify/functions/actualizar-tipo-cambio.js`, `netlify/functions/tipo-cambio.js`, `netlify/functions/crear-pago.js`, `netlify/functions/onvo-webhook.js`, `index.html`, `netlify.toml`.

## 17. Pendiente

- Integración de pago real con ONVO Pay: **las renovaciones (punto 31) y todos los demás productos del carrito (punto 33), con las mejoras de claridad del punto 34, la corrección del flujo de regreso del punto 36, y las correcciones de folio/checkout/reporte de pago de los puntos 38 y 40, ya usan pago real en modo prueba, confirmado funcionando de punta a punta (ver punto 40).** Falta: (a) la siguiente fase, que marque automáticamente la ficha como renovada en S3 y active el bloqueo del visor público (`ver.js`) para fichas no pagadas; (b) cambiar de modo prueba a modo real (llaves `onvo_live_`) cuando el usuario esté listo para cobrar de verdad — **el usuario confirmó (2026-09-22) que va a dejar este cambio para después: primero quiere hacer sus propias pruebas con el sitio ya actualizado en producción, y después coordina la actualización de ONVO**; (c) actualizar o retirar la etiqueta "Mockup de checkout — solo demostración" del recuadro de pago; (d) confirmar si el pago real por SINPE Móvil ya funciona o si la pestaña de esa opción debe ocultarse mientras tanto.
- **Decidir si se necesita un listado de "pedidos con envío pendiente" en `admin-envios.html`** (ver punto 42), en vez de consultar solo folio por folio.
- **Vigilar si el error 413 (punto 43) vuelve a presentarse** tras subir la corrección.
- Grabación y edición de los 3 videos para redes sociales, por parte del usuario — no forma parte del código del sitio.
- Debilidades pendientes de la revisión de mercado (ver punto 8): recuperación si se pierden folio+PIN a la vez, traducción del checkout/FAQ, cifra de alcance.
- Foto de "Pulsera con placa de acero inoxidable" pendiente de tomar.
- Decidir si `plate_mascota` se unifica en un solo ítem "perro/gato" con selector de miniatura o se mantiene como está.
- Verificar en Resend (Domains) si `vidavitalqr.com` está verificado — causa más probable de que los códigos no lleguen a los contactos (punto 30).
- Decidir si `send-ficha.js` y `submit-testimonial.js` también deben redirigir sus propios avisos al administrador a `roljamher@hotmail.com` (ver nota de alcance del punto 38) o si deben seguir apuntando a `vidavitalqr@zohomail.com`.
- Decidir si el usuario quiere agregar el mismo selector de estilo numerado (1-4) también a "Placa con código QR — Mascota" y "— Objeto" (ver punto 39) — hoy solo existe para la variante Personal.
- **Posibles refinamientos adicionales de diseño (ver punto 45), no aplicados todavía:** unificar el grosor de trazo de los íconos SVG en todo el sitio, y aplicar un tratamiento de color/filtro consistente a las fotos del hero y la galería.
- **Ofrecido al usuario (2026-09-17, punto 43):** agregar en esta bitácora una sección fija de "Reglas que no se deben romper" — pendiente de que el usuario confirme si la quiere.
- **Pago en colones (ver punto 58):** falta que el usuario se registre en el servicio web del BCCR y me pase correo/token (`BCCR_CORREO`/`BCCR_TOKEN`), y falta una transacción de prueba real en CRC con ONVO Pay para confirmar el multiplicador correcto (`ONVO_CRC_SUBUNIT_MULTIPLIER`) antes de poner `HABILITAR_PAGO_CRC=true`. Además, los archivos nuevos/modificados del punto 58 (incluyendo el `netlify.toml` nuevo) también están pendientes de subir a producción — sin subir `netlify.toml`, la función `actualizar-tipo-cambio` no queda programada en Netlify aunque el resto del código sí se suba.
- **Subir a producción (GitHub/Netlify) todo el trabajo ya aprobado y pendiente de subir:** `admin-envios.html` con las correcciones combinadas de los puntos 50 y 51; `ficha.html`, `ficha-mascota.html`, `ficha-objeto.html` con el aviso "Procesando su ficha…" del punto 52, (en `ficha.html`) el Identificador QR agrandado del punto 55, y (en las 3 fichas) el idioma por defecto en español del punto 56; del punto 53/54/55: `netlify/functions/avisar-escaneo.js` (enlace de ubicación corregido + correo en el idioma de la ficha), `netlify/functions/send-ficha.js` (idioma guardado + correo de código traducido), `netlify/functions/crear-pago.js` y `netlify/functions/onvo-webhook.js` (costo de envío de $8.50), `index.html` (~55 textos adicionales traducidos + costo de envío en el mockup), y `admin-opiniones.html` (opción de idioma); del punto 56: `index.html` (hero reordenado como portada, corrección de "Acero inoxidable", imágenes de muestra por idioma, indicador de scroll del menú, idioma por defecto en español), `netlify/functions/ver.js` (idioma por defecto en español) y `admin-opiniones.html` (idioma por defecto en español, sumado a la opción de idioma del punto 54); y del punto 57 (más reciente): `index.html` (nota de $8.50 junto a la línea de envío del carrito, nuevo recuadro de aclaración de envío en "Presentaciones", y corrección de los dos textos que quedaban contradictorios con la política de envío). Mientras no se suban, el sitio en vivo sigue sin ninguno de estos cambios. Pendiente confirmar, ya en producción: que el enlace de ubicación del correo de aviso de escaneo vuelve a ser clickeable, que los correos automáticos llegan en el idioma correcto según lo elegido al llenar la ficha, que la ficha pública (`ver.js`) muestra el texto ya traducido correctamente (punto 55, observación 1), que el sitio arranca en español para un visitante nuevo (punto 56), y que la aclaración de gastos de envío ya es visible en el carrito y en "Presentaciones" (punto 57).

## 37. Cierre de sesión — todo actualizado y sin cambios pendientes por aplicar (2026-09-16, antes de las correcciones de los puntos 38-41)

El usuario pidió que todo quede actualizado y conservado para la próxima sesión. Estado dejado en ese momento: código fuente y bitácora sincronizados con el ZIP `vidavitalqr_flujo_pago_corregido_20260916.zip`, ya confirmado funcionando en producción.

Poco después, en sesiones posteriores, el usuario probó el pago real y reportó los puntos 38-52, todos resueltos y documentados en su momento, y en esta sesión reportó y se corrigió el bug del enlace de ubicación no clickeable en el correo de aviso de escaneo (punto 53), pidió la traducción a 4 idiomas de todo el proceso de llenado de ficha más la opción de idioma en `admin-opiniones.html` (punto 54), entregó un nuevo documento con 6 observaciones sobre el landing y las fichas (punto 55: auditoría de textos sin traducir, diagnóstico de impresión de etiquetas pendiente, costo de envío de $8.50, Identificador QR agrandado, y aclaración honesta sobre los límites de la ubicación aproximada por IP), pidió y aprobó una revisión de experiencia de usuario del sitio como visitante, con 5 mejoras implementadas: portada reordenada como primer contenido, corrección de texto sin traducir, imágenes de muestra por idioma, español como idioma por defecto en todo el sitio, e indicador de scroll en el menú de secciones (punto 56), y reportó que no encontraba ninguna aclaración sobre los gastos de envío, lo que llevó a confirmar que el IVA se cobra sobre productos y envío por igual, y a agregar una nota junto a la línea de envío del carrito y un nuevo recuadro de aclaración en la sección "Presentaciones", corrigiendo de paso dos textos que habían quedado contradictorios con la política real de envío (punto 57) — que es el estado actual y vigente del proyecto, todavía pendiente de subir a producción (junto con los puntos 50-56).
