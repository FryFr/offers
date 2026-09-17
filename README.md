# Offers — adaptador Notion opcional

Base local en TypeScript para registrar y evaluar oportunidades manualmente. No necesita secretos, servicios ni dependencias de ejecución. No hace scraping, lectura de correo ni aplicaciones. Notion está desactivado por defecto; el flujo local no usa red.

## Ejecutar

Requiere Node >= 22.18 con soporte nativo de TypeScript (probado con Node 26.8.2). Ejecutar desde la raíz:

```sh
npm test
npm start -- --help
npm start -- --input examples/opportunities.json --profile examples/profile.json --state data/offers.json --output output/report.json --now 2026-09-16T12:00:00Z
cat examples/opportunities.json | node src/cli.ts --input - --state data/offers.json
```

`node src/cli.ts` imprime JSON puro cuando se omite `--output`; `npm start` agrega el encabezado de npm. `--now` es opcional y permite evaluaciones reproducibles. Sin él se usa la hora actual. Errores van a stderr con código de salida 1. Se valida todo el lote antes de escribir.

Para instalar las dependencias de desarrollo y comprobar tipos:

```sh
npm install --ignore-scripts
npm run check
```

Se incluye lockfile. Las pruebas y CLI funcionan con el soporte TypeScript nativo de Node; `npm run check` comprueba los tipos con TypeScript.

## Contratos

`src/contracts.ts` contiene los tipos y validadores de runtime; las funciones de dominio esperan valores ya validados. Se acepta un objeto Opportunity o una lista JSON. Campos desconocidos se descartan, nunca se persisten.

| Campo Opportunity | Regla |
| --- | --- |
| `title`, `company` | Texto no vacío obligatorio |
| `skills` | Lista de textos, opcional (vacía por defecto), normalizada a minúsculas |
| `description`, `source`, `externalId`, `url` | Opcionales; ID externo requiere fuente; URL HTTP/HTTPS |
| `kind` | `employment`, `freelance` o `unknown`, opcional |
| `remote`, `recurring`, `growthPotential`, `relocationRequired` | Booleanos opcionales, declarados manualmente |
| `location`, `industry` | Textos opcionales no vacíos; no se infiere relocalización de ubicación ni remoto |
| `publishedAt` | Fecha real `YYYY-MM-DD` de publicación; sin fecha no puede ser activa |
| `publicationEvidence` | `{url, excerpt, observedAt}`; evidencia explícita de publicación, timestamp UTC |
| `availability` | `{url, checkedAt, outcome, httpStatus?, evidence?}`; resultados descritos abajo |
| `expiresAt` | Fecha real `YYYY-MM-DD`, inclusiva hasta terminar el día UTC |
| `compensation` | Opcional: `currency`, `period` (`hour`, `month`, `project`), `min`, `max` opcional |
| `compensation.hoursPerMonth`, `compensation.estimatedHours` | Números positivos opcionales; horas de proyecto necesarias para calcular su tarifa |

Compensaciones finitas y no negativas; máximo >= mínimo. El perfil acepta habilidades, tipos preferidos, restricción remota y parámetros económicos. Valores por defecto: ambos tipos, sin restricción remota, objetivo USD 25/h, umbral freelance USD 25/h, presupuesto atractivo USD 2000, 160 horas/mes. Son **supuestos configurables**, no preferencias personales confirmadas. El perfil de ejemplo usa objetivo USD 35/h para mostrar la diferencia entre objetivo y umbral.

## Política de publicación y disponibilidad

Solo se aceptan como recomendaciones o sincronizaciones activas oportunidades **verified** publicadas hoy o hace 1–3 días calendario UTC, con el día 3 incluido. Al comenzar el día 4 quedan `stale`. Hoy tiene prioridad sobre cualquier score y sobre la reserva por tipo. No se interpreta este límite como 72 horas móviles: la entrada publica una fecha, sin hora.

| Estado | Significado |
| --- | --- |
| `verified` | Publicación comprobable dentro del límite, ficha abierta con evidencia y comprobación vigente |
| `stale` | Publicación hace más de 3 días |
| `unavailable` | HTTP 404/410, fuente desaparecida, ficha cerrada o deadline vencido |
| `unknown` | Fecha/evidencia ausente, futura o inconsistente, respuesta ambigua, timeout/error o verificación vencida |

