/* eslint-disable @typescript-eslint/no-explicit-any -- filas de pg/PGlite y planes EXPLAIN sin tipo */
/**
 * Cola de sincronización: reclamación, espera entre reintentos, exclusión por
 * cliente, lease y heartbeat (migración 106).
 *
 * PURO: PGlite en memoria con el historial de migraciones y la 106. Una sola
 * conexión, así que aquí se prueba la SEMÁNTICA de `claim_sync_job`; la concurrencia real (varias
 * conexiones a la vez) la prueba `verify-cola-concurrencia.ts` contra un
 * Postgres de verdad.
 *
 *   npx tsx --conditions=react-server scripts/verify-cola-sync.ts
 */

import type { BaseLocal } from './bd-local/pglite';
import { crearBaseLocal, aplicarHistorial, aplicarMigracion } from './bd-local/pglite';
import {
  esperaReintentoMs,
  completeJob,
  failJob,
  releaseJob,
  heartbeat,
  type SyncJob,
} from '../src/lib/sync/queue';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);
}

const C1 = '30000000-0000-0000-0000-000000000001';
const C2 = '30000000-0000-0000-0000-000000000002';

async function reclamar(db: BaseLocal, worker: string, lease = 600): Promise<any | null> {
  const r = await db.query<any>(`select * from public.claim_sync_job($1, $2)`, [worker, lease]);
  return r.rows[0] ?? null;
}

