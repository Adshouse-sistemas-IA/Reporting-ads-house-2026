-- ════════════════════════════════════════════════════════════════
-- Reversión de la 109: políticas de public y report_utm ANTES de la 109
-- ════════════════════════════════════════════════════════════════
--
-- Volcado de pg_policies de producción tomado el 2026-10-31 (solo lectura).
-- 110 políticas. NO es una migración: no se aplica salvo para deshacer
-- la 109. Para volver a una política concreta, copiar su bloque (DROP + CREATE).
-- Revertir la 109 entera devuelve los fallos de seguridad S4, S5, S6, S9, S14
-- y S15 (ver la cabecera de la 109).
--
-- Las creadas por la 109 que no estaban antes (meta_conversiones_catalogo_*,
-- clientes_layouts_*, cliente_tabs_operar, system_settings_marca,
-- system_settings_admin_read) hay que borrarlas a mano.
-- ════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "ads_daily_delete" ON public.ads_daily;
CREATE POLICY "ads_daily_delete" ON public.ads_daily
    AS PERMISSIVE FOR DELETE TO public
    USING (( SELECT is_superadmin() AS is_superadmin));

DROP POLICY IF EXISTS "ads_daily_insert" ON public.ads_daily;
CREATE POLICY "ads_daily_insert" ON public.ads_daily
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (( SELECT is_superadmin() AS is_superadmin));

DROP POLICY IF EXISTS "ads_daily_select" ON public.ads_daily;
CREATE POLICY "ads_daily_select" ON public.ads_daily
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "ads_daily_update" ON public.ads_daily;
CREATE POLICY "ads_daily_update" ON public.ads_daily
    AS PERMISSIVE FOR UPDATE TO public
    USING (( SELECT is_superadmin() AS is_superadmin))
    WITH CHECK (( SELECT is_superadmin() AS is_superadmin));

DROP POLICY IF EXISTS "Admin full access tokens" ON public.api_tokens;
CREATE POLICY "Admin full access tokens" ON public.api_tokens
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Users manage own tokens" ON public.api_tokens;
CREATE POLICY "Users manage own tokens" ON public.api_tokens
    AS PERMISSIVE FOR ALL TO public
    USING ((( SELECT auth.uid() AS uid) = user_id));

DROP POLICY IF EXISTS "bi_reports_public_read" ON public.bi_reports;
CREATE POLICY "bi_reports_public_read" ON public.bi_reports
    AS PERMISSIVE FOR SELECT TO anon
    USING ((public_token IS NOT NULL));

DROP POLICY IF EXISTS "bi_reports_select" ON public.bi_reports;
CREATE POLICY "bi_reports_select" ON public.bi_reports
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "bitacoras_delete" ON public.bitacoras;
CREATE POLICY "bitacoras_delete" ON public.bitacoras
    AS PERMISSIVE FOR DELETE TO public
    USING (((author_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::user_role, 'superadmin'::user_role])))))));

DROP POLICY IF EXISTS "bitacoras_insert" ON public.bitacoras;
CREATE POLICY "bitacoras_insert" ON public.bitacoras
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::user_role, 'superadmin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "bitacoras_select" ON public.bitacoras;
CREATE POLICY "bitacoras_select" ON public.bitacoras
    AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role = ANY (ARRAY['admin'::user_role, 'superadmin'::user_role])) OR ((p.role = 'trafficker'::user_role) AND (bitacoras.visibilidad = ANY (ARRAY['trafficker'::text, 'publico'::text])) AND (EXISTS ( SELECT 1
           FROM user_client_assignments a
          WHERE ((a.user_id = ( SELECT auth.uid() AS uid)) AND (a.client_id = bitacoras.cliente_id))))))))));

DROP POLICY IF EXISTS "bitacoras_update" ON public.bitacoras;
CREATE POLICY "bitacoras_update" ON public.bitacoras
    AS PERMISSIVE FOR UPDATE TO public
    USING (((author_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::user_role, 'superadmin'::user_role])))))));