Los estados se calculan; importar un campo `status` o `verified` no concede verificación. Un cierre/404/410 prevalece sobre antigüedad; todas las razones detectadas se conservan en `evaluation.verification.reasons`. `expiresAt`, fecha de captura y texto libre no sustituyen la fecha de publicación. Un HTTP 200 por sí solo no prueba que la ficha esté abierta.

Contrato ilustrativo para una evidencia **sintética** (no prueba una oferta real):

```json
{
  "title": "Developer",
  "company": "Example",
  "url": "https://example.com/jobs/1",
  "publishedAt": "2026-09-16",
  "publicationEvidence": {
    "url": "https://example.com/jobs/1",
    "excerpt": "Published September 16, 2026",
    "observedAt": "2026-09-16T12:00:00Z"
  },
  "availability": {
    "url": "https://example.com/jobs/1",
    "checkedAt": "2026-09-16T12:00:00Z",
    "outcome": "open",
    "httpStatus": 200,
    "evidence": "Ficha identificada y formulario de postulación abierto"
  }
}
```

Las URLs de ambas evidencias deben coincidir con `opportunity.url`. El responsable de la captura/adaptador debe comprobar que el extracto prueba `publishedAt` y que la ficha corresponde a esa oportunidad. No hay inferencia automática desde HTML ni scraping incorporado. `outcome` admite `open`, `closed`, `missing`, `ambiguous`, `timeout`, `error`; únicamente `open` con HTTP 200 y evidencia no vacía confirma disponibilidad. Los timestamps son ISO UTC; fechas futuras o una comprobación anterior a la publicación bloquean.

La vigencia máxima de disponibilidad es **24 horas**, con vencimiento inclusivo: exactamente 24 horas ya bloquea. `validUntil` señala el primer límite entre esa vigencia, el inicio del día 4 y el deadline. Antes de cualquier llamada a Notion, el adaptador vuelve a calcular el estado con el reloj actual. Si existe `revalidate`, la ejecuta para cada candidata y exige otra vez `verified`; si no existe, solo admite evidencia registrada aún vigente. Evidencia ya vencida bloquea y debe actualizarse en la entrada antes de intentar sincronizar. También comprueba la vigencia tras consultar Notion y antes de escribir, por si venció durante la consulta.

La API `upsertNotionRecords(records, config, transport, options?)` admite `options.revalidate`, `options.now` (reloj inyectado para pruebas) y `options.timeoutMs` (5000 por defecto; máximo 60000). El verificador recibe una copia de la oportunidad y un `AbortSignal`. Timeout, excepción o respuesta inválida bloquean sin usar Notion; los mensajes de excepción no se reflejan. No hay verificador de red ni credenciales incorporados. El módulo suministrado por un integrador es el responsable de consultar y entender la fuente, si decide habilitarlo.

### Migración e historial

Los JSON y estados versión 1 anteriores siguen cargando. Los ejemplos históricos permanecen intactos y quedan `unknown` al no tener evidencia estructurada; aunque mencionen una fecha en la descripción, no se les atribuye verificación. Para activarlos hay que comprobar la fuente y aportar los tres campos nuevos, incluida una publicación dentro del límite. No renovar artificialmente la fecha original.

El estado conserva la oportunidad actual y las versiones anteriores en `history`; el reporte mantiene todas las filas, evidencia y motivos de exclusión. `historicalEvaluations` reevalúa esas versiones con el perfil/reloj del reporte, no pretende ser un registro de scores calculados en el pasado. Las revalidaciones de CLI se guardan aun cuando impidan sincronizar. La API devuelve esas observaciones en `notionSync.records[].opportunity` para que otros integradores puedan persistirlas. Reingestar exactamente la misma versión no duplica historial.

Solo las verificadas y no excluidas por screening generan payloads activos. Las demás permanecen localmente y en `notionPlan.blocked`, con cero llamadas a Notion para ellas. El adaptador no archiva ni desactiva páginas que ya existan remotamente: cualquier limpieza de publicaciones antiguas en Notion queda fuera de este flujo.

