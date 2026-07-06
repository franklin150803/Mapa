// mapa/mock-data.js
// Datos de prueba SOLO para mapa/index.html (el harness standalone del mapa).
// No se usa en la app principal. Sirve para poder abrir mapa/index.html
// directo en el navegador y ver/depurar el mapa sin arrancar Firebase,
// login, ni el resto de la app.

const MOCK_COMPANIES = {
    "ruta_demo_301": {
        name: "Autobús 301 (demo)",
        route: "24 de Junio → Plaza Butters",
        color: "#22D3EE",
        registered: true,
        routePointsIda: [
            [-12.0230, -77.1180],
            [-12.0340, -77.0980],
            [-12.0464, -77.0428],
            [-12.0700, -77.0350],
            [-12.1200, -77.0250],
            [-12.1480, -77.0200]
        ],
        routePointsRetorno: [
            [-12.1480, -77.0200],
            [-12.1200, -77.0250],
            [-12.0700, -77.0350],
            [-12.0464, -77.0428],
            [-12.0340, -77.0980],
            [-12.0230, -77.1180]
        ],
        vehicles: {
            "v1": { plate: "ABC-123" },
            "v2": { plate: "XYZ-789" }
        }
    },
    "ruta_demo_no_registrada": {
        name: "Ruta sin registrar (demo)",
        route: "Ejemplo de ruta disponible pero no activa",
        color: "#94a3b8",
        registered: false,
        routePointsIda: [
            [-12.0000, -77.0500],
            [-12.0300, -77.0400],
            [-12.0600, -77.0300]
        ],
        routePointsRetorno: [],
        vehicles: {}
    }
};

// Mueve cada vehiculo a lo largo de su routePointsIda en loop, escribiendo en
// `liveVehicles` (variable global que mapa/map.js espera encontrar) y
// llamando a updateMapFromLiveData() cada tick, tal como lo haria Firebase
// en la app real (ver window.fbOnValue en index.html).
function startMockSimulation() {
    const progress = {}; // vehicleKey -> indice fraccional a lo largo de la ruta

    setInterval(() => {
        if (window.mockSimPaused) return;
        Object.keys(MOCK_COMPANIES).forEach(companyId => {
            const company = MOCK_COMPANIES[companyId];
            if (!company.registered) return; // igual que en la app real

            Object.keys(company.vehicles).forEach(vehicleId => {
                const key = companyId + '__' + vehicleId;
                const points = company.routePointsIda;
                if (!points || points.length < 2) return;

                let p = progress[key] || Math.random() * (points.length - 1);
                p += 0.04 + Math.random() * 0.03;
                if (p >= points.length - 1) p = 0;
                progress[key] = p;

                const i = Math.floor(p);
                const t = p - i;
                const a = points[i];
                const b = points[Math.min(i + 1, points.length - 1)];
                const lat = a[0] + (b[0] - a[0]) * t;
                const lng = a[1] + (b[1] - a[1]) * t;

                if (!liveVehicles[companyId]) liveVehicles[companyId] = {};
                liveVehicles[companyId][vehicleId] = {
                    lat, lng,
                    speed: 15 + Math.random() * 10,
                    heading: calculateBearing(a[0], a[1], b[0], b[1]),
                    accuracy: 10 + Math.random() * 20,
                    sentido: 'ida',
                    timestamp: Date.now()
                };
            });
        });

        window.updateMapFromLiveData();
    }, 1500);
}