DROP POLICY IF EXISTS "Admins and Traffickers full access to tabs" ON public.cliente_tabs;
CREATE POLICY "Admins and Traffickers full access to tabs" ON public.cliente_tabs
    AS PERMISSIVE FOR ALL TO authenticated
    USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = ( SELECT auth.uid() AS uid)) AND (user_profiles.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "Admins and Traffickers full access" ON public.clientes;
CREATE POLICY "Admins and Traffickers full access" ON public.clientes
    AS PERMISSIVE FOR ALL TO authenticated
    USING (puede_ver_cliente(id))
    WITH CHECK (puede_ver_cliente(id));

DROP POLICY IF EXISTS "Authenticated full access to clientes_layouts" ON public.clientes_layouts;
CREATE POLICY "Authenticated full access to clientes_layouts" ON public.clientes_layouts
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "conversiones_offline_delete" ON public.conversiones_offline;
CREATE POLICY "conversiones_offline_delete" ON public.conversiones_offline
    AS PERMISSIVE FOR DELETE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "conversiones_offline_insert" ON public.conversiones_offline;
CREATE POLICY "conversiones_offline_insert" ON public.conversiones_offline
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "conversiones_offline_select" ON public.conversiones_offline;
CREATE POLICY "conversiones_offline_select" ON public.conversiones_offline
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "conversiones_offline_update" ON public.conversiones_offline;
CREATE POLICY "conversiones_offline_update" ON public.conversiones_offline
    AS PERMISSIVE FOR UPDATE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text))
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "conversiones_offline_diarias_delete" ON public.conversiones_offline_diarias;
CREATE POLICY "conversiones_offline_diarias_delete" ON public.conversiones_offline_diarias
    AS PERMISSIVE FOR DELETE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "conversiones_offline_diarias_insert" ON public.conversiones_offline_diarias;
CREATE POLICY "conversiones_offline_diarias_insert" ON public.conversiones_offline_diarias
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "conversiones_offline_diarias_select" ON public.conversiones_offline_diarias;
CREATE POLICY "conversiones_offline_diarias_select" ON public.conversiones_offline_diarias
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "conversiones_offline_diarias_update" ON public.conversiones_offline_diarias;
CREATE POLICY "conversiones_offline_diarias_update" ON public.conversiones_offline_diarias
    AS PERMISSIVE FOR UPDATE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text))
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Admin full access conversiones_offline_sync_log" ON public.conversiones_offline_sync_log;
CREATE POLICY "Admin full access conversiones_offline_sync_log" ON public.conversiones_offline_sync_log
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "fx_rates_read" ON public.fx_rates;
CREATE POLICY "fx_rates_read" ON public.fx_rates
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "Admin full access ga4_estado" ON public.ga4_estado;
CREATE POLICY "Admin full access ga4_estado" ON public.ga4_estado
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_estado" ON public.ga4_estado;
CREATE POLICY "Clients view own ga4_estado" ON public.ga4_estado
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios;
CREATE POLICY "Admin full access ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios;
CREATE POLICY "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access ga4_landing_diarios" ON public.ga4_landing_diarios;
CREATE POLICY "Admin full access ga4_landing_diarios" ON public.ga4_landing_diarios
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_landing_diarios" ON public.ga4_landing_diarios;
CREATE POLICY "Clients view own ga4_landing_diarios" ON public.ga4_landing_diarios
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access ga4_sesiones_diarias" ON public.ga4_sesiones_diarias;
CREATE POLICY "Admin full access ga4_sesiones_diarias" ON public.ga4_sesiones_diarias
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias;
CREATE POLICY "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access ga4_vistas_diarias" ON public.ga4_vistas_diarias;
CREATE POLICY "Admin full access ga4_vistas_diarias" ON public.ga4_vistas_diarias
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_vistas_diarias" ON public.ga4_vistas_diarias;
CREATE POLICY "Clients view own ga4_vistas_diarias" ON public.ga4_vistas_diarias
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access hotmart_ventas" ON public.hotmart_ventas;
CREATE POLICY "Admin full access hotmart_ventas" ON public.hotmart_ventas
    AS PERMISSIVE FOR ALL TO public
    USING (is_superadmin());

