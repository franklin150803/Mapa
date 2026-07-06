// mapa/map.js
// ============================================================================
// MODULO DE MAPA (VURA) — todo el codigo de mapa vive aqui, separado del
// resto de la app. Ver mapa/README.md para la API publica, como probarlo
// de forma standalone (mapa/index.html) y como esta integrado en la app
// principal.
//
// Mapa del pasajero: inicializacion de Leaflet, dibujo de rutas ida/retorno,
// marcadores de vehiculos con animacion e indicador de rumbo, calculo de
// ETA y distancia siguiendo la ruta real (no en linea recta).
//
// Dependencias:
//   - utils.js (haversine, calculateBearing) — debe cargarse ANTES que este
//     archivo. Son funciones matematicas genericas, no especificas de mapa.
//   - Variables globales del script principal (index.html): map, companies,
//     liveVehicles, vehicleMarkers, routePolylines, vehicleLastKnownPos,
//     selectedCompanyId. Estas siguen viviendo en index.html por ahora; ver
//     mapa/README.md, seccion "Fase 2", para el plan de sacarlas tambien.
// ============================================================================

        // ==================== RUTAS NATIVAS SOBRE EL MAPA 3D (MapLibre GL) ====================
        // El mapa base (pasajero y conductor) se renderiza en una escena WebGL
        // con pitch/bearing (vista 3D inclinada). Antes las rutas se dibujaban
        // con L.polyline de Leaflet, que vive en un pane 2D aparte y NO respeta
        // esa perspectiva: se veian como una calcomania flotando encima del
        // mapa en vez de una linea "pegada" al piso, sobre todo al rotar/
        // inclinar. La solucion: agregar la ruta como source+layer nativo de
        // MapLibre (misma escena 3D que calles y edificios).
        //
        // Nota: este mapa no tiene terreno real (DEM), el "pitch" es solo la
        // camara mirando de lado un plano, no hay eje Z de elevacion real. El
        // equivalente practico a "infinitamente cerca del mapa pero nunca
        // dentro" es el ORDEN de la capa dentro del estilo (ver beforeId mas
        // abajo): se inserta justo encima de calles/edificios y debajo de las
        // etiquetas, para no competir pixel a pixel con la capa de calles
        // (evita el parpadeo tipo z-fighting) y para no tapar los nombres de
        // calles/distritos. Si en el futuro se agrega terreno real (DEM), ahi
        // si tendria sentido un offset de elevacion real (line-translate).
        //
        // (Movido aqui desde utils.js: es codigo 100% de mapa, no una
        // utilidad matematica generica. Lo usan tanto mapa/map.js como
        // driver.js, por eso sigue expuesto en window.*)
        window.GL_ROUTE_LAYER_BEFORE_ID = 'boundary_2';

        // Espera a que el estilo del mapa (glMap) este listo antes de tocar
        // sources/layers. addLayer/addSource fallan si se llaman antes de que
        // el estilo termine de cargar.
        window.waitForGlMapReady = function(glMap, cb) {
            if (!glMap || typeof cb !== 'function') return;
            let done = false;
            const fire = () => {
                if (done) return;
                done = true;
                cb(glMap);
            };
            if (glMap.isStyleLoaded()) {
                fire();
                return;
            }
            glMap.once('load', fire);
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (done || glMap.isStyleLoaded()) {
                    clearInterval(poll);
                    fire();
                    return;
                }
                if (attempts > 40) clearInterval(poll); // ~6s, nos rendimos en silencio
            }, 150);
        };

        // Crea (o actualiza si ya existe) un layer de linea nativo de MapLibre
        // a partir de un arreglo de puntos [lat, lng]. style: { color, weight,
        // opacity, dash }. Devuelve { sourceId, layerId, points } o null.
        window.upsertRouteLine = function(glMap, id, latLngPoints, style) {
            if (!glMap || !latLngPoints || latLngPoints.length < 2) return null;
            const sourceId = 'route-src-' + id;
            const layerId = 'route-line-' + id;
            const coordinates = latLngPoints.map(p => [p[1], p[0]]); // Leaflet [lat,lng] -> GeoJSON [lng,lat]
            const geojson = { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} };
            const dashArray = (style && style.dash) ? style.dash : [1, 0]; // [1,0] = linea solida

            const existingSource = glMap.getSource(sourceId);
            if (existingSource) {
                existingSource.setData(geojson);
            } else {
                glMap.addSource(sourceId, { type: 'geojson', data: geojson });
            }

            if (!glMap.getLayer(layerId)) {
                const beforeId = glMap.getLayer(window.GL_ROUTE_LAYER_BEFORE_ID) ? window.GL_ROUTE_LAYER_BEFORE_ID : undefined;
                glMap.addLayer({
                    id: layerId,
                    type: 'line',
                    source: sourceId,
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: {
                        'line-color': style.color,
                        'line-width': style.weight,
                        'line-opacity': style.opacity,
                        'line-dasharray': dashArray
                    }
                }, beforeId);
            } else {
                glMap.setPaintProperty(layerId, 'line-color', style.color);
                glMap.setPaintProperty(layerId, 'line-width', style.weight);
                glMap.setPaintProperty(layerId, 'line-opacity', style.opacity);
                glMap.setPaintProperty(layerId, 'line-dasharray', dashArray);
            }

            return { sourceId, layerId, points: latLngPoints };
        };

        // Quita un layer/source de ruta creado con upsertRouteLine (por
        // ejemplo cuando una empresa deja de tener retorno configurado).
        window.removeRouteLine = function(glMap, id) {
            if (!glMap) return;
            const sourceId = 'route-src-' + id;
            const layerId = 'route-line-' + id;
            if (glMap.getLayer(layerId)) glMap.removeLayer(layerId);
            if (glMap.getSource(sourceId)) glMap.removeSource(sourceId);
        };

        // ==================== MAP (PASSENGER) ====================
                function initMap() {
                    map = L.map('map', {
                        zoomControl: false,
                        attributionControl: true,
                        minZoom: 3,
                        zoomSnap: 0.5,
                        zoomDelta: 0.5,
                        wheelPxPerZoomLevel: 90,
                        fadeAnimation: true,
                        zoomAnimation: true,
                        markerZoomAnimation: true
                    }).setView([-12.0464, -77.0428], 12);

                    const glLayer = L.maplibreGL({
                        style: 'vura-map-style.json',
                        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                        // antialias: suaviza los bordes de los edificios extruidos (fill-extrusion).
                        // Sin esto, los techos/paredes de los edificios en 3D se ven con dientes de
                        // sierra muy notorios apenas hay pitch, sobre todo en pantallas retina.
                        canvasContextAttributes: { antialias: true }
                    }).addTo(map);

                    window.glMap = glLayer.getMaplibreMap();

                    glLayer.getMaplibreMap().once('styledata', () => {
                        const glMap = glLayer.getMaplibreMap();
                        glMap.setPitch(55);
                        glMap.setBearing(-10);
                    });

                    map.on('click', function(e) {
                        const lat = e.latlng.lat;
                        const lng = e.latlng.lng;
                        if (window.userLocationMarker) {
                            window.userLocationMarker.setLatLng([lat, lng]);
                        } else {
                            window.userLocationMarker = L.marker([lat, lng], {
                                icon: L.divIcon({
                                    className: 'user-location-marker',
                                    html: '<div style="width:16px; height:16px; border-radius:50%; background:#2563eb; border:3px solid white; box-shadow:0 0 10px rgba(37,99,235,0.6);"></div>'
                                })
                            }).addTo(map);
                        }
                        showToast("Ubicación fijada en: " + lat.toFixed(4) + ", " + lng.toFixed(4), "success");
                    });
                }

                // ==================== ROUTING REAL (ORS via Cloud Function, con fallback OSRM) ====================
                        // ORS_API_KEY eliminado - ahora se usa Firebase Cloud Function getOrsRoute
                        const routeCache = {};

                        // URL de la Cloud Function (configurar en producción)
                        // Opciones:
                        // - Firebase Functions: https://REGION-PROJECT.cloudfunctions.net/getOrsRoute
                        // - Netlify Functions: /.netlify/functions/getOrsRoute
                        // - Vercel: /api/getOrsRoute
                        const FUNCTIONS_BASE_URL = 'https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net';

                        // Servidor demo publico de OSRM (gratis, sin API key). Se usa
                        // SOLO como fallback mientras no haya Cloud Function desplegada
                        // (FUNCTIONS_BASE_URL sigue con el placeholder YOUR_PROJECT_ID).
                        // Sin esto, showRoute() dibujaba routePointsIda/Retorno crudos
                        // (2-6 puntos separados por kilometros) en linea recta, sin pasar
                        // por ningun motor de ruteo — por eso la ruta cortaba en diagonal
                        // a traves de manzanas en vez de seguir las calles reales.
                        // Politica de uso del demo: max ~1 req/seg, uso razonable/no
                        // comercial, sin garantia de uptime.
                        // https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server
                        const OSRM_DEMO_URL = 'https://router.project-osrm.org/route/v1/driving';

                        async function fetchRouteFromOsrmDemo(points) {
                            try {
                                // OSRM quiere "lng,lat;lng,lat;...", nuestros puntos vienen [lat,lng]
                                const coordsParam = points.map(p => `${p[1]},${p[0]}`).join(';');
                                const res = await fetch(`${OSRM_DEMO_URL}/${coordsParam}?overview=full&geometries=geojson`);
                                if (!res.ok) {
                                    console.warn('OSRM demo routing error:', res.status);
                                    return null;
                                }
                                const data = await res.json();
                                const coords = data?.routes?.[0]?.geometry?.coordinates;
                                if (!coords || !coords.length) return null;
                                return coords.map(c => [c[1], c[0]]); // GeoJSON [lng,lat] -> [lat,lng]
                            } catch (e) {
                                console.warn('OSRM demo routing error:', e);
                                return null;
                            }
                        }

                        async function fetchOrsRoute(points) {
                            if (!points || points.length < 2) return null;

                            const key = points.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');
                            if (routeCache[key]) return routeCache[key];

                            // 1) Cloud Function propia (produccion), solo si esta configurada.
                            if (!FUNCTIONS_BASE_URL.toLowerCase().includes('your_project_id')) {
                                try {
                                    const res = await fetch(`${FUNCTIONS_BASE_URL}/getOrsRoute`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ data: { coordinates: points } }), // Callable protocol
                                    });

                                    if (res.ok) {
                                        const data = await res.json();
                                        // Callable protocol response: { data: { coordinates: [...] } }
                                        const latLngs = data?.data?.coordinates || data?.coordinates;
                                        if (latLngs && latLngs.length) {
                                            routeCache[key] = latLngs;
                                            return latLngs;
                                        }
                                    } else {
                                        console.warn('Cloud Function routing error:', res.status);
                                    }
                                } catch (e) {
                                    console.warn('Cloud Function routing error:', e);
                                }
                            }

                            // 2) Fallback: OSRM demo (gratis, sin key) mientras no haya
                            // Cloud Function desplegada.
                            const osrmLatLngs = await fetchRouteFromOsrmDemo(points);
                            if (osrmLatLngs) {
                                routeCache[key] = osrmLatLngs;
                                return osrmLatLngs;
                            }

                            // 3) Ultimo recurso: null -> showRoute() usa los puntos crudos.
                            return null;
                        }

        // ==================== MOSTRAR RUTAS (MODIFICADO) ====================
        // Ahora muestra rutas para TODAS las empresas (incluso no registradas)
        // pero los vehículos SOLO para empresas registradas (registered: true)
        //
        // Las rutas se dibujan como layers nativos de MapLibre GL (no como
        // L.polyline de Leaflet) para que vivan en la misma escena 3D que el
        // resto del mapa y respeten el pitch/bearing en vez de flotar como un
        // overlay plano encima. Ver window.upsertRouteLine en utils.js.
        async function showRoute(companyId, company) {
            if (!company || !company.routePointsIda) return;

            const routePointsIda = company.routePointsIda;
            const routePointsRetorno = company.routePointsRetorno;

            const isSelected = selectedCompanyId === companyId;
            const isRegistered = company.registered === true;
            const weight = isSelected ? 4.5 : (isRegistered ? 2.2 : 1.2);
            const opacity = isSelected ? 1.0 : (isRegistered ? 0.6 : 0.2);
            const dash = isSelected ? null : (isRegistered ? null : [1.3, 1]);

            const idaColor = isSelected ? '#22D3EE' : (isRegistered ? '#22D3EE' : '#0891b2');
            const retornoColor = isSelected ? '#FF5252' : (isRegistered ? '#FF5252' : '#dc2626');

            const idaPoints = await fetchOrsRoute(routePointsIda) || routePointsIda;
            const retPoints = (routePointsRetorno && routePointsRetorno.length > 1)
                ? (await fetchOrsRoute(routePointsRetorno) || routePointsRetorno)
                : null;

            window.waitForGlMapReady(window.glMap, (glMap) => {
                const ida = window.upsertRouteLine(glMap, `${companyId}-ida`, idaPoints, {
                    color: idaColor, weight, opacity, dash
                });

                let retorno = null;
                if (retPoints) {
                    retorno = window.upsertRouteLine(glMap, `${companyId}-retorno`, retPoints, {
                        color: retornoColor, weight, opacity, dash
                    });
                } else {
                    window.removeRouteLine(glMap, `${companyId}-retorno`);
                }

                routePolylines[companyId] = { ida, retorno };
            });
        }

        function getRouteBoundsForCompany(companyId) {
            const entry = routePolylines[companyId];
            if (!entry) return null;
            const points = [];
            if (entry.ida) points.push(...entry.ida.points);
            if (entry.retorno) points.push(...entry.retorno.points);
            return points.length ? L.latLngBounds(points) : null;
        }

        // ==================== ICONO DE VEHICULO (marcador nativo MapLibre GL) ====================
        // Antes esto devolvia un L.divIcon (Leaflet), y el marcador vivia en el
        // pane de Leaflet (DOM 2D) mientras el mapa base + rutas viven en el
        // canvas WebGL de MapLibre. Leaflet posiciona sus marcadores con SU
        // PROPIA proyeccion plana (sin pitch/bearing) y los repinta en su
        // propio ciclo, mientras que el canvas GL se redibuja con throttling
        // en su propio ciclo (ver L.MaplibreGL: updateInterval=32ms). Son dos
        // sistemas de render independientes: por eso el bus/las rutas se
        // "quedaban atras" al rotar/inclinar/pandear el mapa, en vez de moverse
        // pegados a el.
        //
        // La solucion es la misma que ya se aplico a las rutas: sacar el bus
        // del mundo de Leaflet y ponerlo como maplibregl.Marker, que MapLibre
        // reposiciona en cada frame usando su propia matriz de proyeccion 3D
        // (la misma que usan calles/edificios/rutas). Con eso, bus + ruta +
        // calle quedan en el mismo reloj de renderizado.
        function buildVehicleMarkerHtml(color, moving, plate, heading) {
            const label = plate ? escapeHtml(String(plate)) : '';
            const rotation = (typeof heading === 'number') ? heading : 0;
            return `
                <div class="vehicle-marker-wrap ${moving ? 'moving' : ''}">
                    <div class="vehicle-marker-label" style="border-color:${color}; color:${color};">${label}</div>
                    <div class="vehicle-marker-dot-wrap">
                        <div class="vehicle-marker-radar" style="background:${color};"></div>
                        <div class="vehicle-marker-dot" style="background:${color}; box-shadow: 0 0 8px ${color}, 0 0 3px rgba(0,0,0,0.5);">
                            <div class="vehicle-marker-arrow" style="transform: rotate(${rotation}deg); opacity:${moving ? 1 : 0};">▲</div>
                        </div>
                    </div>
                </div>
            `;
        }

        // Crea el elemento DOM raiz que se le pasa a maplibregl.Marker({element}).
        // OJO: MapLibre toma posesion de `el.style.transform` para posicionar
        // el marcador (traduccion en pixeles segun lng/lat). Por eso la
        // animacion de "entrada" (fade + scale) se aplica al hijo
        // .vehicle-marker-wrap y NUNCA al elemento raiz, para no pisar el
        // transform que usa MapLibre para ubicarlo.
        function createVehicleMarkerElement(color, moving, plate, heading) {
            const el = document.createElement('div');
            el.className = 'vehicle-marker';
            el.innerHTML = buildVehicleMarkerHtml(color, moving, plate, heading);
            return el;
        }

        // Compat: driver.js (fuera de esta carpeta, ver README "Fase 2")
        // todavia puede depender de window.createVehicleIcon devolviendo un
        // L.divIcon de Leaflet para su propio mapa de conductor. Se deja este
        // shim para no romperlo mientras no se migre tambien ese archivo a
        // marcadores nativos. El mapa de PASAJERO (este archivo) ya NO usa
        // esta funcion internamente: usa createVehicleMarkerElement +
        // updateVehicleMarkerElement (ver arriba).
        function createVehicleIcon(color, moving, plate, heading) {
            return L.divIcon({
                className: 'vehicle-marker',
                html: buildVehicleMarkerHtml(color, moving, plate, heading),
                iconSize: [70, 46],
                iconAnchor: [35, 40]
            });
        }

        // Actualiza un marcador existente IN PLACE (sin recrear el DOM cada
        // tick, que era lo que hacia marker.setIcon(...) antes).
        function updateVehicleMarkerElement(el, color, moving, plate, heading) {
            if (!el) return;
            const wrap = el.querySelector('.vehicle-marker-wrap');
            if (wrap) wrap.classList.toggle('moving', !!moving);

            const label = el.querySelector('.vehicle-marker-label');
            if (label) {
                const text = plate ? escapeHtml(String(plate)) : '';
                if (label.textContent !== text) label.textContent = text;
                label.style.borderColor = color;
                label.style.color = color;
            }

            const radar = el.querySelector('.vehicle-marker-radar');
            if (radar) radar.style.background = color;

            const dot = el.querySelector('.vehicle-marker-dot');
            if (dot) {
                dot.style.background = color;
                dot.style.boxShadow = `0 0 8px ${color}, 0 0 3px rgba(0,0,0,0.5)`;
            }

            const arrow = el.querySelector('.vehicle-marker-arrow');
            if (arrow) {
                const rotation = (typeof heading === 'number') ? heading : 0;
                arrow.style.transform = `rotate(${rotation}deg)`;
                arrow.style.opacity = moving ? 1 : 0;
            }
        }

        function vehicleKey(companyId, vehicleId) { return companyId + '__' + vehicleId; }

        // ==================== MODO ENFOQUE ====================
        let waitingTargetKey = null;

        function applyDimClass(marker, markerId) {
            if (!marker) return;
            const el = marker.getElement && marker.getElement();
            if (!el) return;
            const wrap = el.querySelector('.vehicle-marker-wrap');
            if (!wrap) return;
            if (waitingTargetKey) {
                wrap.classList.toggle('vura-dimmed', markerId !== waitingTargetKey);
                wrap.classList.toggle('vura-waiting-target', markerId === waitingTargetKey);
            } else {
                wrap.classList.remove('vura-dimmed', 'vura-waiting-target');
            }
        }

        function setWaitingTarget(key) {
            waitingTargetKey = key;
            const targetCompanyId = key ? key.split('__')[0] : null;

            Object.keys(vehicleMarkers).forEach(markerId => applyDimClass(vehicleMarkers[markerId], markerId));

            const glMap = window.glMap;
            Object.keys(routePolylines).forEach(companyId => {
                const entry = routePolylines[companyId];
                if (!entry || !glMap) return;
                let opacity;
                if (targetCompanyId) {
                    opacity = (companyId === targetCompanyId) ? 0.9 : 0.08;
                } else {
                    opacity = (companyId === selectedCompanyId) ? 0.9 : 0.35;
                }
                if (entry.ida && glMap.getLayer(entry.ida.layerId)) {
                    glMap.setPaintProperty(entry.ida.layerId, 'line-opacity', opacity);
                }
                if (entry.retorno && glMap.getLayer(entry.retorno.layerId)) {
                    glMap.setPaintProperty(entry.retorno.layerId, 'line-opacity', opacity);
                }
            });
        }

        // fromLatLng: {lat, lng} (viene de marker.getLngLat() invertido, ver
        // abajo). toLatLng: [lat, lng]. El marker es un maplibregl.Marker
        // nativo, asi que se reposiciona con setLngLat (no con el setLatLng
        // de Leaflet) para que quede sincronizado con el mismo reloj de
        // render que usan las rutas y el resto de la escena 3D.
        function animateMarkerTo(marker, fromLatLng, toLatLng, durationMs) {
            if (marker._animFrame) {
                cancelAnimationFrame(marker._animFrame);
                marker._animFrame = null;
            }

            const start = performance.now();
            const fromLat = fromLatLng.lat, fromLng = fromLatLng.lng;
            const toLat = toLatLng[0], toLng = toLatLng[1];

            function step(now) {
                const elapsed = now - start;
                const t = Math.min(1, elapsed / durationMs);
                const ease = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2;
                const lat = fromLat + (toLat - fromLat) * ease;
                const lng = fromLng + (toLng - fromLng) * ease;
                marker.setLngLat([lng, lat]);
                if (t < 1) {
                    marker._animFrame = requestAnimationFrame(step);
                } else {
                    marker._animFrame = null;
                }
            }
            marker._animFrame = requestAnimationFrame(step);
        }

        // ==================== ACTUALIZAR MAPA CON DATOS EN VIVO (MODIFICADO) ====================
        // SOLO muestra vehículos para empresas REGISTRADAS (registered: true)
        function updateMapFromLiveData() {
            if (!map) return;
            Object.keys(companies).forEach(companyId => {
                const company = companies[companyId];
                if (!company.vehicles) return;

                // Si la empresa NO está registrada, NO mostramos vehículos
                if (company.registered !== true) return;

                Object.keys(company.vehicles).forEach(vehicleId => {
                    const vehicle = company.vehicles[vehicleId];
                    const live = (liveVehicles[companyId] || {})[vehicleId];
                    const markerId = vehicleKey(companyId, vehicleId);

                    if (!live || !isOnline(live)) {
                        removeVehicleMarker(markerId);
                        return;
                    }

                    const moving = (live.speed || 0) >= 3;
                    const sentidoColor = live.sentido === 'retorno' ? '#ef4444' : '#0ea5e9';
                    const plateLabel = vehicle.plate || vehicleId;

                    const prevPos = vehicleLastKnownPos[markerId];
                    if (prevPos && prevPos.lat === live.lat && prevPos.lng === live.lng &&
                        prevPos.timestamp === live.timestamp) {
                        return;
                    }

                    let heading = (typeof live.heading === 'number') ? live.heading : null;
                    if (heading === null && prevPos) {
                        const distM = haversine(prevPos.lat, prevPos.lng, live.lat, live.lng);
                        if (distM >= 5) heading = calculateBearing(prevPos.lat, prevPos.lng, live.lat, live.lng);
                        else heading = prevPos.heading;
                    }

                    if (vehicleMarkers[markerId]) {
                        const existing = vehicleMarkers[markerId].getLngLat();
                        const fromLatLng = { lat: existing.lat, lng: existing.lng };
                        animateMarkerTo(vehicleMarkers[markerId], fromLatLng, [live.lat, live.lng], 2500);
                        updateVehicleMarkerElement(vehicleMarkers[markerId].getElement(), sentidoColor, moving, plateLabel, heading);
                        applyDimClass(vehicleMarkers[markerId], markerId);
                    } else {
                        if (!window.glMap) return; // el mapa GL aun no esta listo

                        const el = createVehicleMarkerElement(sentidoColor, moving, plateLabel, heading);
                        el.style.cursor = 'pointer';
                        el.addEventListener('click', (e) => {
                            e.stopPropagation();
                            showVehiclePanel(companyId, vehicleId);
                        });

                        // Marcador NATIVO de MapLibre GL (no L.marker de Leaflet):
                        // vive en la misma escena WebGL que las rutas y respeta
                        // pitch/bearing igual que ellas, sin quedarse atras.
                        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] })
                            .setLngLat([live.lng, live.lat])
                            .addTo(window.glMap);

                        // La animacion de entrada va sobre el hijo .vehicle-marker-wrap
                        // y no sobre `el` (la raiz), porque MapLibre controla
                        // el.style.transform para el posicionamiento.
                        const wrap = el.querySelector('.vehicle-marker-wrap');
                        if (wrap) {
                            wrap.style.opacity = '0';
                            wrap.style.transform = 'scale(0.5)';
                            requestAnimationFrame(() => {
                                wrap.style.transition = 'opacity 0.35s ease, transform 0.35s cubic-bezier(.34,1.4,.64,1)';
                                wrap.style.opacity = '1';
                                wrap.style.transform = 'scale(1)';
                            });
                        }

                        vehicleMarkers[markerId] = marker;
                        applyDimClass(marker, markerId);
                    }

                    vehicleLastKnownPos[markerId] = { lat: live.lat, lng: live.lng, heading, timestamp: live.timestamp };
                });
            });
        }

        function removeVehicleMarker(markerId) {
            if (vehicleMarkers[markerId]) {
                if (vehicleMarkers[markerId]._animFrame) {
                    cancelAnimationFrame(vehicleMarkers[markerId]._animFrame);
                }
                // marker.remove() es la API nativa de maplibregl.Marker (ya no
                // es un L.marker de Leaflet, asi que no se saca via map.removeLayer).
                vehicleMarkers[markerId].remove();
                delete vehicleMarkers[markerId];
                delete vehicleLastKnownPos[markerId];
            }
        }

        function isOnline(live) {
            if (!live || !live.timestamp) return false;
            return (Date.now() - live.timestamp) < 60000;
        }

        function getActiveRoutePoints(company, live) {
            const sentido = (live && live.sentido) || 'ida';
            if (sentido === 'retorno' && company.routePointsRetorno && company.routePointsRetorno.length) {
                return company.routePointsRetorno;
            }
            return company.routePointsIda;
        }
        // ==================== PROYECCIÓN EN RUTA (Trigonometría Esférica) ====================
        // Usa haversine() de utils.js (cargado antes que map.js)
        const R_EARTH = 6371000; // metros

        function bearing(lat1, lng1, lat2, lng2) {
            const toRad = d => d * Math.PI / 180;
            const toDeg = r => r * 180 / Math.PI;
            const dLng = toRad(lng2 - lng1);
            const lat1r = toRad(lat1);
            const lat2r = toRad(lat2);
            const y = Math.sin(dLng) * Math.cos(lat2r);
            const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);
            return (toDeg(Math.atan2(y, x)) + 360) % 360;
        }

        function projectPointOnSegment(lat, lng, aLat, aLng, bLat, bLng) {
            // Proyección esférica: encontrar punto más cercano en gran círculo A-B
            // Usando fórmula de intersección de gran círculos
            const lat1 = aLat * Math.PI / 180;
            const lon1 = aLng * Math.PI / 180;
            const lat2 = bLat * Math.PI / 180;
            const lon2 = bLng * Math.PI / 180;
            const lat3 = lat * Math.PI / 180;
            const lon3 = lng * Math.PI / 180;

            // Distancias angulares
            const d13 = 2 * Math.asin(Math.sqrt(
                Math.sin((lat3 - lat1) / 2) ** 2 +
                Math.cos(lat1) * Math.cos(lat3) * Math.sin((lon3 - lon1) / 2) ** 2
            ));
            const d12 = 2 * Math.asin(Math.sqrt(
                Math.sin((lat2 - lat1) / 2) ** 2 +
                Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
            ));

            if (d12 === 0) {
                return { lat: aLat, lng: aLng, t: 0, distToSegment: haversine(lat, lng, aLat, aLng) };
            }

            // Rumbo inicial A->B
            const brng12 = Math.atan2(
                Math.sin(lon2 - lon1) * Math.cos(lat2),
                Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
            );
            // Rumbo inicial A->P
            const brng13 = Math.atan2(
                Math.sin(lon3 - lon1) * Math.cos(lat3),
                Math.cos(lat1) * Math.sin(lat3) - Math.sin(lat1) * Math.cos(lat3) * Math.cos(lon3 - lon1)
            );

            // Distancia angular cross-track
            const dxt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
            // Distancia angular along-track
            const dat = Math.acos(Math.cos(d13) / Math.cos(dxt));

            // Clampear al segmento
            const t = Math.max(0, Math.min(1, dat / d12));

            // Punto interpolado en gran círculo (slerp)
            const a = Math.sin((1 - t) * d12) / Math.sin(d12);
            const b = Math.sin(t * d12) / Math.sin(d12);
            const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
            const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
            const z = a * Math.sin(lat1) + b * Math.sin(lat2);

            const projLat = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
            const projLng = Math.atan2(y, x) * 180 / Math.PI;

            const distToSegment = Math.abs(dxt) * R_EARTH;

            return { lat: projLat, lng: projLng, t, distToSegment };
        }

        function distanceAlongRoute(points, lat, lng) {
            if (!points || points.length < 2) return null;

            let bestSegmentIdx = 0;
            let bestDist = Infinity;
            let bestProjection = null;

            for (let i = 0; i < points.length - 1; i++) {
                const [aLat, aLng] = points[i];
                const [bLat, bLng] = points[i + 1];
                const proj = projectPointOnSegment(lat, lng, aLat, aLng, bLat, bLng);
                if (proj.distToSegment < bestDist) {
                    bestDist = proj.distToSegment;
                    bestSegmentIdx = i;
                    bestProjection = proj;
                }
            }

            if (bestDist > 800) return null;

            let remaining = haversine(
                bestProjection.lat, bestProjection.lng,
                points[bestSegmentIdx + 1][0], points[bestSegmentIdx + 1][1]
            );
            for (let i = bestSegmentIdx + 1; i < points.length - 1; i++) {
                remaining += haversine(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
            }
            return remaining;
        }

        function estimateEtaMinutes(company, live) {
            const points = getActiveRoutePoints(company, live);
            if (!points || points.length === 0) return null;

            let distM = distanceAlongRoute(points, live.lat, live.lng);
            if (distM === null) {
                const dest = points[points.length - 1];
                distM = haversine(live.lat, live.lng, dest[0], dest[1]);
            }

            const speedKmh = (live.speed && live.speed > 3) ? live.speed : 18;
            const speedMs = speedKmh / 3.6;
            if (speedMs <= 0) return null;
            return Math.max(1, Math.round((distM / speedMs) / 60));
        }

        function estimateDistanceKm(company, live) {
            const points = getActiveRoutePoints(company, live);
            if (!points || points.length === 0) return null;

            let distM = distanceAlongRoute(points, live.lat, live.lng);
            if (distM === null) {
                const dest = points[points.length - 1];
                distM = haversine(live.lat, live.lng, dest[0], dest[1]);
            }
            return distM / 1000;
        }

        // ==================== CONFIANZA DEL ETA ====================
        function estimateEtaConfidence(live) {
            if (!live || !live.timestamp) return null;

            const secsAgo = (Date.now() - live.timestamp) / 1000;
            const acc = live.accuracy;
            const usingRealSpeed = !!(live.speed && live.speed > 3);

            let score = 0;
            if (secsAgo <= 15) score += 2;
            else if (secsAgo <= 40) score += 1;

            if (acc !== null && acc !== undefined) {
                if (acc < 20) score += 2;
                else if (acc < 100) score += 1;
            }

            if (usingRealSpeed) score += 1;

            if (score >= 4) return { level: 'high', label: 'Preciso', dot: '🟢' };
            if (score >= 2) return { level: 'medium', label: 'Aproximado', dot: '🟡' };
            return { level: 'low', label: 'Poco confiable', dot: '🔴' };
        }

        // ==================== EMPRESA REGISTRADA? ====================
        // Función auxiliar para verificar si una empresa está registrada
        function isCompanyRegistered(companyId) {
            const company = companies[companyId];
            return company && company.registered === true;
        }

        // Función para obtener el badge de estado de la empresa
        function getCompanyStatusBadge(companyId) {
            const company = companies[companyId];
            if (!company) return '';
            if (company.registered === true) {
                return '<span class="company-status-badge registered">✅ Activa</span>';
            }
            return '<span class="company-status-badge unregistered">📋 Ruta disponible</span>';
        }
        // ==================== CALIDAD GPS ====================
        function gpsQuality(accuracyMeters) {
            if (accuracyMeters === null || accuracyMeters === undefined) {
                return { level: 'unknown', label: 'Sin datos', dot: '⚪', cssClass: 'accuracy-unknown' };
            }
            if (accuracyMeters < 20) {
                return { level: 'good', label: 'GPS excelente', dot: '🟢', cssClass: 'accuracy-good' };
            }
            if (accuracyMeters < 100) {
                return { level: 'medium', label: 'Precisión media', dot: '🟡', cssClass: 'accuracy-medium' };
            }
            return { level: 'bad', label: 'Señal débil', dot: '🔴', cssClass: 'accuracy-bad' };
        }

        // ==================== EXPORTS GLOBALES ====================
        // Exponer funciones para que otros scripts las usen
        window.initMap = initMap;
        window.showRoute = showRoute;
        window.getRouteBoundsForCompany = getRouteBoundsForCompany;
        window.updateMapFromLiveData = updateMapFromLiveData;
        window.isOnline = isOnline;
        window.estimateEtaMinutes = estimateEtaMinutes;
        window.estimateDistanceKm = estimateDistanceKm;
        window.getActiveRoutePoints = getActiveRoutePoints;
        window.estimateEtaConfidence = estimateEtaConfidence;
        window.setWaitingTarget = setWaitingTarget;
        window.isCompanyRegistered = isCompanyRegistered;
        window.getCompanyStatusBadge = getCompanyStatusBadge;
        window.createVehicleIcon = createVehicleIcon; // compat Leaflet (driver.js), ver nota arriba
        window.createVehicleMarkerElement = createVehicleMarkerElement;
        window.updateVehicleMarkerElement = updateVehicleMarkerElement;
        window.animateMarkerTo = animateMarkerTo;
        window.removeVehicleMarker = removeVehicleMarker;
        window.vehicleKey = vehicleKey;
