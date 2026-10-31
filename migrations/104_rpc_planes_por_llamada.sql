-- ════════════════════════════════════════════════════════════════
-- 104 · RPC de lectura: un plan por llamada y atribución de Hotmart indexada
-- ════════════════════════════════════════════════════════════════
--
-- ── Planes genéricos ─────────────────────────────────────────────
-- plpgsql cachea el plan del `RETURN QUERY`: las cinco primeras llamadas de
-- cada conexión se planifican con los valores reales y desde la sexta usa un
-- plan genérico, sin valores. El pool de PostgREST mantiene las conexiones
-- abiertas, así que casi todas las llamadas son «la sexta o posterior».
-- Medido con auto_explain, la misma `ads_daily_resumen(…, 'adset', 365 días)`:
--   · llamadas 1.ª a 5.ª:                            436–475 ms (hash joins)
--   · 6.ª y 7.ª:                                 5.789–6.856 ms (nested loops)
--   · todas con plan_cache_mode = force_custom_plan:  436–453 ms
-- El coste es planificar en cada llamada (~0,3–0,4 ms).
--
-- Una función `LANGUAGE sql` con `SET search_path` no se integra en la
-- consulta que la llama y siempre se planifica con parámetros sin valor. Por
-- eso `ads_entidades_ids` y la atribución de Hotmart pasan a plpgsql: así se
-- les puede fijar el mismo ajuste.
--
--   · ads_entidades_ids: con el plan genérico ordenaba en disco las ~167.000
--     filas del rango (16 MB de temporales por llamada). Con la 105 recorre
--     idx_ads_daily_entidades en orden y sin Sort: 533 ms → 45 ms.
--   · hotmart_leads_para_atribucion(_v2): el `OR` entre email y teléfono
--     impedía usar los índices de expresión de la 093
--     (idx_lead_events_email_norm / _telefono_norm) y se leían todos los
--     leads del rango. Ahora son dos ramas (`unnest` ⨝ índice) unidas con
--     UNION: 300 compradores 1.267 ms → 223 ms; 3 compradores (un webhook)
--     562 ms → 0,4 ms. Mismo resultado fila a fila: `excluido` es NOT NULL,
--     así que `NOT excluido` = `NOT COALESCE(excluido, false)`, y un email o
--     teléfono NULL nunca casaba.
--
-- Mismas firmas y mismos tipos de retorno: CREATE OR REPLACE conserva los
-- GRANT. No cambia lo que devuelve ninguna función, así que se puede aplicar
-- antes o después de desplegar el código.
--
-- Idempotente.
--
-- Revertir: volver a aplicar las definiciones de la 082 (ads_entidades_ids) y
-- la 089 (atribución), y
--   ALTER FUNCTION public.ads_daily_resumen(uuid,text,date,date,text,boolean) RESET plan_cache_mode;
--   ALTER FUNCTION report_utm.bi_leads_por_dia(uuid,timestamptz,timestamptz,integer,text) RESET plan_cache_mode;
--   ALTER FUNCTION report_utm.bi_respuestas_por_dia(uuid,timestamptz,timestamptz,text[],integer,text) RESET plan_cache_mode;
--
--   npx tsx scripts/sql-remoto.ts migrations/104_rpc_planes_por_llamada.sql
-- ════════════════════════════════════════════════════════════════

-- ── plpgsql existentes: solo el ajuste (todas las sobrecargas) ───
DO $$
DECLARE
    f regprocedure;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE (n.nspname, p.proname) IN (('public', 'ads_daily_resumen'),
                                          ('report_utm', 'bi_leads_por_dia'),
                                          ('report_utm', 'bi_respuestas_por_dia'))
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET plan_cache_mode TO %L', f, 'force_custom_plan');
    END LOOP;
END $$;

