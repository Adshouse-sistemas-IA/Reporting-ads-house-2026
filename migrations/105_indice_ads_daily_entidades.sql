-- ════════════════════════════════════════════════════════════════
-- 105 · ads_daily: índice para la lista de entidades, en lugar del de la 082
-- ════════════════════════════════════════════════════════════════
--
-- `ads_entidades_ids` y el CTE `nombres` de `ads_daily_resumen` piden una fila
-- por entidad (`DISTINCT ON (plataforma, nivel, entidad_id) … ORDER BY …,
-- fecha DESC`) en un rango de fechas. Con `idx_ads_daily_entidad_id
-- (cliente_id, entidad_id)` Postgres leía todas las filas del rango y las
-- ordenaba en disco. El índice nuevo da las filas ya en ese orden:
--   · 365 días, cliente grande: 533 ms y 7.904 bloques temporales → 45 ms, 0.
--
-- `idx_ads_daily_entidad_id` solo lo usaba esa RPC (ninguna consulta del
-- código filtra por `entidad_id`); en producción tenía 0 lecturas el
-- 2026-10-31. Se retira DESPUÉS de crear el nuevo.
--
-- Sin CONCURRENTLY: la Management API envía el archivo como una transacción
-- implícita y CONCURRENTLY no puede correr dentro de una (como en la 083).
-- `ads_daily` son ~83.000 filas: el índice se crea en uno o dos segundos y
-- solo bloquea escrituras (las del worker, que reintenta), no lecturas.
-- lock_timeout evita quedarse esperando detrás de un upsert largo.
--
-- Va después de la 104 (que pasa ads_entidades_ids a plpgsql), aunque
-- funciona en cualquier orden.
--
-- Idempotente.
--
-- Revertir:
--   CREATE INDEX IF NOT EXISTS idx_ads_daily_entidad_id
--       ON public.ads_daily (cliente_id, entidad_id) WHERE entidad_id IS NOT NULL;
--   DROP INDEX IF EXISTS public.idx_ads_daily_entidades;
--
--   npx tsx scripts/sql-remoto.ts migrations/105_indice_ads_daily_entidades.sql
-- ════════════════════════════════════════════════════════════════

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_ads_daily_entidades
    ON public.ads_daily (cliente_id, plataforma, nivel, entidad_id, fecha DESC)
    WHERE entidad_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_ads_daily_entidad_id;
