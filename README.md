# mapa/ — Módulo de mapa de VURA 

Todo el código que dibuja el mapa (Leaflet + MapLibre GL, marcadores de
vehículo, líneas de ruta, ETA/distancia) vive **separado** del resto de la
app, en esta carpeta:

```
mapa/
  index.html            ← harness standalone para probar el mapa solo
  map.js                 ← el motor del mapa (antes era /map.js en la raíz)
  map.css                ← estilos exclusivos del mapa (antes vivían sueltos en /style.css)
  mock-data.js            ← datos falsos + simulador de vehículos, SOLO para index.html
  vura-map-style.json     ← estilo vectorial (copia — ver "Por qué hay 2 copias" abajo)
  vura-driver-style.json  ← estilo vectorial del conductor (copia, ver abajo)
```

## Por qué se separó

El mapa venía dando problemas dentro del monolito de `index.html`
(1900+ líneas de HTML/JS mezclado con login, Firebase, paneles de
pasajero/conductor/admin). Cualquier bug de mapa obligaba a levantar toda la
app (Firebase, seed data, login) solo para ver un marcador. Ahora se puede
abrir `mapa/index.html` directo en el navegador — sin login, sin Firebase,
sin nada más — y ver/depurar el mapa aislado con datos de prueba.

## Cómo probarlo

Abre `mapa/index.html` en el navegador (doble click, o `python3 -m http.server`
desde la raíz del proyecto y entra a `/mapa/`). Vas a ver:

- El mapa 3D con dos empresas de ejemplo (una "registrada" con vehículos
  moviéndose, otra "sin registrar" con la ruta tenue y sin vehículos).
- Un panel arriba a la izquierda con botones para seleccionar una empresa,
  deseleccionarla, y pausar/reanudar la simulación de vehículos.

Cualquier cambio que hagas en `map.js` o `map.css` se ve reflejado tanto acá
como en la app real, porque **son los mismos archivos** — la app principal
los carga desde esta misma carpeta (ver más abajo).

## Cómo está integrado en la app principal ahora

`index.html` (raíz del proyecto) hace referencia directa a estos archivos:

```html
<link rel="stylesheet" href="mapa/map.css?v=1">
...
<script src="mapa/map.js?v=8"></script>
```

Es decir: por ahora la integración es simplemente "cargar los archivos desde
su nueva carpeta" — el resto de la app (`passenger.js`, `driver.js`,
`admin.js`) sigue llamando a las mismas funciones globales de siempre
(`initMap()`, `showRoute()`, `updateMapFromLiveData()`, etc.) y no tuvo que
tocarse. Esto era importante para no romper nada mientras se hacía la
separación.

### API pública que expone `mapa/map.js` (sin cambios respecto a antes)

| Función | Para qué sirve |
|---|---|
| `initMap()` | Crea el mapa (Leaflet + capa MapLibre GL 3D) sobre `#map` |
| `showRoute(companyId, company)` | Dibuja/actualiza la ruta ida/retorno de una empresa |
| `getRouteBoundsForCompany(companyId)` | Bounds para hacer `fitBounds` |
| `updateMapFromLiveData()` | Sincroniza marcadores de vehículo con `liveVehicles` |
| `estimateEtaMinutes(company, live)` / `estimateDistanceKm(...)` | ETA/distancia siguiendo la ruta real |
| `estimateEtaConfidence(live)` | Qué tan confiable es el ETA (según antigüedad/precisión del GPS) |
| `isCompanyRegistered(id)` / `getCompanyStatusBadge(id)` | Badge "Activa" vs "Ruta disponible" |
| `setWaitingTarget(key)` | Modo enfoque: atenúa todo menos un vehículo |
| `createVehicleIcon`, `animateMarkerTo`, `removeVehicleMarker`, `vehicleKey` | Helpers de marcador |
| `window.upsertRouteLine` / `window.removeRouteLine` / `window.waitForGlMapReady` | Capas nativas de ruta sobre MapLibre GL (las usa también `driver.js` para el mapa del conductor) |

Estas funciones siguen dependiendo de variables globales que viven en
`index.html` (`map`, `companies`, `liveVehicles`, `vehicleMarkers`,
`routePolylines`, `vehicleLastKnownPos`, `selectedCompanyId`) y de
`utils.js` (`haversine`, `calculateBearing`) e `icons.js` (`escapeHtml`),
que deben cargarse antes.

## "Por qué hay 2 copias" de los JSON de estilo

`vura-map-style.json` y `vura-driver-style.json` siguen existiendo también
en la raíz del proyecto, porque `driver.js` y `admin.js` (el mapa del
conductor y el editor de rutas del admin) todavía cargan su propio mapa por
separado y apuntan a esa ruta relativa a la raíz. Hay una copia dentro de
`mapa/` únicamente para que el harness standalone (`mapa/index.html`)
funcione sin depender de la raíz. Si edites el estilo del mapa, actualiza
**ambas copias** (o mejor: hacé la Fase 2 de abajo).

## Fase 2 (pendiente, no incluida en este cambio)

Ahora mismo `driver.js` (mapa del conductor, `#driverMap`) y `admin.js`
(editor de rutas, `#routeEditorMap`) siguen inicializando **su propia
instancia de mapa** con código duplicado dentro de esos archivos, en vez de
usar este módulo. Es la causa más probable de que "el mapa siga dando
problemas": hay 3 inicializaciones de Leaflet+MapLibre casi idénticas,
mantenidas por separado.

El siguiente paso lógico es que `mapa/map.js` exponga una función genérica
tipo `VuraMap.createMap(containerId, options)` reusable por los 3 casos
(pasajero, conductor, editor de rutas del admin), y migrar `driver.js` /
`admin.js` para que la usen en vez de reimplementar su propio `L.map(...)`.
No se hizo en este cambio para no tocar `driver.js`/`admin.js` (900 y 600
líneas respectivamente) sin poder probarlo en vivo contra Firebase real —
mejor hacerlo como un paso aparte, revisando cada pantalla.