## Decisiones de evaluación

- **Normalización:** solo USD, sin obtener tipos de cambio. Otras monedas permanecen en el registro original y producen valores USD desconocidos (`null`). Mes → hora usa horas declaradas o del perfil; hora → mes es una proyección sin volumen garantizado. Proyecto → hora exige `estimatedHours`; no proyecta ingreso mensual. Se conservan rangos y supuestos, sin redondear importes intermedios.
- **Clasificación:** prevalece el tipo explícito. Como respaldo, señales simples del título/descripción y compensación por proyecto. Señales mixtas o ausentes dejan `unknown`; no se infiere empleo solo por pago mensual.
- **Score de compatibilidad (0–100):** hasta 60 por proporción de habilidades del perfil presentes (comparación exacta en minúsculas); 20 por tipo preferido (10 si desconocido); 20 si cumple remoto o no hay restricción (10 si remoto desconocido). Perfil sin habilidades recibe 30 neutrales.
- **Score económico (0–100):** hasta 70 por `min(1, tarifa mínima / objetivo)`; freelance recibe 10 por recurrencia y 10 por crecimiento; presupuesto mínimo de proyecto atractivo recibe 10. Tarifa desconocida aporta cero puntos de tarifa y una razón explícita, no significa tarifa cero. Cada componente muestra puntos y razón; las recomendaciones agregan una prioridad separada.
- **Flexibilidad freelance:** tarifa mínima >= umbral → `meets_floor`; debajo → `flexible_review` si hay recurrencia, crecimiento o presupuesto mínimo de proyecto atractivo, y `below_floor` en caso contrario. Ninguno elimina registros ni envía aplicaciones. Sin tarifa → `needs_information`, incluso si hay presupuesto atractivo; tipo desconocido → `needs_classification`; empleo → `not_applicable` cuando hay tarifa. Los indicadores son manuales y no prometen crecimiento real.
- **Vencimiento:** independiente de los scores; `active`, `expired` o `unknown`. Se conservan vencidas para revisión. UTC hace deterministas los límites; no se adivina zona horaria de la fuente.

## Identidad y persistencia

SHA-256 de la primera identidad disponible: `(source, externalId)`; de lo contrario URL sin fragmento, tracking `utm_*`, `fbclid`, `gclid`, con query ordenada; finalmente `(company, title)` normalizados. No modifica mayúsculas del ID externo ni parámetros funcionales de la URL.

La ingesta hace upsert: el último objeto de una identidad reemplaza completamente el actual, no es un patch. Las versiones anteriores se conservan en `history`, con su evidencia de publicación y disponibilidad. Repetir la entrada actual no agrega registros ni historial; con `--now` fijo también es idéntico el reporte. El estado almacena datos fuente, no scores desactualizados; todo se reevalúa con el perfil y fecha actuales. No se borra lo que falta en un lote nuevo.

Límite deliberado: no hay deduplicación difusa ni unión entre fuentes. Agregar un ID o URL a una entrada previamente identificada por título puede crear otra identidad. Dos vacantes con igual empresa/título necesitan URL o ID distintos. El fallback puede fusionarlas si no se proporcionan. Para actualizar títulos con estabilidad, usar fuente/ID desde el inicio.

Estado JSON versionado y validado al cargar; corrupción causa error, nunca reinicio silencioso. Escritura por archivo temporal y rename. Estado y reporte son atómicos individualmente, no una transacción conjunta; si falla una escritura, corregir y repetir. Solo un escritor por estado; no ejecutar procesos concurrentes. Usar archivos propios del proyecto, con rutas distintas, sin alias por enlaces simbólicos o duros. Los directorios de datos/salida están ignorados por Git.

## Arquitectura y siguiente integración

