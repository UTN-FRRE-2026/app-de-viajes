-- Datos de carga para el filtro de flotas y zonas (PR 2 de flotas, docs/flotas.md). SOLO para la base
-- dispatch_carga del proyecto viajes-carga: lo aplican carrera.ps1 y medir.ps1 -Solicitudes, después de
-- limpiar.ps1. Por SQL y no por la API porque carga no tiene identity (el alta pregunta si la cuenta es
-- de chofer); el usuario de esta base es superusuario, así que la migración ya creó PostGIS.
--
-- Deja aptos (habilitados, activos y disponibles, en una flota con la zona) a los 500 choferes de k6
-- (tokens.json) y a los 300 choferes de prueba de los viajes (tokens-viajes.json, b0000000 0001-012c),
-- y suma 10 choferes de prueba NO aptos (012d-0136): 4 inactivos, 3 no disponibles y 3 de una flota
-- que no opera en Córdoba. Así el filtro corre en la medición igual que en producción, y los no aptos
-- comprueban que nunca reciben ofertas. Idempotente.
BEGIN;

-- Activos: 500 de k6, 300 aptos de prueba y los 3 no disponibles (activos, pero sin tomar viajes).
INSERT INTO fleets (id, name, max_active, active_count) VALUES
  ('00000000-0000-4000-8000-0000000ca59a', 'Flota de carga', 1000, 803),
  ('00000000-0000-4000-8000-0000000ca59b', 'Flota de carga sin Córdoba', 10, 3)
ON CONFLICT (id) DO NOTHING;

-- La nube de los 500 choferes de k6 (Buenos Aires) y el origen de solicitudes.js y carrera.js (Córdoba).
-- No se superponen.
INSERT INTO zones (id, name, area) VALUES
  ('00000000-0000-4000-8000-0000000ca5b1', 'Carga Buenos Aires', ST_MakeEnvelope(-58.60, -34.80, -58.20, -34.40, 4326)),
  ('00000000-0000-4000-8000-0000000ca5c0', 'Carga Córdoba', ST_MakeEnvelope(-64.40, -31.60, -64.00, -31.20, 4326))
ON CONFLICT (id) DO NOTHING;

INSERT INTO fleet_zones (fleet_id, zone_id) VALUES
  ('00000000-0000-4000-8000-0000000ca59a', '00000000-0000-4000-8000-0000000ca5b1'),
  ('00000000-0000-4000-8000-0000000ca59a', '00000000-0000-4000-8000-0000000ca5c0'),
  ('00000000-0000-4000-8000-0000000ca59b', '00000000-0000-4000-8000-0000000ca5b1')
ON CONFLICT DO NOTHING;

-- Los mismos ids que firma carga/preparar.mjs: 00000000-0000-4000-8000-c0000000XXXX (hex, 1 a 500).
INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available)
SELECT ('00000000-0000-4000-8000-c0000000' || lpad(to_hex(i), 4, '0'))::uuid,
       '00000000-0000-4000-8000-0000000ca59a',
       'CG' || lpad(i::text, 3, '0') || 'AA', 'Carga', 'k6', true, true, true
FROM generate_series(1, 500) AS i
ON CONFLICT DO NOTHING;

-- Los choferes de prueba de los viajes (tokens-viajes.json): b0000000XXXX, hex. El 1 es también el chofer
-- de tokens-solicitudes.json. 1-300 aptos; 301-304 inactivos; 305-307 activos pero no disponibles;
-- 308-310 aptos en todo, pero de la flota que no opera en Córdoba.
INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available)
SELECT ('00000000-0000-4000-8000-b0000000' || lpad(to_hex(i), 4, '0'))::uuid,
       CASE WHEN i >= 308 THEN '00000000-0000-4000-8000-0000000ca59b'::uuid ELSE '00000000-0000-4000-8000-0000000ca59a'::uuid END,
       'CB' || lpad(i::text, 3, '0') || 'AA', 'Carga', 'viajes',
       true, i <= 300 OR i >= 305, i <= 300 OR i >= 308
FROM generate_series(1, 310) AS i
ON CONFLICT DO NOTHING;

COMMIT;
