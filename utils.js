// mapa/utils.js
// ============================================================================
// Utilidades matematicas genericas (no especificas de mapa), usadas por
// map.js y mock-data.js. Debe cargarse ANTES que map.js.
//
// Este archivo faltaba en la carpeta subida: map.js y mock-data.js llaman a
// haversine() y calculateBearing() en varios lugares (calculo de heading,
// ETA, distancia a lo largo de ruta) pero ninguna de las dos funciones
// estaba definida en ningun archivo del paquete, asi que cualquier tick de
// la simulacion (mock-data.js) o cualquier llamada a estimateEtaMinutes /
// estimateDistanceKm lanzaba "haversine is not defined" / "calculateBearing
// is not defined" y rompia el mapa (los vehiculos nunca se movian).
// ============================================================================

// Distancia entre dos coordenadas [lat, lng], en METROS, usando la formula
// de Haversine (asume la Tierra como esfera, suficiente para distancias
// urbanas cortas).
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000; // radio de la Tierra en metros
    const toRad = d => d * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// Rumbo inicial (bearing) desde (lat1,lng1) hacia (lat2,lng2), en grados
// 0-360 (0 = norte, 90 = este, etc). Usado para rotar el icono del vehiculo.
function calculateBearing(lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const dLng = toRad(lng2 - lng1);
    const lat1r = toRad(lat1);
    const lat2r = toRad(lat2);

    const y = Math.sin(dLng) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);

    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
