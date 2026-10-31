-- ════════════════════════════════════════════════════════════════
-- 106 · Cola de sync: espera entre reintentos y un solo ejecutor por cliente
-- ════════════════════════════════════════════════════════════════
--
-- Tres fallos de la cola de la 051/083:
--
--   · W1 · Reintentos sin espera. `failJob` devolvía el job a `pending` y el
--     siguiente ciclo (15 s) lo reclamaba otra vez: tres intentos en menos de
--     un minuto contra una API caída, cada uno añadiendo carga (la tormenta
--     del 2026-09-20). Ahora hay `disponible_desde` y `claim_sync_job` no
--     entrega un job antes de ese instante. `failJob` lo pospone 30 s, 1 min,
--     2 min… hasta 30 min (src/lib/sync/queue.ts, esperaReintentoMs).
--
--   · W3 · «Un cliente, un ejecutor» no era atómico. La exclusión estaba en el
--     runner (`clienteOcupado`: leer y luego decidir) y dos ejecutores podían
--     tomar a la vez dos jobs del mismo cliente. Ahora, dentro de la
--     reclamación y en sentencias separadas: bloqueo consultivo del cliente,
--     comprobar CON el bloqueo que no tiene otro job con lease vivo, y
--     reclamar con SKIP LOCKED revalidando el estado. Con 12 conexiones y
--     6 clientes × 8 jobs: 30–33 solapes del mismo cliente con la versión de
--     la 083, 0 con esta. `clienteOcupado` sigue como segunda barrera.
--
--   · W2 · `heartbeat_sync_job` devuelve si el ejecutor sigue siendo el dueño
--     del lease, para que uno que lo perdió deje de trabajar. Cambia el tipo
--     de retorno (void → boolean), así que se borra y se recrea.
--
-- `claim_sync_job` también valida sus argumentos (lease entre 30 y 7.200 s).
--
-- Compatible con el código desplegado: la columna nace con `now()`, el código
-- viejo no la escribe y entonces todo job está disponible como hasta ahora; el
-- viejo ignora lo que devuelve el heartbeat. Por eso se aplica ANTES de
-- desplegar la app y el sync-worker nuevos (que sí escriben la columna).
--
-- Permisos: solo service_role. Antes `anon` y `authenticated` podían ejecutar
-- las dos funciones.
--
-- Idempotente.
--
-- Revertir: recrear claim_sync_job y heartbeat_sync_job de la 083 (heartbeat
-- con DROP previo, vuelve a `void`) y
--   ALTER TABLE public.sync_jobs DROP COLUMN IF EXISTS disponible_desde;
-- (solo después de volver a desplegar el código anterior).
--
--   npx tsx scripts/sql-remoto.ts migrations/106_cola_espera_y_dueno.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.sync_jobs
    ADD COLUMN IF NOT EXISTS disponible_desde timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.sync_jobs.disponible_desde IS
    'No se entrega antes de este instante. failJob lo pospone con backoff exponencial; releaseJob, unos segundos si el cliente estaba ocupado.';

CREATE OR REPLACE FUNCTION public.claim_sync_job(p_worker text, p_lease_seconds integer DEFAULT 600)
    RETURNS SETOF public.sync_jobs
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
DECLARE
    v_lease interval;
    v_id    uuid;
    v_cli   uuid;
BEGIN
    IF p_worker IS NULL OR btrim(p_worker) = '' THEN
        RAISE EXCEPTION 'claim_sync_job: p_worker es obligatorio';
    END IF;
    IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 7200 THEN
        RAISE EXCEPTION 'claim_sync_job: p_lease_seconds fuera de rango 30..7200 (recibido: %)', p_lease_seconds;
    END IF;
    v_lease := make_interval(secs => p_lease_seconds::double precision);

    -- Candidatos por orden de prioridad. Cada paso del bucle es una sentencia
    -- aparte y, en READ COMMITTED, ve lo que otros ejecutores ya confirmaron:
    --   1. se toma el bloqueo consultivo del cliente (si otro reclamo lo tiene
    --      ahora mismo, se pasa al siguiente candidato);
    --   2. CON el bloqueo, se mira si el cliente ya tiene un job en curso con
    --      lease vivo. Hacerlo en la misma sentencia que el bloqueo no basta:
    --      su instantánea puede ser anterior a la confirmación del otro
    --      ejecutor;
    --   3. se reclama la fila con SKIP LOCKED, revalidando su estado.
    FOR v_id, v_cli IN
        SELECT c.id, c.cliente_id
          FROM public.sync_jobs c
         WHERE (c.estado = 'pending'
                OR (c.estado = 'running' AND c.locked_at < now() - v_lease))
           AND c.disponible_desde <= now()
         ORDER BY c.prioridad, c.created_at
         LIMIT 50
    LOOP
        IF v_cli IS NOT NULL THEN
            CONTINUE WHEN NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(v_cli::text, 0));
            CONTINUE WHEN EXISTS (
                SELECT 1 FROM public.sync_jobs r
                 WHERE r.cliente_id = v_cli
                   AND r.estado = 'running'
                   AND r.locked_at >= now() - v_lease
                   AND r.id <> v_id);
        END IF;

        RETURN QUERY
        UPDATE public.sync_jobs j
           SET estado    = 'running',
               locked_at = now(),
               locked_by = p_worker,
               intentos  = j.intentos + 1
         WHERE j.id = (
            SELECT c.id FROM public.sync_jobs c
             WHERE c.id = v_id
               AND (c.estado = 'pending'
                    OR (c.estado = 'running' AND c.locked_at < now() - v_lease))
               AND c.disponible_desde <= now()
             FOR UPDATE SKIP LOCKED)
        RETURNING j.*;
        IF FOUND THEN
            RETURN;
        END IF;
    END LOOP;
END $$;

COMMENT ON FUNCTION public.claim_sync_job(text, integer) IS
    'Entrega atómicamente el siguiente job disponible (SKIP LOCKED), respetando disponible_desde y sin dar dos jobs del mismo cliente a la vez. Solo service_role.';

DROP FUNCTION IF EXISTS public.heartbeat_sync_job(uuid, text);

CREATE FUNCTION public.heartbeat_sync_job(p_job_id uuid, p_worker text)
    RETURNS boolean
    LANGUAGE sql
    SET search_path = ''
AS $$
    WITH renovado AS (
        UPDATE public.sync_jobs
           SET locked_at = now()
         WHERE id = p_job_id AND locked_by = p_worker AND estado = 'running'
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM renovado)
$$;

COMMENT ON FUNCTION public.heartbeat_sync_job(uuid, text) IS
    'Renueva el lease si p_worker sigue siendo su dueño. false = el lease se perdió: el ejecutor debe abandonar el job.';

REVOKE ALL ON FUNCTION public.claim_sync_job(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_sync_job(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sync_job(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_sync_job(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
