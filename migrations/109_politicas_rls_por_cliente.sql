-- ════════════════════════════════════════════════════════════════
-- 109 · RLS: por cliente, sin correos fijos y calculado una vez por consulta
-- ════════════════════════════════════════════════════════════════
--
-- Estado en producción el 2026-10-31 (113 políticas) y qué cambia:
--
--   · S4 · 20 políticas con `auth.jwt() ->> 'email' = 'robinson@adshouse.com'`
--     (acceso total por un correo escrito en el SQL). Pasan a
--     `(SELECT is_superadmin())`. Ese usuario es superadmin: no pierde nada.
--   · S5 · `meta_conversiones_catalogo` «Allow all» `USING (true)` TO public:
--     la clave pública leía y escribía el catálogo de todos los clientes. Pasa
--     a lectura por cliente; escribe el servidor (upsert_meta_conversiones,
--     service role) o un superadmin.
--   · S6 · `bi_reports_public_read TO anon USING (public_token IS NOT NULL)`:
--     con la clave pública se listaban los informes compartidos CON su token.
--     Se borra: /report/bi/[token] lee con la service role.
--   · S14 · `USING (true)` para authenticated en `bi_reports`,
--     `clientes_layouts` (¡ALL!), `sync_jobs`, `sync_runs` (con `logs`:
--     respuestas crudas de las APIs), `metricas_snapshots` y
--     `periodos_cerrados`. Pasan a los clientes que el usuario puede ver.
--   · S9 · `report_utm.can_view()`: cualquier trafficker leía los leads de
--     TODOS los clientes. Pasa a los clientes que puede operar (admin y
--     superadmin: todos; trafficker: los asignados; viewer: ninguno, como
--     antes).
--   · S15 · `system_settings` legible entero por `anon`: con la clave pública
--     solo la marca (lo único que lee el login).
--   · `cliente_tabs`: admin y trafficker editaban las pestañas de cualquier
--     cliente. Ahora, de los que pueden ver.
--   · Todas las demás políticas `TO public` pasan a `TO authenticated`: la app
--     no usa `anon` para datos (ver 108).
--
-- Rendimiento (medido con la sesión de un superadmin el 2026-10-30):
-- una política que llama a una función con la columna de la fila
-- (`puede_ver_cliente(cliente_id)`) o a una función SECURITY DEFINER sin
-- envolver (`is_superadmin()`) se evalúa FILA A FILA. Contar los 93.000 leads
-- de un cliente con la sesión del usuario: 57,9 s con la política fila a fila,
-- 131 ms comparando contra un array que se calcula UNA vez por consulta:
--   (cliente_id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE
-- `(SELECT …)` sin columnas de la fila es un InitPlan; el `::uuid[]` hace que
-- `= ANY` lo tome como array. El `IS TRUE` no cambia el resultado pero impide
-- que el planificador use la condición como condición de índice (sin él
-- elegía el índice de UTM y saltaba a la tabla fila a fila: 4,9–10,9 s).
-- Las políticas que eran exactamente `is_superadmin()`, `wa_is_admin()` o
-- `report_utm.is_admin()` se envuelven en `(SELECT …)` por lo mismo.
--
-- No cambia nada para la service role (se salta el RLS), que es como lee y
-- escribe casi toda la app.
--
-- Idempotente: cada bloque busca el estado anterior y no hace nada si ya no
-- está. Probada con scripts/verify-migraciones-rendimiento-seguridad.ts.
--
-- Revertir: docs/revertir/109_politicas_previas.sql tiene las 110 políticas
-- de producción tal como estaban el 2026-10-31 (DROP + CREATE por política).
--
--   npx tsx scripts/sql-remoto.ts migrations/109_politicas_rls_por_cliente.sql
-- ════════════════════════════════════════════════════════════════

-- ── Ayudantes: los clientes del usuario, una vez por consulta ────
-- `es_operador()`: trafficker o superior. Las otras dos devuelven ids de
-- report_utm.clientes. Todas SECURITY DEFINER para leer perfiles y
-- asignaciones sin depender del RLS de esas tablas; solo devuelven ids de
-- clientes que el propio usuario ya puede ver.
CREATE OR REPLACE FUNCTION public.es_operador()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = ''
AS $$
    SELECT EXISTS (SELECT 1 FROM public.user_profiles p
                    WHERE p.id = (SELECT auth.uid())
                      AND p.role::text IN ('superadmin', 'admin', 'trafficker'))
$$;

CREATE OR REPLACE FUNCTION report_utm.clientes_visibles()
    RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = ''
AS $$
    SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[])
      FROM report_utm.clientes c
     WHERE c.public_cliente_id IS NOT NULL
       AND public.puede_ver_cliente(c.public_cliente_id)