- `contracts.ts`: contrato y validación de entrada/perfil.
- `evaluate.ts`: clasificación, compensación, vencimiento y scores; sin I/O, fecha inyectada.
- `screening.ts`: exclusiones y elegibilidad de empleo con incertidumbre explícita.
- `recommendations.ts`: selección diaria con prioridad y balance.
- `pipeline.ts`: identidad, ingesta y reporte, incluyendo una proyección local para Notion.
- `cli.ts`: argumentos, lectura JSON y persistencia local.
- `test/offers.test.ts`: pruebas unitarias y de CLI en directorios temporales.

`report.json` incluye registros, evaluaciones completas y `notion.records`. Cada proyección contiene `externalKey` estable, propiedades tipadas, explicación separada y tres propiedades explícitas de auditoría: `Origin` conserva únicamente `opportunity.source` (vacío si no fue informado), `Calculation assumptions` conserva los supuestos producidos por la normalización y `Explanation` serializa la evaluación calculada completa. El adaptador opcional `src/notion-sync.ts` genera los payloads a partir de estas propiedades y consulta la clave externa para resolver creación/actualización, sin mantener un caché de page IDs. La configuración y el esquema requerido se describen abajo.

Las pruebas cubren validación, conversiones, incertidumbre, clasificación, límites UTC, independencia de scores, las tres excepciones freelance, identidad, idempotencia, corrupción de estado y ejecución por archivo/stdin.

## Screening configurable

Los perfiles y oportunidades anteriores siguen funcionando sin campos nuevos. El perfil admite:

| Campo | Default | Uso |
| --- | --- | --- |
| `employmentMinimumMonthlyUsd` | 3000 | Mínimo inclusivo de empleo; aproximación configurable del intervalo confirmado USD 2500–3000 |
| `employmentTargetMonthlyUsd` | 4500 | Objetivo mensual de empleo; debe ser >= mínimo |
| `relocationThresholdMonthlyUsd` | 6000 | Relocalización solo con ingreso estrictamente mayor |
| `excludedTerms` | `["bombas para minería", "mining pumps"]` | Frases excluidas configurables |
| `excludedIndustries` | `[]` | Industrias excluidas configurables |

Los importes deben ser positivos y finitos. Por ejemplo, un perfil parcial válido es:

```json
{
  "employmentMinimumMonthlyUsd": 2500,
  "employmentTargetMonthlyUsd": 4500,
  "relocationThresholdMonthlyUsd": 6000,
  "excludedTerms": ["venta directa"],
  "excludedIndustries": ["tabaco"]
}
```

Las listas reemplazan sus defaults. La regla confirmada de bombas para minería se aplica siempre: detecta conjuntamente variantes de bombas/pumps y minería/mining en título, empresa, descripción, industria o habilidades. Las exclusiones ignoran mayúsculas, acentos y puntuación, respetando palabras completas. Es una regla léxica, no una interpretación semántica: incluso menciones negadas pueden dispararla. `evaluation.screening.status` marca `discarded` y `reasons` identifica los términos disparadores. Se conserva el registro original en estado y reporte/proyección local; los descartados no se envían a Notion; el descarte se recalcula con cada perfil, no se borra información.

`screening.employment` separa salario mínimo, objetivo y relocalización. Cada decisión tiene estado y razón. El mínimo del rango debe cumplir el umbral; si solo el máximo lo cumple, queda `unknown`; si ni el máximo lo cumple, es `ineligible`. USD 6000 exactos no habilita relocalización. No alcanzar el objetivo reduce prioridad, pero no impide elegibilidad.

Sin salario USD mensual o tarifa USD con `hoursPerMonth` declarado, el salario queda `unknown`: las horas del perfil usadas para proyecciones no prueban ingresos. Los ingresos por proyecto y otras monedas no se convierten en salario. Las equivalencias con horas declaradas explicitan que no garantizan volumen. `relocationRequired: false` satisface la regla de relocalización; `true` activa el umbral; su ausencia queda `unknown`, incluso si `remote` es true. Empleo es inelegible si falla una regla obligatoria y desconocido si falta información; freelance es `not_applicable` y tipo desconocido es `unknown`.

## Recomendaciones diarias

