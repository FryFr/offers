# Agendas locales (launchd)

La agenda vive **fuera del código**: el CLI no sabe quién lo llama. Hoy lo llama launchd en el
Mac; si mañana el ciclo se mueve a un servidor, lo llamará cron o un Scheduled Task **sin tocar
una línea de TypeScript**. Estos archivos son plantillas versionadas — el original que ejecuta
macOS vive en `~/Library/LaunchAgents`, que no se versiona ni se respalda.

## Agentes

| Plist | Comando | Cadencia | Fase |
| --- | --- | --- | --- |
| `com.juansilva.offers-cycle` | `--dry-run` | cada hora | disponible |
| `com.juansilva.offers-digest` | `--digest` | diaria 06:00 | pendiente (F7) |
| `com.juansilva.offers-sponsors` | `--refresh-sponsors` | semanal | pendiente (F4) |

Solo se versionan agentes cuyo comando ya existe: agendar un subcomando que aún no está
implementado produce un agente que falla en silencio cada hora.

## Instalar

```sh
mkdir -p data/logs ~/Library/LaunchAgents
cp launchd/com.juansilva.offers-cycle.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.juansilva.offers-cycle.plist
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