$$;

CREATE OR REPLACE FUNCTION report_utm.clientes_operables()
    RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = ''
AS $$
    SELECT CASE
             WHEN public.es_operador() THEN report_utm.clientes_visibles()
             ELSE ARRAY[]::uuid[]
           END
$$;

COMMENT ON FUNCTION public.es_operador() IS
    'Rol trafficker o superior. DEFINER: no depende del RLS de user_profiles. En políticas, envuelto en (SELECT …) para calcularse una vez por consulta.';
COMMENT ON FUNCTION report_utm.clientes_visibles() IS
    'Ids de report_utm.clientes cuyo cliente público ve el usuario (puede_ver_cliente). Para políticas: (SELECT report_utm.clientes_visibles()) se calcula una vez por consulta.';
COMMENT ON FUNCTION report_utm.clientes_operables() IS
    'Como clientes_visibles(), pero solo para trafficker o superior: los leads no los ve un viewer.';

REVOKE ALL ON FUNCTION public.es_operador() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION report_utm.clientes_visibles() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION report_utm.clientes_operables() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_operador() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.clientes_visibles() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.clientes_operables() TO authenticated, service_role;

-- ── S4 · Correo fijo → superadmin ────────────────────────────────
DO $$
DECLARE
    p record;
BEGIN
    FOR p IN
        SELECT schemaname, tablename, policyname, cmd
          FROM pg_policies
         WHERE schemaname IN ('public', 'report_utm')
           AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%robinson@adshouse.com%'
    LOOP
        IF p.cmd IN ('SELECT', 'DELETE') THEN
            EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated USING ((SELECT public.is_superadmin()))',
                           p.policyname, p.schemaname, p.tablename);
        ELSIF p.cmd = 'INSERT' THEN
            EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated WITH CHECK ((SELECT public.is_superadmin()))',
                           p.policyname, p.schemaname, p.tablename);
        ELSE
            EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()))',
                           p.policyname, p.schemaname, p.tablename);
        END IF;
    END LOOP;
END $$;

-- ── S5 · meta_conversiones_catalogo ──────────────────────────────
DROP POLICY IF EXISTS "Allow all" ON public.meta_conversiones_catalogo;
DROP POLICY IF EXISTS meta_conversiones_catalogo_select ON public.meta_conversiones_catalogo;
DROP POLICY IF EXISTS meta_conversiones_catalogo_superadmin ON public.meta_conversiones_catalogo;
CREATE POLICY meta_conversiones_catalogo_select ON public.meta_conversiones_catalogo
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));
CREATE POLICY meta_conversiones_catalogo_superadmin ON public.meta_conversiones_catalogo
    FOR ALL TO authenticated
    USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));

-- ── S6 / S14 · bi_reports ────────────────────────────────────────
-- cliente_id → report_utm.clientes; NULL = plantilla del sistema.
DROP POLICY IF EXISTS bi_reports_public_read ON public.bi_reports;
DROP POLICY IF EXISTS bi_reports_select ON public.bi_reports;
CREATE POLICY bi_reports_select ON public.bi_reports
    FOR SELECT TO authenticated
    USING (cliente_id IS NULL
           OR (cliente_id = ANY ((SELECT report_utm.clientes_visibles())::uuid[])) IS TRUE);

-- ── S14 · clientes_layouts ───────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated full access to clientes_layouts" ON public.clientes_layouts;
DROP POLICY IF EXISTS clientes_layouts_select ON public.clientes_layouts;
DROP POLICY IF EXISTS clientes_layouts_operar ON public.clientes_layouts;
CREATE POLICY clientes_layouts_select ON public.clientes_layouts
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));
CREATE POLICY clientes_layouts_operar ON public.clientes_layouts
    FOR ALL TO authenticated
    USING (public.puede_ver_cliente(cliente_id)
           AND (SELECT public.es_operador()))
    WITH CHECK (public.puede_ver_cliente(cliente_id)
           AND (SELECT public.es_operador()));

-- ── S14 · cola, snapshots y periodos ─────────────────────────────
DROP POLICY IF EXISTS sync_jobs_read ON public.sync_jobs;
CREATE POLICY sync_jobs_read ON public.sync_jobs
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS sync_runs_read ON public.sync_runs;
CREATE POLICY sync_runs_read ON public.sync_runs
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS metricas_snapshots_read ON public.metricas_snapshots;
CREATE POLICY metricas_snapshots_read ON public.metricas_snapshots
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS periodos_cerrados_read ON public.periodos_cerrados;
CREATE POLICY periodos_cerrados_read ON public.periodos_cerrados
    FOR SELECT TO authenticated USING (public.puede_ver_cliente(cliente_id));