-- ── ads_entidades_ids ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ads_entidades_ids(p_cliente_id uuid, p_desde date, p_hasta date)
    RETURNS TABLE(plataforma text, nivel text, entidad_id text, entidad_nombre text, campana_id text, campana_nombre text, adset_id text, adset_nombre text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
    -- Una fila por entidad con ID: la del día más reciente, que da el nombre
    -- vigente (el mismo criterio que ads_daily_resumen desde la 082).
    RETURN QUERY
    SELECT DISTINCT ON (a.plataforma, a.nivel, a.entidad_id)
           a.plataforma, a.nivel, a.entidad_id, a.entidad_nombre,
           a.campana_id, a.campana_nombre, a.adset_id, a.adset_nombre
      FROM public.ads_daily a
     WHERE a.cliente_id = p_cliente_id
       AND a.entidad_id IS NOT NULL
       AND a.fecha >= p_desde
       AND a.fecha <= p_hasta
     ORDER BY a.plataforma, a.nivel, a.entidad_id, a.fecha DESC;
END;
$$;

-- ── Atribución de Hotmart ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hotmart_leads_para_atribucion(p_cliente_rtm uuid, p_emails text[], p_tel9 text[], p_desde timestamp with time zone, p_hasta timestamp with time zone)
    RETURNS TABLE(id uuid, created_at timestamp with time zone, email_norm text, tel9 text, utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, utm_id text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'report_utm', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
    RETURN QUERY
        SELECT l.id, l.created_at,
               lower(btrim(l.lead_email)),
               right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
               l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id
          FROM unnest(COALESCE(p_emails, ARRAY[]::text[])) AS e(valor)
          JOIN report_utm.lead_events l
            ON l.cliente_id = p_cliente_rtm
           AND l.lead_email IS NOT NULL AND NOT l.excluido
           AND lower(btrim(l.lead_email)) = e.valor
         WHERE l.created_at >= p_desde
           AND l.created_at <  p_hasta
           AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL)
        UNION
        SELECT l.id, l.created_at,
               lower(btrim(l.lead_email)),
               right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
               l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id
          FROM unnest(COALESCE(p_tel9, ARRAY[]::text[])) AS t(valor)
          JOIN report_utm.lead_events l
            ON l.cliente_id = p_cliente_rtm
           AND l.lead_phone IS NOT NULL AND NOT l.excluido
           AND right(regexp_replace(l.lead_phone, '\D', '', 'g'), 9) = t.valor
         WHERE length(regexp_replace(l.lead_phone, '\D', '', 'g')) >= 8
           AND l.created_at >= p_desde
           AND l.created_at <  p_hasta
           AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.hotmart_leads_para_atribucion_v2(p_cliente_rtm uuid, p_emails text[], p_tel9 text[], p_desde timestamp with time zone, p_hasta timestamp with time zone)
    RETURNS TABLE(id uuid, created_at timestamp with time zone, email_norm text, tel9 text, utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, utm_id text, campaign_id text, adset_id text, ad_id text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'report_utm', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
    RETURN QUERY
        SELECT l.id, l.created_at,
               lower(btrim(l.lead_email)),
               right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
               l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id,
               l.campaign_id, l.adset_id, l.ad_id
          FROM unnest(COALESCE(p_emails, ARRAY[]::text[])) AS e(valor)
          JOIN report_utm.lead_events l
            ON l.cliente_id = p_cliente_rtm
           AND l.lead_email IS NOT NULL AND NOT l.excluido
           AND lower(btrim(l.lead_email)) = e.valor
         WHERE l.created_at >= p_desde
           AND l.created_at <  p_hasta
           AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL
                OR l.campaign_id IS NOT NULL OR l.adset_id IS NOT NULL OR l.ad_id IS NOT NULL)
        UNION
        SELECT l.id, l.created_at,
               lower(btrim(l.lead_email)),
               right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
               l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id,
               l.campaign_id, l.adset_id, l.ad_id
          FROM unnest(COALESCE(p_tel9, ARRAY[]::text[])) AS t(valor)
          JOIN report_utm.lead_events l
            ON l.cliente_id = p_cliente_rtm
           AND l.lead_phone IS NOT NULL AND NOT l.excluido
           AND right(regexp_replace(l.lead_phone, '\D', '', 'g'), 9) = t.valor
         WHERE length(regexp_replace(l.lead_phone, '\D', '', 'g')) >= 8
           AND l.created_at >= p_desde
           AND l.created_at <  p_hasta
           AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL
                OR l.campaign_id IS NOT NULL OR l.adset_id IS NOT NULL OR l.ad_id IS NOT NULL);
END;
$$;