let dia = 0;
/** Encola un job; cada uno con un rango distinto para no chocar con el índice de duplicados. */
async function encolar(db: BaseLocal, cliente: string | null, extra: Record<string, unknown> = {}) {
  const { fecha_inicio, ...resto } = extra;
  dia++;
  const inicio =
    fecha_inicio ??
    `2026-${String(1 + Math.floor(dia / 28)).padStart(2, '0')}-${String((dia % 28) + 1).padStart(2, '0')}`;
  const cols = ['tipo', 'cliente_id', 'fecha_inicio', 'fecha_fin', ...Object.keys(resto)];
  const vals = ['metricas', cliente, inicio, '2026-12-31', ...Object.values(resto)];
  const r = await db.query<{ id: string }>(
    `insert into public.sync_jobs (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    vals
  );
  return r.rows[0].id;
}

/** Cliente supabase-js mínimo: registra la cadena y responde lo que se le diga. */
function stub(datos: unknown[] | null) {
  const filtros: Array<[string, unknown]> = [];
  let patch: Record<string, unknown> | null = null;
  const q: any = {
    update: (p: Record<string, unknown>) => ((patch = p), q),
    eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
    select: () => Promise.resolve({ data: datos, error: null }),
  };
  const rpcs: Array<[string, unknown]> = [];
  return {
    db: {
      from: () => q,
      rpc: (n: string, a: unknown) => (
        rpcs.push([n, a]),
        Promise.resolve({ data: datos, error: null })
      ),
    },
    filtros,
    patch: () => patch,
    rpcs,
  };
}

async function main() {
  const db = await crearBaseLocal();
  await aplicarHistorial(db, { hasta: '103' });
  await aplicarMigracion(db, '106_cola_espera_y_dueno.sql');
  await db.query(`insert into public.clientes (id, nombre) values ($1, 'C1'), ($2, 'C2')`, [
    C1,
    C2,
  ]);

  seccion('Reclamación');
  const bajo = await encolar(db, C1, { prioridad: 9, fecha_inicio: '2026-10-01' });
  const alto = await encolar(db, C2, { prioridad: 1, fecha_inicio: '2026-10-02' });
  const j1 = await reclamar(db, 'w1');
  check('entrega primero el de mayor prioridad (número menor)', j1?.id === alto);
  check(
    'lo deja running, con lease del ejecutor y un intento gastado',
    j1?.estado === 'running' && j1?.locked_by === 'w1' && j1?.intentos === 1
  );
  const j2 = await reclamar(db, 'w2');
  check('el siguiente reclamo da el otro job', j2?.id === bajo);
  check('con todo tomado, la cola está vacía', (await reclamar(db, 'w3')) === null);

  const dup = await db
    .query(
      `insert into public.sync_jobs (tipo, cliente_id, fecha_inicio, fecha_fin) select tipo, cliente_id, fecha_inicio, fecha_fin from public.sync_jobs where id = $1`,
      [bajo]
    )
    .then(() => null)
    .catch((e) => (e as { code?: string }).code);
  check(
    'no se puede encolar un duplicado de un job vivo (índice único parcial)',
    dup === '23505',
    String(dup)
  );

  seccion('Validación de argumentos');
  const sinWorker = await reclamar(db, '')
    .then(() => 'ok')
    .catch((e) => (e as Error).message);
  check('exige identificar al ejecutor', /p_worker/.test(sinWorker));
  const leaseRaro = await reclamar(db, 'w1', 5)
    .then(() => 'ok')
    .catch((e) => (e as Error).message);
  check('rechaza un lease absurdo (< 30 s)', /p_lease_seconds/.test(leaseRaro));

  seccion('Espera entre reintentos (disponible_desde)');
  await db.exec(`update public.sync_jobs set estado = 'done', locked_by = null`);
  const pospuesto = await encolar(db, C1, {
    disponible_desde: new Date(Date.now() + 60_000).toISOString(),
  });
  check('un job con espera pendiente no se entrega', (await reclamar(db, 'w1')) === null);
  await db.query(
    `update public.sync_jobs set disponible_desde = now() - interval '1 second' where id = $1`,
    [pospuesto]
  );
  check('cumplida la espera, sí se entrega', (await reclamar(db, 'w1'))?.id === pospuesto);

  seccion('Un cliente, un ejecutor');
  const otroDeC1 = await encolar(db, C1);
  const deC2 = await encolar(db, C2);
  const r = await reclamar(db, 'w2');
  check(
    'con C1 en curso (lease vivo), se salta su otro job y entrega el de C2',
    r?.id === deC2,
    r?.id
  );
  check('y C1 sigue esperando', (await reclamar(db, 'w3')) === null);
  await db.query(
    `update public.sync_jobs set locked_at = now() - interval '20 minutes' where id = $1`,
    [pospuesto]
  );
  const tras = await reclamar(db, 'w3');
  check(
    'si el lease de C1 vence, el job colgado se puede recuperar',
    tras?.id === pospuesto || tras?.id === otroDeC1,
    tras?.id
  );
  check(
    'recuperar un job colgado gasta un intento más',
    tras?.id !== pospuesto || tras?.intentos === 2
  );

  seccion('Lease y heartbeat');
  const hb = await db.query<{ ok: boolean }>(`select public.heartbeat_sync_job($1, 'w3') ok`, [
    tras.id,
  ]);
  check('el dueño renueva su lease', hb.rows[0].ok === true);
  const hbAjeno = await db.query<{ ok: boolean }>(`select public.heartbeat_sync_job($1, 'w1') ok`, [
    tras.id,
  ]);
  check('un ejecutor que perdió el lease no lo renueva (y lo sabe)', hbAjeno.rows[0].ok === false);
  const tocado = await db.query<{ locked_by: string }>(
    `select locked_by from public.sync_jobs where id = $1`,
    [tras.id]
  );
  check('el heartbeat ajeno no cambia de dueño el job', tocado.rows[0].locked_by === 'w3');

  seccion('Backoff (esperaReintentoMs)');
  const sinAzar = () => 0.5;
  check('primer reintento ≈ 30 s', esperaReintentoMs(1, sinAzar) === 30_000);
  check(
    'segundo ≈ 1 min, tercero ≈ 2 min',
    esperaReintentoMs(2, sinAzar) === 60_000 && esperaReintentoMs(3, sinAzar) === 120_000
  );
  check('con techo de 30 min', esperaReintentoMs(20, sinAzar) === 1_800_000);
  check(
    'dispersión ±20 %',
    esperaReintentoMs(1, () => 0) === 24_000 && esperaReintentoMs(1, () => 1) === 36_000
  );

  seccion('Transiciones con dueño (fencing) en queue.ts');
  const job = { id: 'j', intentos: 1, max_intentos: 3 } as SyncJob;
  const s1 = stub([{ id: 'j' }]);
  const antes = Date.now();
  await failJob(s1.db, job, 'boom', { worker: 'w1' });
  const p1 = s1.patch()!;
  check('failJob con intentos restantes vuelve a pending', p1.estado === 'pending');
  check(
    'failJob pospone el job (disponible_desde en el futuro)',
    typeof p1.disponible_desde === 'string' &&
      Date.parse(p1.disponible_desde as string) >= antes + 20_000
  );
  check(
    'failJob solo toca el job si sigue siendo del ejecutor',
    s1.filtros.some(([c, v]) => c === 'locked_by' && v === 'w1') &&
      s1.filtros.some(([c, v]) => c === 'estado' && v === 'running')
  );
  const s2 = stub([{ id: 'j' }]);
  await failJob(s2.db, { ...job, intentos: 3 }, 'boom');
  check(
    'agotado, queda en error y sin espera',
    s2.patch()!.estado === 'error' && !('disponible_desde' in s2.patch()!)
  );
  const s3 = stub([]);
  check(
    'completeJob devuelve false si el lease se perdió',
    (await completeJob(s3.db, 'j', { worker: 'w1' })) === false
  );
  const s4 = stub([{ id: 'j' }]);
  check(
    'completeJob devuelve true si era suyo',
    (await completeJob(s4.db, 'j', { worker: 'w1' })) === true
  );
  const s5 = stub([{ id: 'j' }]);
  await releaseJob(s5.db, 'j', 0, { worker: 'w1', esperaMs: 20_000 });
  check(
    'releaseJob por cliente ocupado pospone unos segundos',
    typeof s5.patch()!.disponible_desde === 'string'
  );
  const s6 = stub(true as unknown as unknown[]);
  check(
    'heartbeat usa la RPC con dueño',
    (await heartbeat(s6.db, 'j', 'w1')) === true && s6.rpcs[0]?.[0] === 'heartbeat_sync_job'
  );

  await db.close();
  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} comprobación(es) fallida(s)`);
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
