# Generalized shuttle ETA: local UI preview

These screenshots show the actual app rendering one recorded public Red bus payload with the browser clock fixed to **September 9, 2026, 07:34:10 ET**. The preview ran on `127.0.0.1:8097` with a throwaway database, disabled collection and fitting, and mocked API responses. The server has been stopped.

- [Map](map.png): Red bus #119 at **344 Winchester**. The rendered **8–11 min** pause badge is the historical pause range. It is not the archived internal standing forecast or evidence of the new model operating in this example.
- [Trip](trip.png): destination **Division/Prospect (stop 48)**, displayed as its coordinates, `41.324769,-72.923522`.
- [Issues](issues.png): the normal empty reports screen from the isolated database.

The available first morning visits did not contain a valid current-stop standing context for stop 11. This is therefore an honest preview of the normal duration fallback. The archived internal forecast and this newly opened browser have different tracking histories; their displayed values should not be treated as an exact replay comparison. Basemap tiles are not visible in these captures; the route overlays and navigation rendered, and no failed requests were reported. The cause of the missing tiles was not established.

[Historical validation](historical-validation.png) is a separate, previously examined **September 8** regression figure copied from `docs/data/red-first-display-repaired-2026-09-08.png`. It is not a result from the September 9 preview or a prospective accuracy claim. Only previously issued forecasts and public input payloads were inspected to make this preview; no future outcomes were read.

The automated walk explicitly clicked **trip, map, and issues** with case-insensitive button names. All three succeeded, with **zero page errors and zero failed requests**. See [preview.json](preview.json) for the run result and [provenance.json](provenance.json) for the observation and fixture hashes.

## Reproduce

Requires the repository's installed dependencies and Chromium (`/usr/bin/chromium`, or set `BOT_CHROMIUM_PATH`). From the repository root, build the actual frontend:

```sh
npm --prefix services/shuttle-v2/web run build
```

In one terminal, start the isolated server with a fresh temporary database:

```sh
cd services/shuttle-v2
SHUTTLE_V2_DB="$(mktemp /tmp/generalized-shuttle-eta-preview.XXXXXX.db)" SHUTTLE_STANDING_FORECAST=0 node --import tsx ../../pr-preview/generalized-shuttle-eta/server.mts
```

In another terminal, from the repository root:

```sh
node pr-preview/generalized-shuttle-eta/preview.mjs
```

Stop the server with Ctrl-C when finished. The script overwrites the three UI screenshots and `preview.json`; the historical figure is unchanged. Server-side upstream access is disabled, browser API writes are intercepted, and this workflow performs no deployment or production writes.
