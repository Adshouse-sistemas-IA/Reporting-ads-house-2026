import 'server-only';
import { createAdminClient } from '@/utils/supabase/server';
import { esUuid } from '@/lib/acceso/reglas';

/**
 * Frescura de los datos de un cliente: la última fila sincronizada de
 * `metricas_diarias` y la última ejecución de sync.
 *
 * Lectura interna SIN autorización: la llaman la acción `getDataFreshness`
 * (que antes exige acceso al cliente) y las páginas públicas de informes, que
 * ya resolvieron el cliente desde su token. No es una server action: no se
 * puede invocar desde el navegador.
 */
export async function leerFrescuraDatos(clienteId: string) {
  // El id se interpola en un filtro `or(...)`: solo se admite un uuid.
  if (!esUuid(clienteId)) return { data: null, lastRun: null, error: 'Cliente inválido' };
  const supabase = await createAdminClient();
  const [metricaRes, runRes] = await Promise.all([
    supabase
      .from('metricas_diarias')
      .select('fecha, synced_at, source_synced_at, is_partial')
      .eq('cliente_id', clienteId)
      .order('synced_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('sync_runs')
      .select('estado, finished_at, error')
      .or(`cliente_id.eq.${clienteId},cliente_id.is.null`)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (metricaRes.error) return { data: null, lastRun: null, error: metricaRes.error.message };
  if (runRes.error) console.error('[frescura] última ejecución de sync:', runRes.error.message);
  return { data: metricaRes.data, lastRun: runRes.data ?? null, error: null };
}
