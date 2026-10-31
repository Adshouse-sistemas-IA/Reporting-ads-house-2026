'use server';

import {
  exigirAccesoCliente,
  exigirAjustePlataforma,
  exigirSesion,
  intentarGuarda,
} from '@/lib/acceso/clientes';
import { createAdminClient, createClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';
import { internalCronFetch } from '@/lib/internal-fetch';

async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('user_profiles').select('role').eq('id', user.id).single();
  return ['superadmin', 'admin'].includes(data?.role ?? '');
}

export type SyncPanelData = {
  cola: Record<string, number>;
  jobs: any[];
  runs: any[];
  clientes: Array<{ id: string; nombre: string }>;
  periodosCerrados: any[];
};

/**
 * Todo lo que muestra el panel de sincronización, en una sola pasada.
 *
 * Solo para un admin: los `logs` de una ejecución guardan la respuesta cruda
 * de la API del cliente. Antes no comprobaba ni la sesión.
 */
export async function getSyncPanelData(): Promise<SyncPanelData> {
  const vacio: SyncPanelData = {
    cola: { pending: 0, running: 0, done: 0, error: 0, cancelled: 0 },
    jobs: [],
    runs: [],
    clientes: [],
    periodosCerrados: [],
  };
  const guard = await intentarGuarda(() => exigirSesion('admin'));
  if (!guard.ok) return vacio;
  const supabase = await createAdminClient();
  const { data: propios, error: ec } = await supabase
    .from('clientes')
    .select('id, nombre')
    .order('nombre');
  if (ec) throw new Error(`[sync] clientes: ${ec.message}`);
  const ids = (propios ?? []).map((c) => c.id);
  const globales = (await intentarGuarda(() => exigirAjustePlataforma('admin'))).ok;
  // PostgREST: `cliente_id in (…)` y, si procede, también los de cliente nulo.
  const lista = ids.length ? `cliente_id.in.(${ids.join(',')})` : null;
  const filtro = [lista, globales ? 'cliente_id.is.null' : null].filter(Boolean).join(',');
  if (!filtro) return vacio;

  const [jobsRes, runsRes, cerradosRes] = await Promise.all([
    supabase
      .from('sync_jobs')
      .select(
        'id, tipo, cliente_id, fecha_inicio, fecha_fin, estado, prioridad, intentos, max_intentos, last_error, triggered_by, updated_at'
      )
      .or(filtro)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('sync_runs')
      // `logs` y `stats` los escribe el runner desde `debugLogs` (hasta 200
      // líneas) y son el ÚNICO sitio donde queda el error crudo de una API: el
      // status HTTP, la query enviada y el cuerpo de la respuesta. Hasta ahora
      // no se seleccionaban, así que diagnosticar una caída obligaba a consultar
      // Supabase a mano.
      .select(
        'id, tipo, cliente_id, fecha_inicio, fecha_fin, started_at, duracion_ms, estado, filas_escritas, filas_saltadas, error, ejecutor, logs, stats'
      )
      .or(filtro)
      .order('started_at', { ascending: false })
      .limit(60),
    ids.length
      ? supabase
          .from('periodos_cerrados')
          .select('cliente_id, periodo, cerrado_at')
          .in('cliente_id', ids)
          .order('periodo', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [que, r] of [
    ['jobs', jobsRes],
    ['runs', runsRes],
    ['periodos', cerradosRes],
  ] as const) {
    if (r.error) throw new Error(`[sync] ${que}: ${r.error.message}`);
  }

  const jobs = jobsRes.data ?? [];
  const cola: Record<string, number> = { pending: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  for (const j of jobs) cola[j.estado] = (cola[j.estado] ?? 0) + 1;

  return {
    cola,
    jobs,
    runs: runsRes.data ?? [],
    clientes: propios ?? [],
    periodosCerrados: cerradosRes.data ?? [],
  };
}

/**
 * Un job se toca si es de un cliente que el admin puede administrar; uno sin
 * cliente, solo como ajuste de plataforma.
 */
async function exigirJobPropio(jobId: string): Promise<string | null> {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('cliente_id')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return error.message;
  if (!data) return 'Job no encontrado';
  const cid = (data as { cliente_id: string | null }).cliente_id;
  const acceso = await intentarGuarda(() =>
    cid ? exigirAccesoCliente(cid, 'admin') : exigirAjustePlataforma('admin')
  );
  return acceso.ok ? null : acceso.error;
}

/** Devuelve un job fallido a la cola. */
export async function retrySyncJob(jobId: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const denegado = await exigirJobPropio(jobId);
  if (denegado) return { error: denegado };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('sync_jobs')
    .update({
      estado: 'pending',
      intentos: 0,
      last_error: null,
      locked_at: null,
      locked_by: null,
      // Reintento manual: inmediato, sin la espera del backoff.
      disponible_desde: new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}

export async function cancelSyncJob(jobId: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const denegado = await exigirJobPropio(jobId);
  if (denegado) return { error: denegado };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('sync_jobs')
    .update({ estado: 'cancelled', locked_at: null, locked_by: null })
    .eq('id', jobId);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}

/** Encola un rango manualmente desde el panel. */
export async function enqueueSyncRange(clienteId: string | null, start: string, end: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  if (clienteId) await exigirAccesoCliente(clienteId, 'admin');
  else await exigirSesion('admin');

  try {
    const res = await internalCronFetch('/api/worker/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'metricas',
        cliente_id: clienteId,
        start,
        end,
        prioridad: 2,
        triggered_by: 'admin_panel',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    revalidatePath('/admin/sync');
    return { success: true, encolados: data?.encolados ?? 0 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Error de red al encolar' };
  }
}

/**
 * Reabre un período congelado. El snapshot se conserva: si la re-sincronización
 * sale mal, los datos originales siguen en `metricas_snapshots`.
 */
export async function reabrirPeriodo(clienteId: string, periodo: string) {
  await exigirAccesoCliente(clienteId, 'admin');
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('periodos_cerrados')
    .delete()
    .eq('cliente_id', clienteId)
    .eq('periodo', periodo);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}