DROP POLICY IF EXISTS "Clients view own hotmart_ventas" ON public.hotmart_ventas;
CREATE POLICY "Clients view own hotmart_ventas" ON public.hotmart_ventas
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admins and Traffickers full access to layouts" ON public.layouts_reporte;
CREATE POLICY "Admins and Traffickers full access to layouts" ON public.layouts_reporte
    AS PERMISSIVE FOR ALL TO authenticated
    USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = ( SELECT auth.uid() AS uid)) AND (user_profiles.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "Admin full access leads_diarios" ON public.leads_diarios;
CREATE POLICY "Admin full access leads_diarios" ON public.leads_diarios
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Clients view own leads_diarios" ON public.leads_diarios;
CREATE POLICY "Clients view own leads_diarios" ON public.leads_diarios
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(client_id));

DROP POLICY IF EXISTS "Allow all" ON public.meta_conversiones_catalogo;
CREATE POLICY "Allow all" ON public.meta_conversiones_catalogo
    AS PERMISSIVE FOR ALL TO public
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Admin full access meta_data_streams" ON public.meta_data_streams;
CREATE POLICY "Admin full access meta_data_streams" ON public.meta_data_streams
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Users view own meta_data_streams" ON public.meta_data_streams;
CREATE POLICY "Users view own meta_data_streams" ON public.meta_data_streams
    AS PERMISSIVE FOR ALL TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "metricas_diarias_delete" ON public.metricas_diarias;
CREATE POLICY "metricas_diarias_delete" ON public.metricas_diarias
    AS PERMISSIVE FOR DELETE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "metricas_diarias_insert" ON public.metricas_diarias;
CREATE POLICY "metricas_diarias_insert" ON public.metricas_diarias
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "metricas_diarias_select" ON public.metricas_diarias;
CREATE POLICY "metricas_diarias_select" ON public.metricas_diarias
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "metricas_diarias_update" ON public.metricas_diarias;
CREATE POLICY "metricas_diarias_update" ON public.metricas_diarias
    AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles up
  WHERE ((up.id = ( SELECT auth.uid() AS uid)) AND (up.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role]))))));

DROP POLICY IF EXISTS "metricas_snapshots_read" ON public.metricas_snapshots;
CREATE POLICY "metricas_snapshots_read" ON public.metricas_snapshots
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "monthly_reports_delete" ON public.monthly_reports;
CREATE POLICY "monthly_reports_delete" ON public.monthly_reports
    AS PERMISSIVE FOR DELETE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "monthly_reports_insert" ON public.monthly_reports;
CREATE POLICY "monthly_reports_insert" ON public.monthly_reports
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "monthly_reports_select" ON public.monthly_reports;
CREATE POLICY "monthly_reports_select" ON public.monthly_reports
    AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text])) OR (((p.role)::text = 'trafficker'::text) AND (EXISTS ( SELECT 1
           FROM user_client_assignments a
          WHERE ((a.user_id = ( SELECT auth.uid() AS uid)) AND (a.client_id = monthly_reports.cliente_id))))))))));

DROP POLICY IF EXISTS "monthly_reports_update" ON public.monthly_reports;
CREATE POLICY "monthly_reports_update" ON public.monthly_reports
    AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "Users manage own notification prefs" ON public.notification_preferences;
CREATE POLICY "Users manage own notification prefs" ON public.notification_preferences
    AS PERMISSIVE FOR ALL TO public
    USING ((user_id = ( SELECT auth.uid() AS uid)))
    WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "Admin manage rule cooldowns" ON public.notification_rule_cooldowns;
