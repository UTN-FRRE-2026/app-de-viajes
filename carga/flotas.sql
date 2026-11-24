-- Datos de carga para el filtro de flotas y zonas (PR 2 de flotas, docs/flotas.md). SOLO para la base
-- dispatch_carga del proyecto viajes-carga: lo aplican carrera.ps1 y medir.ps1 -Solicitudes, después de
-- limpiar.ps1. Por SQL y no por la API porque carga no tiene identity (el alta pregunta si la cuenta es
-- de chofer); el usuario de esta base es superusuario, así que la migración ya creó PostGIS.
--
-- Deja aptos (habilitados, activos y disponibles, en una flota con la zona) a los 500 choferes de k6
-- (tokens.json) y al chofer de carga/solicitudes.js: así el filtro corre en la medición, igual que en
-- producción, sin descartar a nadie. Idempotente.
BEGIN;

INSERT INTO fleets (id, name, max_active, active_count)
VALUES ('00000000-0000-4000-8000-0000000ca59a', 'Flota de carga', 1000, 501)
ON CONFLICT (id) DO NOTHING;

-- La nube de los 500 choferes de k6 (Buenos Aires) y el origen de solicitudes.js y carrera.js (Córdoba).
-- No se superponen.
INSERT INTO zones (id, name, area) VALUES
  ('00000000-0000-4000-8000-0000000ca5b1', 'Carga Buenos Aires', ST_MakeEnvelope(-58.60, -34.80, -58.20, -34.40, 4326)),
  ('00000000-0000-4000-8000-0000000ca5c0', 'Carga Córdoba', ST_MakeEnvelope(-64.40, -31.60, -64.00, -31.20, 4326))
ON CONFLICT (id) DO NOTHING;

INSERT INTO fleet_zones (fleet_id, zone_id) VALUES
  ('00000000-0000-4000-8000-0000000ca59a', '00000000-0000-4000-8000-0000000ca5b1'),
  ('00000000-0000-4000-8000-0000000ca59a', '00000000-0000-4000-8000-0000000ca5c0')
ON CONFLICT DO NOTHING;

-- Los mismos ids que firma carga/preparar.mjs: 00000000-0000-4000-8000-c0000000XXXX (hex, 1 a 500).
INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available)
SELECT ('00000000-0000-4000-8000-c0000000' || lpad(to_hex(i), 4, '0'))::uuid,
       '00000000-0000-4000-8000-0000000ca59a',
       'CG' || lpad(i::text, 3, '0') || 'AA', 'Carga', 'k6', true, true, true
FROM generate_series(1, 500) AS i
ON CONFLICT DO NOTHING;

-- El chofer de carga/solicitudes.js.
INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available)
VALUES ('00000000-0000-4000-8000-b00000000001', '00000000-0000-4000-8000-0000000ca59a', 'CB001AA', 'Carga', 'flujo', true, true, true)
ON CONFLICT DO NOTHING;

COMMIT;
