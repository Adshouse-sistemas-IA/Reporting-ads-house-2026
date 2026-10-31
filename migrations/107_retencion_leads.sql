-- ════════════════════════════════════════════════════════════════
-- 107 · Retención de leads por cliente, con archivo en CSV
-- ════════════════════════════════════════════════════════════════
--
-- `lead_events` es la única tabla que crece sin tope: 286 MB de los 625 de la
-- base el 2026-10-31 (Eduversio sola, ~96.000 leads y ~130 MB). Un cliente con
-- `retencion_leads_meses` conserva en la base los últimos N meses completos
-- más el mes en curso; los meses anteriores los pasa
-- `src/lib/report-utm/archivo-leads.ts` (purga diaria del planner) a un CSV
-- comprimido en el bucket privado `archivo-leads` y SOLO después de releer el
-- archivo y comprobar que están todos los borra de la base.
--
--   · NULL = se conserva todo (lo que había hasta ahora). La migración no
--     activa la retención de ningún cliente: se decide cliente a cliente.
--   · Mínimo 6: la atribución de ventas de Hotmart mira 180 días atrás
--     (hotmart/atribucion.ts, LOOKBACK_DIAS). La de GoHighLevel mira 365: un
--     cliente con ventas de GHL no debería bajar de 12.
--
-- Bucket `archivo-leads`: privado y sin políticas, así que solo lo lee y lo
-- escribe el service role. Rutas: <report_utm.clientes.id>/<YYYY-MM>_<sello>.csv.gz.
-- Los archivos de un cliente se borran con él (eliminarClienteCompleto).
--
-- Solo añade: se aplica antes de desplegar el código.
--
-- Idempotente.
--
-- Revertir:
--   ALTER TABLE report_utm.clientes DROP COLUMN IF EXISTS retencion_leads_meses;
--   El bucket se borra desde el panel, y solo si está vacío: lo que tenga son
--   los únicos ejemplares de los leads archivados.
--
--   npx tsx scripts/sql-remoto.ts migrations/107_retencion_leads.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE report_utm.clientes ADD COLUMN IF NOT EXISTS retencion_leads_meses smallint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'report_utm.clientes'::regclass
          AND conname = 'clientes_retencion_leads_meses_check'
    ) THEN
        ALTER TABLE report_utm.clientes
            ADD CONSTRAINT clientes_retencion_leads_meses_check
            CHECK (retencion_leads_meses IS NULL OR retencion_leads_meses BETWEEN 6 AND 120);
    END IF;
END $$;

COMMENT ON COLUMN report_utm.clientes.retencion_leads_meses IS
    'Meses completos de leads que se conservan en lead_events (más el mes en curso). Los anteriores se archivan en CSV en el bucket archivo-leads y se borran. NULL = se conserva todo.';

DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'Sin esquema storage: se omite el bucket (base de pruebas local).';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public)
    VALUES ('archivo-leads', 'archivo-leads', false)
    ON CONFLICT (id) DO NOTHING;
END $$;