CREATE POLICY "Admin manage rule cooldowns" ON public.notification_rule_cooldowns
    AS PERMISSIVE FOR ALL TO public
    USING (wa_is_admin())
    WITH CHECK (wa_is_admin());

DROP POLICY IF EXISTS "Admin manage notification_rules" ON public.notification_rules;
CREATE POLICY "Admin manage notification_rules" ON public.notification_rules
    AS PERMISSIVE FOR ALL TO public
    USING (wa_is_admin())
    WITH CHECK (wa_is_admin());

DROP POLICY IF EXISTS "Users mark own notifications read" ON public.notifications;
CREATE POLICY "Users mark own notifications read" ON public.notifications
    AS PERMISSIVE FOR UPDATE TO public
    USING ((user_id = ( SELECT auth.uid() AS uid)))
    WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "Users read own notifications" ON public.notifications;
CREATE POLICY "Users read own notifications" ON public.notifications
    AS PERMISSIVE FOR SELECT TO public
    USING ((user_id = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "periodos_cerrados_read" ON public.periodos_cerrados;
CREATE POLICY "periodos_cerrados_read" ON public.periodos_cerrados
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "report_templates_delete" ON public.report_templates;
CREATE POLICY "report_templates_delete" ON public.report_templates
    AS PERMISSIVE FOR DELETE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "report_templates_insert" ON public.report_templates;
CREATE POLICY "report_templates_insert" ON public.report_templates
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "report_templates_select" ON public.report_templates;
CREATE POLICY "report_templates_select" ON public.report_templates
    AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "report_templates_update" ON public.report_templates;
CREATE POLICY "report_templates_update" ON public.report_templates
    AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "reportes_mensuales_delete" ON public.reportes_mensuales;
CREATE POLICY "reportes_mensuales_delete" ON public.reportes_mensuales
    AS PERMISSIVE FOR DELETE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));

DROP POLICY IF EXISTS "reportes_mensuales_insert" ON public.reportes_mensuales;
CREATE POLICY "reportes_mensuales_insert" ON public.reportes_mensuales
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text, 'trafficker'::text]))))));

DROP POLICY IF EXISTS "reportes_mensuales_select" ON public.reportes_mensuales;
CREATE POLICY "reportes_mensuales_select" ON public.reportes_mensuales
    AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text])) OR (((p.role)::text = 'trafficker'::text) AND (EXISTS ( SELECT 1
           FROM user_client_assignments a
          WHERE ((a.user_id = ( SELECT auth.uid() AS uid)) AND (a.client_id = reportes_mensuales.cliente_id))))))))));

DROP POLICY IF EXISTS "reportes_mensuales_update" ON public.reportes_mensuales;
CREATE POLICY "reportes_mensuales_update" ON public.reportes_mensuales
    AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND ((p.role)::text = ANY (ARRAY['admin'::text, 'superadmin'::text, 'trafficker'::text]))))));

DROP POLICY IF EXISTS "Admin full access sheet_campo_valores" ON public.sheet_campo_valores;
CREATE POLICY "Admin full access sheet_campo_valores" ON public.sheet_campo_valores
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Clients view own sheet_campo_valores" ON public.sheet_campo_valores;
CREATE POLICY "Clients view own sheet_campo_valores" ON public.sheet_campo_valores
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "sheet_campo_valores_diarios_delete" ON public.sheet_campo_valores_diarios;
CREATE POLICY "sheet_campo_valores_diarios_delete" ON public.sheet_campo_valores_diarios
    AS PERMISSIVE FOR DELETE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "sheet_campo_valores_diarios_insert" ON public.sheet_campo_valores_diarios;