`recommend(records)` recibe registros evaluados. Cada ejecución del reporte produce `recommendations` para la fecha `generatedAt` (UTC, inyectable con `--now`); no hay scheduler ni servicio externo. Exige `verification.status === "verified"` y excluye descartadas, vencidas y empleos inelegibles. La incertidumbre salarial o de clasificación puede mantenerse para investigar únicamente si publicación y disponibilidad están verificadas; también conserva revisiones freelance bajo el piso. `unknown` de verificación nunca se recomienda.

La prioridad suma fit + score económico + 30 si cumple elegibilidad de empleo o piso freelance + 20 si alcanza el objetivo de empleo. Cada aporte está explicado. Primero se seleccionan las publicadas hoy; después las de hace 1–3 días, hasta 20 en total. Dentro de cada grupo se reservan hasta cinco plazas por tipo conocido y se completan por prioridad económica/fit. El balance no desplaza oportunidades de hoy para introducir otras antiguas. Tipo desconocido compite en plazas restantes. La lista final ordena hoy primero, luego prioridad descendente e ID estable para desempatar, independientemente del orden de entrada.

Cada recomendación incluye ID, tipo, `sameDay`, rango (`rank`), prioridad, contribuciones y razón de selección. `notion.recommendations` replica la selección y cada fila de `notion.records` incluye descarte, motivos, elegibilidad, ubicación, relocalización y rango/prioridad (null cuando no fue seleccionada). Las evaluaciones completas siguen en `explanation`. Todo es una proyección local, sin APIs.

Validación del incremento: `npm test` cubre también límites salariales, rangos inciertos, exclusiones, conservación de descartes, balance, desempates y correspondencia con Notion. `npm run check` comprueba tipos. Los ejemplos anteriores se ejecutan en la prueba de CLI sin modificarlos.

## Adaptador Notion

Quitar los flags vuelve al flujo local. La migración de propiedades de verificación se describe abajo; el estado conserva historial de cambios y revalidaciones. No ofrece rollback de escrituras remotas ya confirmadas. No borra ni archiva páginas, ni modifica bloques o el esquema. El reporte local sigue siendo la fuente de los valores sincronizados.

Crear un archivo local de configuración **sin credenciales**, por ejemplo `notion-config.json`:

```json
{
  "enabled": false,
  "dataSourceId": "12345678-1234-1234-1234-123456789012",
  "externalKeyProperty": "External key",
  "includeCalculationContext": true,
  "propertyMap": {
    "Name": "Nombre",
    "Company": "Empresa",
    "Origin": "Origen",
    "Calculation assumptions": "Supuestos",
    "Explanation": "Explicación"
  }
}
```

El ID ilustrativo debe sustituirse por el real. Es obligatorio especificar exactamente uno de `dataSourceId` o `databaseId`, y una propiedad para la clave externa. Los nombres no mapeados conservan su nombre local; se rechazan mapas desconocidos y colisiones. `enabled` es false si se omite. No hay variables de entorno, lectura de tokens ni autenticación incorporada; campos de configuración desconocidos (incluidos tokens) se rechazan sin reflejar sus valores.

La migración requiere agregar `Verification` (select: verified/stale/unavailable/unknown), `Verification reasons` (rich_text) y `Published` (date), o mapearlos con `propertyMap`. Son obligatorios para los payloads nuevos; el programa no modifica el esquema remoto. El esquema real debe coincidir: la clave externa es `rich_text`, `Name` es `title`, y las otras propiedades deben tener los tipos de `notion.records[].properties`. El mapa solo cambia nombres, no tipos. No se crean ni verifican automáticamente propiedades remotas. `includeCalculationContext` es `false` por defecto para no romper bases existentes; al activarlo, deben existir `Origin`, `Calculation assumptions` y `Explanation` (todas `rich_text`), o sus nombres mapeados. Solo se envían las propiedades presentes de la proyección conocida y la clave externa; el objeto hermano `explanation`, recomendaciones completas y campos adicionales no se envían directamente. Los null/vacíos de la proyección sí limpian valores correspondientes. Las propiedades ajenas quedan intactas. Los límites de tamaño del servicio pueden producir fallos por registro; no se truncan datos silenciosamente.

