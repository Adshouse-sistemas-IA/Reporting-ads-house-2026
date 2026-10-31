-- ════════════════════════════════════════════════════════════════
-- 108 · Ninguna función ni tabla al alcance de la clave pública
-- ════════════════════════════════════════════════════════════════
--
-- La clave `anon` va en el navegador: la tiene cualquiera que abra el login.
-- Comprobado en producción el 2026-10-31:
--
--   · Las 55 funciones de `public` y `report_utm` eran ejecutables por `anon`.
--     Entre ellas, `SECURITY DEFINER` (se saltan el RLS):
--       - ga4_reemplazar_rango / ga4_reemplazar_paginas: borran y reescriben
--         el GA4 de CUALQUIER cliente con un POST a /rest/v1/rpc/…;
--       - ga4_*_resumen: leen el GA4 de cualquier cliente;
--       - claim_agent_turn: entrega los mensajes pendientes del agente.
--   · `anon` tenía SELECT (y escritura) sobre 68 de las 81 tablas. Hoy el RLS
--     lo frena en casi todas, pero varias políticas son `TO public` o
--     `USING (true)` (las arregla la 109): con privilegios sobre la tabla, un
--     fallo de política es una fuga directa.
--
-- La app nunca usa `anon` para datos: el navegador solo lee la marca
-- (`system_settings`, clave `branding`, en el login) y sube imágenes a
-- Storage; las páginas públicas (/p, /report) leen con la service role. Las
-- RPC de GA4 y del agente las llama solo el servidor con la service role.
--
-- Qué hace:
--   1. Quita EXECUTE a PUBLIC y `anon` en todas las funciones de los dos
--      esquemas. Antes, a quien ya podía (authenticated / service_role) se le
--      concede de forma explícita, para no depender de PUBLIC.
--   2. Las RPC DEFINER de GA4 y `claim_agent_turn`: solo service_role.
--   3. `anon` se queda sin privilegios de tabla salvo SELECT en
--      `system_settings` (la 109 la limita a la marca). TRUNCATE, REFERENCES y
--      TRIGGER fuera para `anon` y `authenticated`: TRUNCATE no pasa por RLS.
--   4. Lo mismo para lo que se cree en adelante (privilegios por defecto).
--
-- Los disparadores no comprueban EXECUTE: siguen funcionando.
--
-- Aplicar DESPUÉS de la 109 o justo antes, en la misma ventana: con
-- políticas `TO public` que llaman a is_superadmin() / puede_ver_cliente(),
-- una consulta de `anon` a esas tablas daría «permission denied for
-- function» en vez de 0 filas (la 109 las pasa a `TO authenticated`). La app
-- no hace esas consultas como `anon`, así que el orden no rompe nada visible.
--
-- Idempotente.
--
-- Revertir (vuelve al estado inseguro anterior):
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, report_utm TO anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, report_utm TO anon;
--   y deshacer los ALTER DEFAULT PRIVILEGES del final.
--
--   npx tsx scripts/sql-remoto.ts migrations/108_funciones_y_privilegios_sin_anon.sql
-- ════════════════════════════════════════════════════════════════

-- ── 1. Funciones: fuera PUBLIC y anon ────────────────────────────
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS f,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS srv
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'report_utm')
           AND p.prokind IN ('f', 'p')
           -- Las de extensiones (pg_trgm…) no son nuestras.
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
        IF r.auth THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.f);
        END IF;
        IF r.srv THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.f);
        END IF;
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.f);
    END LOOP;
END $$;

-- ── 2. RPC que solo llama el servidor ────────────────────────────
DO $$
DECLARE
    f regprocedure;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('ga4_reemplazar_rango', 'ga4_reemplazar_paginas',
                             'ga4_sesiones_resumen', 'ga4_eventos_resumen',
                             'ga4_landing_resumen', 'ga4_vistas_resumen',
                             'claim_agent_turn')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END LOOP;
END $$;

-- ── 3. Tablas ────────────────────────────────────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA report_utm FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA report_utm FROM anon;
GRANT SELECT ON public.system_settings TO anon;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA report_utm FROM authenticated;

-- ── 4. Lo que se cree en adelante ────────────────────────────────
-- Para el rol que crea los objetos en las migraciones (postgres). Postgres da
-- además EXECUTE a PUBLIC en toda función nueva y eso no se puede quitar por
-- esquema: una migración que cree una función debe terminar con
-- `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon` (y conceder lo que haga
-- falta), como hace la 106.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA report_utm REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA report_utm REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA report_utm REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA report_utm REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;

NOTIFY pgrst, 'reload schema';
