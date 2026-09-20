Fixtures sanitizados y reducidos del formato observado en un correo LinkedIn local.

- `real-reduced.eml`: conserva multipart/alternative, tres tarjetas de texto, separadores, badge de contratación, salario y controles globales. El HTML alternativo se reduce a la primera tarjeta y conserva los anchors anidados y compañía · ubicación del original.
- `card.html`: tarjeta mínima con título enlazado, compañía y ubicación en líneas separadas, y acción duplicada.
- `global-link.html`: estructura HTML reducida con logo, anchors anidados, compañía · ubicación y enlace global de búsqueda.
- `newsletter.eml`: regresión del mensaje 123923; conserva el remitente y asunto reportados, con cuerpo y URL sintéticos que incluyen una palabra de contratación para reproducir el falso positivo. No contiene datos personales del mensaje original.

Los IDs son ficticios; las URLs se escribieron sin parámetros ni fragmentos. Se omitieron destinatario, cabeceras personales, imágenes, tokens y enlaces de seguimiento. No se necesita el correo original para ejecutar las pruebas.