-- ── cliente_tabs: solo de los clientes que se ven ────────────────
DROP POLICY IF EXISTS "Admins and Traffickers full access to tabs" ON public.cliente_tabs;
DROP POLICY IF EXISTS cliente_tabs_operar ON public.cliente_tabs;
CREATE POLICY cliente_tabs_operar ON public.cliente_tabs
    FOR ALL TO authenticated
    USING (public.puede_ver_cliente(cliente_id)
           AND (SELECT public.es_operador()))
    WITH CHECK (public.puede_ver_cliente(cliente_id)
           AND (SELECT public.es_operador()));

-- ── S15 · system_settings ────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public read of system settings" ON public.system_settings;
DROP POLICY IF EXISTS system_settings_marca ON public.system_settings;
DROP POLICY IF EXISTS system_settings_admin_read ON public.system_settings;
CREATE POLICY system_settings_marca ON public.system_settings
    FOR SELECT TO anon, authenticated USING (key = 'branding');
CREATE POLICY system_settings_admin_read ON public.system_settings
    FOR SELECT TO authenticated USING ((SELECT public.wa_is_admin()));

-- ── S9 · report_utm: por cliente operable, una vez por consulta ──
DROP POLICY IF EXISTS "Viewers read rutm_leads" ON report_utm.lead_events;
CREATE POLICY "Viewers read rutm_leads" ON report_utm.lead_events
    FOR SELECT TO authenticated
    USING ((cliente_id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE);

DROP POLICY IF EXISTS "Viewers read rutm_lead_campos" ON report_utm.lead_campos;
CREATE POLICY "Viewers read rutm_lead_campos" ON report_utm.lead_campos
    FOR SELECT TO authenticated
    USING ((cliente_id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE);

DROP POLICY IF EXISTS "Viewers read rutm_lead_segmentos" ON report_utm.lead_campo_segmentos;
CREATE POLICY "Viewers read rutm_lead_segmentos" ON report_utm.lead_campo_segmentos
    FOR SELECT TO authenticated
    USING ((cliente_id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE);

DROP POLICY IF EXISTS "Viewers read rutm_lead_preguntas" ON report_utm.lead_preguntas;
CREATE POLICY "Viewers read rutm_lead_preguntas" ON report_utm.lead_preguntas
    FOR SELECT TO authenticated
    USING ((cliente_id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE);

DROP POLICY IF EXISTS "Viewers read rutm_clientes" ON report_utm.clientes;
CREATE POLICY "Viewers read rutm_clientes" ON report_utm.clientes
    FOR SELECT TO authenticated
    USING ((id = ANY ((SELECT report_utm.clientes_operables())::uuid[])) IS TRUE);

-- ── Funciones de rol sin envolver → una vez por consulta ─────────
DO $$
DECLARE
    p record;
    expr text;
BEGIN
    FOR p IN
        SELECT schemaname, tablename, policyname, cmd, qual, with_check
          FROM pg_policies
         WHERE schemaname IN ('public', 'report_utm')
           AND (qual IN ('is_superadmin()', 'wa_is_admin()', 'report_utm.is_admin()')
                OR with_check IN ('is_superadmin()', 'wa_is_admin()', 'report_utm.is_admin()'))
    LOOP
        expr := CASE COALESCE(p.qual, p.with_check)
                    WHEN 'is_superadmin()' THEN '(SELECT public.is_superadmin())'
                    WHEN 'wa_is_admin()' THEN '(SELECT public.wa_is_admin())'
                    ELSE '(SELECT report_utm.is_admin())'
                END;
        IF p.cmd IN ('SELECT', 'DELETE') THEN
            EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)',
                           p.policyname, p.schemaname, p.tablename, expr);
        ELSIF p.cmd = 'INSERT' THEN
            EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
                           p.policyname, p.schemaname, p.tablename, expr);
        ELSE
            EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
                           p.policyname, p.schemaname, p.tablename, expr, expr);
        END IF;
    END LOOP;
END $$;

-- ── El resto de políticas TO public → TO authenticated ───────────
DO $$
DECLARE
    p record;
BEGIN
    FOR p IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE schemaname IN ('public', 'report_utm')
           AND roles = '{public}'
    LOOP
        EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated',
                       p.policyname, p.schemaname, p.tablename);
    END LOOP;
END $$;