CREATE POLICY "sheet_campo_valores_diarios_insert" ON public.sheet_campo_valores_diarios
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "sheet_campo_valores_diarios_select" ON public.sheet_campo_valores_diarios;
CREATE POLICY "sheet_campo_valores_diarios_select" ON public.sheet_campo_valores_diarios
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "sheet_campo_valores_diarios_update" ON public.sheet_campo_valores_diarios;
CREATE POLICY "sheet_campo_valores_diarios_update" ON public.sheet_campo_valores_diarios
    AS PERMISSIVE FOR UPDATE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text))
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Admin full access sheet_campo_vistas" ON public.sheet_campo_vistas;
CREATE POLICY "Admin full access sheet_campo_vistas" ON public.sheet_campo_vistas
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Clients view own sheet_campo_vistas" ON public.sheet_campo_vistas;
CREATE POLICY "Clients view own sheet_campo_vistas" ON public.sheet_campo_vistas
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Admin full access sheet_campos" ON public.sheet_campos;
CREATE POLICY "Admin full access sheet_campos" ON public.sheet_campos
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Clients view own sheet_campos" ON public.sheet_campos;
CREATE POLICY "Clients view own sheet_campos" ON public.sheet_campos
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "sheet_filas_delete" ON public.sheet_filas;
CREATE POLICY "sheet_filas_delete" ON public.sheet_filas
    AS PERMISSIVE FOR DELETE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "sheet_filas_insert" ON public.sheet_filas;
CREATE POLICY "sheet_filas_insert" ON public.sheet_filas
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "sheet_filas_select" ON public.sheet_filas;
CREATE POLICY "sheet_filas_select" ON public.sheet_filas
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "sheet_filas_update" ON public.sheet_filas;
CREATE POLICY "sheet_filas_update" ON public.sheet_filas
    AS PERMISSIVE FOR UPDATE TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text))
    WITH CHECK (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Admin full access tickets" ON public.soporte_tickets;
CREATE POLICY "Admin full access tickets" ON public.soporte_tickets
    AS PERMISSIVE FOR ALL TO public
    USING (((( SELECT auth.jwt() AS jwt) ->> 'email'::text) = 'robinson@adshouse.com'::text));

DROP POLICY IF EXISTS "Clients can create their own tickets" ON public.soporte_tickets;
CREATE POLICY "Clients can create their own tickets" ON public.soporte_tickets
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients can view their own tickets" ON public.soporte_tickets;
CREATE POLICY "Clients can view their own tickets" ON public.soporte_tickets
    AS PERMISSIVE FOR SELECT TO public
    USING (puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "sync_jobs_read" ON public.sync_jobs;
CREATE POLICY "sync_jobs_read" ON public.sync_jobs
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "sync_runs_read" ON public.sync_runs;
CREATE POLICY "sync_runs_read" ON public.sync_runs
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "Allow public read of system settings" ON public.system_settings;
CREATE POLICY "Allow public read of system settings" ON public.system_settings
    AS PERMISSIVE FOR SELECT TO public
    USING (true);

DROP POLICY IF EXISTS "Superadmin manage system settings" ON public.system_settings;
CREATE POLICY "Superadmin manage system settings" ON public.system_settings
    AS PERMISSIVE FOR ALL TO public
    USING (( SELECT is_superadmin() AS is_superadmin))
    WITH CHECK (( SELECT is_superadmin() AS is_superadmin));

DROP POLICY IF EXISTS "superadmin_admin_manage_assignments" ON public.user_client_assignments;
CREATE POLICY "superadmin_admin_manage_assignments" ON public.user_client_assignments
    AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = ( SELECT auth.uid() AS uid)) AND (user_profiles.role = ANY (ARRAY['superadmin'::user_role, 'admin'::user_role]))))));

DROP POLICY IF EXISTS "users_read_own_assignments" ON public.user_client_assignments;
CREATE POLICY "users_read_own_assignments" ON public.user_client_assignments
    AS PERMISSIVE FOR SELECT TO public
    USING ((user_id = ( SELECT auth.uid() AS uid)));

DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.user_profiles;
CREATE POLICY "Authenticated users can view all profiles" ON public.user_profiles
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "Admin manage wa_groups" ON public.whatsapp_groups;
CREATE POLICY "Admin manage wa_groups" ON public.whatsapp_groups
    AS PERMISSIVE FOR ALL TO public
    USING (wa_is_admin())
    WITH CHECK (wa_is_admin());