La variante `dataSourceId` fija la API `2025-09-03`; `databaseId` usa la API legacy `2022-06-28`. Ver [data sources](https://developers.notion.com/reference/data-source) y [consulta legacy](https://developers.notion.com/reference/post-database-query). No son IDs intercambiables.

Plan local sin red ni carga de transporte:

```sh
npm start -- --input examples/opportunities.json --state data/offers.json --output output/notion-plan.json --notion-dry-run --notion-config notion-config.json
```

El dry-run mantiene la ingesta y escritura local habituales y agrega `notionPlan`: `records` contiene consulta y payloads candidatos solo para verificadas; `blocked` conserva claves, estados y motivos de exclusión. Usa la fecha del reporte, sin revalidación ni carga de módulos. `confirmed:false` indica que no se comprobó existencia remota, permisos ni esquema; no predice cantidades creadas/actualizadas. Puede usarse con `enabled:false`.

La API exporta `validateNotionConfig`, `planNotionSync`, `queryExistingPages` y `upsertNotionRecords`. El transporte es una función asíncrona `HttpTransport(request) → { status, body }`, donde `body` es JSON ya decodificado; recibe método, URL fija de Notion, headers de versión y cuerpo. No depende de `fetch` global. La autenticación corresponde a un transporte provisto por el integrador, fuera de este proyecto; no incluir tokens en configuración, argumentos ni logs.

La CLI admite `--notion-sync --notion-config notion-config.json --notion-transport ./transporte-local.mjs` únicamente con `enabled:true`. El módulo explícito debe exportar `transport` conforme al contrato anterior. Puede exportar también `revalidate(opportunity, signal) → Promise<AvailabilityEvidence>`. La CLI usa ese adaptador antes de consultar Notion, conserva su resultado incluso al bloquear y vuelve a generar el reporte/recomendaciones. La sincronización siempre usa el reloj real; `--now` solo controla el reporte local y dry-run. Es código de confianza con capacidad de ejecutar efectos al importarse: revisarlo antes de usarlo. No se incluye ni se ha ejecutado un transporte autenticado. El adaptador no imprime cuerpos, headers, IDs de respuesta ni mensajes de excepción del transporte; el transporte suministrado también debe abstenerse de registrar secretos.

Solo los registros que pasan el bloqueo de verificación consultan su `externalKey`: cero coincidencias crea, una compara propiedades y actualiza solo si cambiaron, más de una (o `has_more:true`) falla por ambigüedad. Una página archivada o en papelera también falla y nunca provoca una creación sustituta. Las claves repetidas dentro del mismo lote se omiten después de la primera con `duplicate_in_batch`. El límite de dos resultados permite detectar duplicados sin paginar toda la base. Se ignoran metadatos de lectura en la comparación. La respuesta incluye contadores `created`, `updated`, `skipped`, `failed` y resultados por índice con códigos de error controlados. Un bloqueo produce `skipped`, `reason: "verification_blocked"` y el estado/razones en `verification`; no cuenta como éxito de escritura. Creación/actualización exige HTTP 2xx y respuesta de página con ID; fallos de consulta nunca se interpretan como ausencia. Los errores por registro no detienen el lote y la CLI sale con código 1 si alguno falla.

Las llamadas concurrentes dentro del mismo proceso se serializan por destino y clave. Esto no coordina procesos o máquinas distintos: no ejecutar dos procesos sincronizadores simultáneos sobre el mismo destino, porque consultar/crear no es una transacción y Notion no impone unicidad de la clave. No hay reintentos automáticos ante 429, timeouts o errores: una escritura sin respuesta puede haberse aplicado y se reporta como fallida; una ejecución posterior vuelve a consultar antes de escribir y reconcilia el valor ya aplicado. Conservar la clave externa y el mapa entre ejecuciones. Cambiar identidad o destino puede crear otras páginas.

Las pruebas incluyen configuración, contexto de cálculo, creación, actualización, idempotencia, deduplicación de lote, página archivada, fallo después de escritura, concurrencia dentro del proceso, confirmación HTTP, errores aislados, secretos simulados y CLI dry-run. Todas usan transporte falso o ejecución local; `npm test` y `npm run check` no necesitan Notion.
