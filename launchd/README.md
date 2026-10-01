# Agendas locales (launchd)

La agenda vive **fuera del código**: el CLI no sabe quién lo llama. Hoy lo llama launchd en el
Mac; si mañana el ciclo se mueve a un servidor, lo llamará cron o un Scheduled Task **sin tocar
una línea de TypeScript**. Estos archivos son plantillas versionadas — el original que ejecuta
macOS vive en `~/Library/LaunchAgents`, que no se versiona ni se respalda.

## Agentes

| Plist | Comando | Cadencia | Fase |
| --- | --- | --- | --- |
| `com.juansilva.offers-cycle` | `--dry-run` | cada hora | disponible |
| `com.juansilva.offers-digest` | `--digest` | diaria 06:00 | disponible |
| `com.juansilva.offers-sponsors` | `--refresh-sponsors` | lunes 05:00 | disponible |
| `com.juansilva.offers-sync` | `--sync` | cada hora al :20 | disponible |
| `com.juansilva.offers-status` | `--pull-status` | diaria 06:40 | disponible |
| `com.juansilva.offers-vacuum` | `--vacuum --apply` | cada 6 h (01:30, 07:30, 13:30, 19:30) | disponible |

**La purga va cuatro veces al día, y el motivo es el lock.** Toma el del checkpoint, así que si el
ciclo horario está corriendo sale con 3 y no hace nada. Con una sola oportunidad diaria eso
significaría saltarse el día entero, y el checkpoint crece ~145 MB diarios desde que `freehire` aporta
~1.900 ofertas por ciclo: dos días perdidos se comen el margen hasta el techo de 512 MB. La purga es
idempotente y tarda ~37 s, así que la segunda pasada del día no encuentra nada que borrar y cuatro
intentos no cuestan nada.

Se construyó sin agendar y eso bastó para que el checkpoint volviera de 215,8 MB a 360,8 MB en un
día. Una capacidad que no está agendada no existe.

**El agente de sync es el único que se invoca por `bin/offers`** y no por `node` directo. No es una
inconsistencia: es el único comando que necesita `NOTION_API_KEY`, y launchd no arranca un shell de
login, así que ni `~/.zshrc` ni `~/.zprofile` se leen y una variable exportada en la terminal no
llega. `bin/offers` es quien carga `~/.config/offers/env` y quien **rechaza** ese archivo si no tiene
permisos 600 o 400.

**NUNCA crees a mano los archivos de log de un agente.** Medido el 2026-09-30: un `com.juansilva.offers-sync`
recién instalado fallaba con `last exit code = 78: EX_CONFIG`, sin una sola línea en stdout ni en
stderr, mientras un clon idéntico bajo otra etiqueta corría perfecto. La causa: los `.log` los había
creado yo con `: > archivo`, y macOS les pone un `com.apple.macl` que concede acceso al proceso que
los creó —mi shell— y no al de launchd. launchd no podía abrir su propio stdout y abortaba antes de
ejecutar nada, que es por lo que no había ni un mensaje de error. Se borran y launchd los crea con
los permisos correctos:

```sh
rm -f data/logs/<agente>.{out,err}.log
launchctl kickstart -k gui/$(id -u)/com.juansilva.offers-<agente>
```

Y `bin/offers` **no** sirve como `ProgramArguments`: launchd no puede EJECUTAR un script que viva
dentro de `~/Documents` —macOS lo bloquea con `Operation not permitted`—, aunque `node`, que vive
fuera, sí puede recibir una ruta de Documents como argumento. Por eso los agentes que necesitan el
secreto usan `/bin/sh -c` cargando `~/.config/offers/env` en línea: nada de lo que se **ejecuta**
vive en Documents.

`--pull-status` va por el mismo patrón que el sync, y a las 06:40: después del digest (06:00) y del
sync (:20), así lee un tablero que ya refleja el corte del día. **Exit 9 significa que apareció un
`Estado` que el código no conoce**, y el log nombra cuál. No es transitorio: hay que decidir a qué
escalón del embudo corresponde y añadirlo a `src/notion-board.ts`.

Corre al minuto :20 para no solaparse con el ciclo del :00. Ya no compiten por el lock del
checkpoint —el sync solo lo toma unos segundos, para leer— pero escalonar la carga de red no cuesta
nada. Y escribe solo lo relevante: repoblar el tablero entero exige `--sync --all` a mano, que son
miles de peticiones.

Solo se versionan agentes cuyo comando ya existe: agendar un subcomando que aún no está
implementado produce un agente que falla en silencio cada hora.

El ciclo recolecta; el digest **solo lee** el checkpoint y entrega. Separarlos significa que un
proveedor caído no te deja sin corte diario, y que el corte se puede repetir sin volver a pedir
nada a nadie.

## Instalar

```sh
mkdir -p data/logs ~/Library/LaunchAgents
cp launchd/*.plist ~/Library/LaunchAgents/
for a in offers-cycle offers-digest offers-sponsors; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.juansilva.$a.plist; done
```

`RunAtLoad` es `false`: cargar el agente no dispara red. La primera corrida se fuerza a mano.

```sh
launchctl kickstart -k gui/$(id -u)/com.juansilva.offers-cycle
```

## Comprobar

```sh
launchctl list | rg offers
```

La segunda columna es el código de salida de la última corrida. Los códigos del CLI son
`0` completado · `2` argumentos inválidos · `3` lock ocupado · `4` fallo de fuente o
persistencia · `5` destino Notion declarado sin esquema verificado · `6` datos parciales.

```sh
tail -n 40 data/logs/cycle.out.log
```

Cada corrida imprime una línea JSON con `counts`, `heapPeakMb` y el estado por fuente.

## Desinstalar

```sh
launchctl bootout gui/$(id -u)/com.juansilva.offers-cycle
```

## Limitación conocida

Conectado a la corriente el Mac no duerme (`pmset -g` muestra `sleep 0` en AC) y el ciclo corre.
Con batería duerme al minuto y no corre. launchd recupera las corridas perdidas al despertar —
cron no lo haría — pero si el equipo pasa más de 24 h dormido, la evidencia de disponibilidad
vence por TTL y el checkpoint queda `unhealthy` hasta el siguiente ciclo. Es el comportamiento
correcto: no se puede afirmar que una vacante sigue abierta con evidencia de anteayer.