DROP POLICY IF EXISTS "Admin read wa_messages" ON public.whatsapp_messages;
CREATE POLICY "Admin read wa_messages" ON public.whatsapp_messages
    AS PERMISSIVE FOR SELECT TO public
    USING (wa_is_admin());

DROP POLICY IF EXISTS "Admin manage wa_routes" ON public.whatsapp_routes;
CREATE POLICY "Admin manage wa_routes" ON public.whatsapp_routes
    AS PERMISSIVE FOR ALL TO public
    USING (wa_is_admin())
    WITH CHECK (wa_is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_clientes" ON report_utm.clientes;
CREATE POLICY "Admin manage rutm_clientes" ON report_utm.clientes
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_clientes" ON report_utm.clientes;
CREATE POLICY "Viewers read rutm_clientes" ON report_utm.clientes
    AS PERMISSIVE FOR SELECT TO public
    USING (report_utm.can_view());

DROP POLICY IF EXISTS "Admin manage rutm_hourly" ON report_utm.hourly_metrics;
CREATE POLICY "Admin manage rutm_hourly" ON report_utm.hourly_metrics
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_integrations" ON report_utm.integrations;
CREATE POLICY "Admin manage rutm_integrations" ON report_utm.integrations
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_lead_segmentos" ON report_utm.lead_campo_segmentos;
CREATE POLICY "Admin manage rutm_lead_segmentos" ON report_utm.lead_campo_segmentos
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_segmentos" ON report_utm.lead_campo_segmentos;
CREATE POLICY "Viewers read rutm_lead_segmentos" ON report_utm.lead_campo_segmentos
    AS PERMISSIVE FOR SELECT TO public
    USING (report_utm.can_view());

DROP POLICY IF EXISTS "Admin manage rutm_lead_campos" ON report_utm.lead_campos;
CREATE POLICY "Admin manage rutm_lead_campos" ON report_utm.lead_campos
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_campos" ON report_utm.lead_campos;
CREATE POLICY "Viewers read rutm_lead_campos" ON report_utm.lead_campos
    AS PERMISSIVE FOR SELECT TO public
    USING (report_utm.can_view());

DROP POLICY IF EXISTS "Admin manage rutm_leads" ON report_utm.lead_events;
CREATE POLICY "Admin manage rutm_leads" ON report_utm.lead_events
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_leads" ON report_utm.lead_events;
CREATE POLICY "Viewers read rutm_leads" ON report_utm.lead_events
    AS PERMISSIVE FOR SELECT TO public
    USING (report_utm.can_view());

DROP POLICY IF EXISTS "Admin manage rutm_lead_preguntas" ON report_utm.lead_preguntas;
CREATE POLICY "Admin manage rutm_lead_preguntas" ON report_utm.lead_preguntas
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_preguntas" ON report_utm.lead_preguntas;
CREATE POLICY "Viewers read rutm_lead_preguntas" ON report_utm.lead_preguntas
    AS PERMISSIVE FOR SELECT TO public
    USING (report_utm.can_view());

DROP POLICY IF EXISTS "Admin manage rutm_deliveries" ON report_utm.outbound_deliveries;
CREATE POLICY "Admin manage rutm_deliveries" ON report_utm.outbound_deliveries
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_outbound" ON report_utm.outbound_webhooks;
CREATE POLICY "Admin manage rutm_outbound" ON report_utm.outbound_webhooks
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_pixel" ON report_utm.pixel_events;
CREATE POLICY "Admin manage rutm_pixel" ON report_utm.pixel_events
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_sales" ON report_utm.sales_events;
CREATE POLICY "Admin manage rutm_sales" ON report_utm.sales_events
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Admin manage rutm_links" ON report_utm.tracking_links;
CREATE POLICY "Admin manage rutm_links" ON report_utm.tracking_links
    AS PERMISSIVE FOR ALL TO public
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());
