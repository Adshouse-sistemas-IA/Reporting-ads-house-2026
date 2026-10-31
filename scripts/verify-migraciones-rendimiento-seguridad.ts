/**
 * Prueba las migraciones 104–109 sobre una base local (PGlite) que reproduce
 * producción a partir del historial (`scripts/bd-local/pglite.ts`). No toca la
 * red ni ninguna base remota.
 *
 *   npx tsx --conditions=react-server scripts/verify-migraciones-rendimiento-seguridad.ts
 *
 * Comprueba:
 *   · que aplican y que son idempotentes (se aplican dos veces);
 *   · 104: ads_entidades_ids y la atribución de Hotmart devuelven exactamente
 *     las mismas filas que antes, y las seis RPC llevan plan_cache_mode;
 *   · 105: el índice nuevo existe y el de la 082 no;
 *   · 106: la cola respeta `disponible_desde`, no entrega dos jobs del mismo
 *     cliente a la vez y el heartbeat dice quién es el dueño;
 *   · 107: la columna de retención y su CHECK;
 *   · 108: `anon` no ejecuta ninguna función ni lee ninguna tabla salvo la
 *     marca; las RPC de GA4 solo las ejecuta la service role;
 *   · 109: ninguna política nombra un correo ni es TO public; cada rol ve
 *     los leads, informes, pestañas y cola de los clientes que le tocan.
 */

import {
  aplicarHistorial,
  aplicarMigracion,
  comoAnonimo,
  comoRol,
  comoUsuario,
  crearBaseLocal,
  type BaseLocal,
} from './bd-local/pglite';
import { salir } from './_salida';

const NUEVAS = [
  '104_rpc_planes_por_llamada.sql',
  '105_indice_ads_daily_entidades.sql',
  '106_cola_espera_y_dueno.sql',
  '107_retencion_leads.sql',
  '108_funciones_y_privilegios_sin_anon.sql',
  '109_politicas_rls_por_cliente.sql',
];

let fallos = 0;
function check(nombre: string, ok: boolean, detalle?: unknown) {
  if (ok) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}`, detalle === undefined ? '' : JSON.stringify(detalle));
  }
}

const U = {
  superadmin: '00000000-0000-0000-0000-0000000000a1',
  admin: '00000000-0000-0000-0000-0000000000a2',
  traffickerA: '00000000-0000-0000-0000-0000000000a3',
  viewerA: '00000000-0000-0000-0000-0000000000a4',
  traffickerSin: '00000000-0000-0000-0000-0000000000a5',
};
const CLI_A = '00000000-0000-0000-0000-00000000c0a1';
const CLI_B = '00000000-0000-0000-0000-00000000c0b1';
const RTM_A = '00000000-0000-0000-0000-00000000d0a1';
const RTM_B = '00000000-0000-0000-0000-00000000d0b1';

async function sembrar(db: BaseLocal) {
  const roles: Record<string, string> = {
    [U.superadmin]: 'superadmin',
    [U.admin]: 'admin',
    [U.traffickerA]: 'trafficker',
    [U.viewerA]: 'viewer',
    [U.traffickerSin]: 'trafficker',
  };
  for (const [id, rol] of Object.entries(roles)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
      id,
      id === U.superadmin ? 'robinson@adshouse.com' : `${rol}-${id.slice(-2)}@prueba.local`,
    ]);
    await db.query(
      `insert into public.user_profiles (id, role) values ($1, $2::user_role)
       on conflict (id) do update set role = excluded.role`,
      [id, rol]
    );
  }
  await db.query(`insert into public.clientes (id, nombre) values ($1, 'A'), ($2, 'B')`, [
    CLI_A,
    CLI_B,
  ]);
  await db.query(
    `insert into report_utm.clientes (id, nombre, slug, public_cliente_id)
     values ($1, 'A', 'a', $3), ($2, 'B', 'b', $4)`,
    [RTM_A, RTM_B, CLI_A, CLI_B]
  );
  await db.query(
    `insert into public.user_client_assignments (user_id, client_id) values ($1, $3), ($2, $3)`,
    [U.traffickerA, U.viewerA, CLI_A]
  );

  // Leads: emails y teléfonos que casan, que no, excluidos, sin UTM y de otro cliente.
  const leads: [string, string | null, string | null, string | null, boolean, number][] = [
    [RTM_A, 'Ana@X.com ', '+57 300 111 2222', 'camp1', false, 3],
    [RTM_A, 'ana@x.com', null, 'camp2', false, 10],
    [RTM_A, null, '3001112222', 'camp3', false, 5],
    [RTM_A, 'luis@x.com', '300-999-8888', null, false, 4],
    [RTM_A, 'excluido@x.com', '3005556666', 'camp4', true, 2],
    [RTM_A, 'corto@x.com', '1234567', 'camp5', false, 2],
    [RTM_A, 'viejo@x.com', '3007778888', 'camp6', false, 400],
    [RTM_B, 'ana@x.com', '3001112222', 'campB', false, 3],
  ];
  for (const [cli, email, tel, camp, excluido, dias] of leads) {
    await db.query(
      `insert into report_utm.lead_events
         (cliente_id, lead_email, lead_phone, utm_campaign, excluido, created_at)
       values ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [cli, email, tel, camp, excluido, dias]
    );
  }

  // ads_daily: dos días por entidad, el más reciente con otro nombre.
  for (const [cli, ent, nombre, dias] of [
    [CLI_A, 'e1', 'Viejo', 5],
    [CLI_A, 'e1', 'Nuevo', 1],
    [CLI_A, 'e2', 'Otro', 2],
    [CLI_B, 'e9', 'DeB', 1],
  ] as const) {
    await db.query(
      `insert into public.ads_daily (cliente_id, fecha, plataforma, nivel, entidad_key, entidad_id,
                                     entidad_nombre, campana_id, campana_nombre)
       values ($1, current_date - $4::int, 'meta', 'ad', $2 || '-' || $4, $2, $3, 'c1', 'Camp')`,
      [cli, ent, nombre, dias]
    );
  }

  await db.query(
    `insert into public.bi_reports (nombre, cliente_id) values ('de A', $1), ('de B', $2), ('plantilla', null)`,
    [RTM_A, RTM_B]
  );
  await db.query(
    `insert into public.system_settings (key, value) values ('branding', '{}'::jsonb), ('secreto', '{}'::jsonb)
     on conflict (key) do nothing`
  );
  await db.query(
    `insert into public.meta_conversiones_catalogo (cliente_id, field_id, label, conversion_key)
     values ($1, 'f', 'l', 'k1'), ($2, 'f', 'l', 'k2')`,
    [CLI_A, CLI_B]
  );
  await db.query(
    `insert into public.cliente_tabs (cliente_id, nombre, keyword_meta) values ($1, 'tab A', 'a'), ($2, 'tab B', 'b')`,
    [CLI_A, CLI_B]
  );
}

type Fila = Record<string, unknown>;
const ordenar = (filas: Fila[]) => filas.map((f) => JSON.stringify(f)).sort();

async function salidas(db: BaseLocal) {
  const desde = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const hasta = new Date(Date.now() + 86_400_000).toISOString();
  const casos: [string[], string[]][] = [
    [
      ['ana@x.com', 'luis@x.com', 'excluido@x.com', 'corto@x.com'],
      ['001112222', '005556666'],
    ],
    [['ana@x.com'], []],
    [[], ['001112222', '234567']],
    [[], []],
  ];
  const v1: string[][] = [];
  const v2: string[][] = [];
  for (const [emails, tels] of casos) {
    const args = [RTM_A, emails, tels, desde, hasta];
    v1.push(
      ordenar(
        (
          await db.query<Fila>(
            `select * from public.hotmart_leads_para_atribucion($1,$2,$3,$4,$5)`,
            args
          )
        ).rows
      )
    );
    v2.push(
      ordenar(
        (
          await db.query<Fila>(
            `select * from public.hotmart_leads_para_atribucion_v2($1,$2,$3,$4,$5)`,
            args
          )
        ).rows
      )
    );
  }
  const entidades = ordenar(
    (
      await db.query<Fila>(
        `select * from public.ads_entidades_ids($1, current_date - 30, current_date)`,
        [CLI_A]
      )
    ).rows
  );
  return { v1, v2, entidades };
}

async function puedeEjecutar(db: BaseLocal, rol: string, firma: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select has_function_privilege($1, $2::regprocedure, 'EXECUTE') ok`,
    [rol, firma]
  );
  return rows[0].ok;
}

async function contar(
  db: BaseLocal,
  sql: string,
  params: unknown[] = []
): Promise<number | string> {
  try {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int n from (${sql}) x`,
      params
    );
    return rows[0].n;
  } catch (e) {
    return `error: ${(e as Error).message.split('\n')[0]}`;
  }
}

(async () => {
  const db = await crearBaseLocal();
  const { fallidas } = await aplicarHistorial(db, { hasta: '103' });
  check('el historial 001–103 aplica sobre la base reconstruida', fallidas.length === 0, fallidas);
  await sembrar(db);

  const antes = await salidas(db);
  const politicasConCorreo = await contar(
    db,
    `select 1 from pg_policies where (coalesce(qual,'') || coalesce(with_check,'')) like '%@%'`
  );
  check(
    'antes: hay políticas con correo fijo (la prueba mide algo)',
    Number(politicasConCorreo) > 0
  );
  check(
    'antes: anon puede ejecutar ga4_reemplazar_rango (la prueba mide algo)',
    await puedeEjecutar(db, 'anon', 'public.ga4_reemplazar_rango(uuid,date,date,jsonb,jsonb,jsonb)')
  );

  console.log('\nAplicar 104–109 (dos veces)');
  for (const vuelta of [1, 2]) {
    for (const f of NUEVAS) {
      try {
        await aplicarMigracion(db, f);
        check(`vuelta ${vuelta}: ${f}`, true);
      } catch (e) {
        check(`vuelta ${vuelta}: ${f}`, false, (e as Error).message);
      }
    }
  }

  console.log('\n104 · mismas filas y planes por llamada');
  const despues = await salidas(db);
  check(
    'ads_entidades_ids devuelve lo mismo',
    JSON.stringify(antes.entidades) === JSON.stringify(despues.entidades),
    { antes: antes.entidades, despues: despues.entidades }
  );
  check(
    'ads_entidades_ids da el nombre del día más reciente',
    despues.entidades.some((f) => f.includes('"Nuevo"'))
  );
  antes.v1.forEach((filas, i) =>
    check(
      `atribución v1, caso ${i + 1}: mismas filas (${filas.length})`,
      JSON.stringify(filas) === JSON.stringify(despues.v1[i]),
      {
        antes: filas,
        despues: despues.v1[i],
      }
    )
  );
  antes.v2.forEach((filas, i) =>
    check(
      `atribución v2, caso ${i + 1}: mismas filas (${filas.length})`,
      JSON.stringify(filas) === JSON.stringify(despues.v2[i]),
      {
        antes: filas,
        despues: despues.v2[i],
      }
    )
  );
  check(
    'el caso 1 encuentra leads (la comparación no es trivial)',
    antes.v2[0].length >= 3,
    antes.v2[0]
  );
  const { rows: planes } = await db.query<{ f: string; ok: boolean }>(
    `select p.oid::regprocedure::text f,
            coalesce('plan_cache_mode=force_custom_plan' = any (p.proconfig), false) ok
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('ads_daily_resumen', 'ads_entidades_ids', 'bi_leads_por_dia',
                          'bi_respuestas_por_dia', 'hotmart_leads_para_atribucion',
                          'hotmart_leads_para_atribucion_v2')`
  );
  check('las seis RPC existen', planes.length >= 6, planes);
  check(
    'todas con plan_cache_mode = force_custom_plan',
    planes.every((p) => p.ok),
    planes
  );

  console.log('\n105 · índices de ads_daily');
  const { rows: idx } = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes where tablename = 'ads_daily'`
  );
  const nombres = idx.map((i) => i.indexname);
  check('existe idx_ads_daily_entidades', nombres.includes('idx_ads_daily_entidades'));
  check('ya no existe idx_ads_daily_entidad_id', !nombres.includes('idx_ads_daily_entidad_id'));

  console.log('\n106 · cola');
  await db.exec(`delete from public.sync_jobs`);
  await db.query(
    `insert into public.sync_jobs (tipo, cliente_id, fecha_inicio, fecha_fin, prioridad, disponible_desde)
     values ('metricas', $1, '2026-01-01', '2026-01-02', 1, now() + interval '1 hour'),
            ('metricas', $1, '2026-01-03', '2026-01-04', 2, now()),
            ('metricas', $1, '2026-01-05', '2026-01-06', 3, now()),
            ('metricas', $2, '2026-01-01', '2026-01-02', 4, now())`,
    [CLI_A, CLI_B]
  );
  const reclamar = async (w: string) =>
    (
      await db.query<{ cliente_id: string; prioridad: number }>(
        `select cliente_id, prioridad from public.claim_sync_job($1, 600)`,
        [w]
      )
    ).rows[0];
  const r1 = await reclamar('w1');
  check('no entrega un job antes de disponible_desde', r1?.prioridad === 2, r1);
  const r2 = await reclamar('w2');
  check('no entrega otro job del mismo cliente mientras uno corre', r2?.cliente_id === CLI_B, r2);
  const r3 = await reclamar('w3');
  check('sin más clientes libres no entrega nada', r3 === undefined, r3);
  const { rows: hb } = await db.query<{ duenio: boolean; ajeno: boolean }>(
    `select public.heartbeat_sync_job(id, 'w1') duenio, public.heartbeat_sync_job(id, 'otro') ajeno
       from public.sync_jobs where locked_by = 'w1'`
  );
  check(
    'heartbeat: true para el dueño, false para otro',
    hb[0]?.duenio === true && hb[0]?.ajeno === false,
    hb
  );
  let rango = '';
  try {
    await db.query(`select * from public.claim_sync_job('w', 5)`);
  } catch (e) {
    rango = (e as Error).message;
  }
  check('rechaza un lease fuera de 30..7200 s', rango.includes('fuera de rango'), rango);
  check(
    'claim_sync_job: solo service_role',
    !(await puedeEjecutar(db, 'anon', 'public.claim_sync_job(text,integer)')) &&
      !(await puedeEjecutar(db, 'authenticated', 'public.claim_sync_job(text,integer)')) &&
      (await puedeEjecutar(db, 'service_role', 'public.claim_sync_job(text,integer)'))
  );

  console.log('\n107 · retención');
  let check107 = '';
  try {
    await db.query(`update report_utm.clientes set retencion_leads_meses = 3 where id = $1`, [
      RTM_A,
    ]);
  } catch (e) {
    check107 = (e as Error).message;
  }
  check(
    'retencion_leads_meses rechaza menos de 6',
    check107.includes('retencion_leads_meses'),
    check107
  );

  console.log('\n108 · nada al alcance de anon');
  const { rows: deAnon } = await db.query<{ f: string }>(
    `select p.oid::regprocedure::text f
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'report_utm')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and has_function_privilege('anon', p.oid, 'EXECUTE')`
  );
  check('ninguna función ejecutable por anon', deAnon.length === 0, deAnon);
  for (const f of [
    'public.ga4_reemplazar_rango(uuid,date,date,jsonb,jsonb,jsonb)',
    'public.ga4_reemplazar_paginas(uuid,date,date,jsonb,jsonb,jsonb)',
  ]) {
    const existe = (await db.query(`select to_regprocedure($1) f`, [f])).rows[0] as { f: unknown };
    if (!existe.f) continue;
    check(
      `${f.split('(')[0]}: solo service_role`,
      !(await puedeEjecutar(db, 'anon', f)) &&
        !(await puedeEjecutar(db, 'authenticated', f)) &&
        (await puedeEjecutar(db, 'service_role', f))
    );
  }
  const { rows: tablasAnon } = await db.query<{ t: string }>(
    `select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'report_utm')
        and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`
  );
  check(
    'anon solo tiene privilegio sobre system_settings',
    tablasAnon.length === 1 && tablasAnon[0].t === 'system_settings',
    tablasAnon
  );
  const { rows: truncate } = await db.query<{ t: string }>(
    `select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'report_utm')
        and has_table_privilege('authenticated', c.oid, 'TRUNCATE')`
  );
  check('authenticated no puede TRUNCATE ninguna tabla', truncate.length === 0, truncate);
  check(
    'las RPC de lectura siguen al alcance de authenticated',
    await puedeEjecutar(
      db,
      'authenticated',
      'public.ads_daily_resumen(uuid,text,date,date,text,boolean)'
    )
  );

  console.log('\n109 · políticas');
  check(
    'ninguna política nombra un correo',
    (await contar(
      db,
      `select 1 from pg_policies where (coalesce(qual,'') || coalesce(with_check,'')) like '%@%'`
    )) === 0
  );
  const { rows: publicas } = await db.query<{ p: string }>(
    `select tablename || '.' || policyname p from pg_policies
      where schemaname in ('public', 'report_utm') and 'public' = any (roles)`
  );
  check('ninguna política TO public', publicas.length === 0, publicas);
  const { rows: abiertas } = await db.query<{ p: string }>(
    `select tablename || '.' || policyname p from pg_policies
      where schemaname in ('public', 'report_utm') and (qual = 'true' or with_check = 'true')
        and tablename not in ('fx_rates', 'estrategia_tipos', 'user_profiles')`
  );
  check('ningún USING (true) sobre datos de clientes', abiertas.length === 0, abiertas);

  /** Total visto sin RLS (como el dueño de las tablas). */
  const total = async (sql: string, params: unknown[] = []) =>
    Number(await contar(db, sql, params));
  /** `anon` no ve nada: 0 filas o «permission denied» (sin privilegio de tabla). */
  const sinAcceso = (r: number | string) => r === 0 || String(r).includes('permission denied');

  const leads = `select 1 from report_utm.lead_events`;
  const leadsTotal = await total(leads);
  const leadsA = await total(`${leads} where cliente_id = $1`, [RTM_A]);
  check(
    'superadmin ve todos los leads',
    (await comoUsuario(db, U.superadmin, () => contar(db, leads))) === leadsTotal
  );
  check(
    'admin ve todos los leads',
    (await comoUsuario(db, U.admin, () => contar(db, leads))) === leadsTotal
  );
  check(
    'trafficker asignado a A ve solo los de A',
    leadsA < leadsTotal &&
      (await comoUsuario(db, U.traffickerA, () => contar(db, leads))) === leadsA
  );
  check(
    'trafficker sin clientes no ve leads',
    (await comoUsuario(db, U.traffickerSin, () => contar(db, leads))) === 0
  );
  check(
    'viewer no ve leads (como antes)',
    (await comoUsuario(db, U.viewerA, () => contar(db, leads))) === 0
  );
  check('anon no lee leads', sinAcceso(await comoAnonimo(db, () => contar(db, leads))));

  const informes = `select 1 from public.bi_reports`;
  const informesVisiblesA = await total(`${informes} where cliente_id is null or cliente_id = $1`, [
    RTM_A,
  ]);
  check(
    'trafficker A ve sus informes y las plantillas, no los de B',
    (await comoUsuario(db, U.traffickerA, () => contar(db, informes))) === informesVisiblesA
  );
  check('anon no lista informes', sinAcceso(await comoAnonimo(db, () => contar(db, informes))));

  const ajustes = `select key from public.system_settings`;
  const ajustesTotal = await total(ajustes);
  check('anon solo lee la marca', (await comoAnonimo(db, () => contar(db, ajustes))) === 1);
  check(
    'admin lee todos los ajustes',
    ajustesTotal > 1 && (await comoUsuario(db, U.admin, () => contar(db, ajustes))) === ajustesTotal
  );
  check(
    'viewer solo lee la marca',
    (await comoUsuario(db, U.viewerA, () => contar(db, ajustes))) === 1
  );

  const catalogo = `select 1 from public.meta_conversiones_catalogo`;
  check(
    'anon no lee el catálogo de conversiones',
    sinAcceso(await comoAnonimo(db, () => contar(db, catalogo)))
  );
  check(
    'trafficker A ve solo el catálogo de A',
    (await comoUsuario(db, U.traffickerA, () => contar(db, catalogo))) ===
      (await total(`${catalogo} where cliente_id = $1`, [CLI_A]))
  );
  const escribirCatalogo = await comoRol(db, 'anon', null, async () => {
    try {
      await db.query(
        `insert into public.meta_conversiones_catalogo (cliente_id, field_id, label, conversion_key)
         values ($1, 'f', 'l', 'k3')`,
        [CLI_A]
      );
      return 'escribió';
    } catch {
      return 'rechazado';
    }
  });
  check('anon no escribe el catálogo', escribirCatalogo === 'rechazado');

  const pestanas = `select 1 from public.cliente_tabs`;
  const pestanasA = await total(`${pestanas} where cliente_id = $1`, [CLI_A]);
  check(
    'trafficker A ve solo las pestañas de A',
    pestanasA > 0 &&
      (await comoUsuario(db, U.traffickerA, () => contar(db, pestanas))) === pestanasA
  );
  check(
    'admin ve todas las pestañas',
    (await comoUsuario(db, U.admin, () => contar(db, pestanas))) === (await total(pestanas))
  );
  check(
    'viewer no edita pestañas',
    (await comoUsuario(db, U.viewerA, () => contar(db, pestanas))) === 0
  );

  const cola = `select 1 from public.sync_jobs`;
  check(
    'trafficker A ve solo la cola de A',
    (await comoUsuario(db, U.traffickerA, () => contar(db, cola))) ===
      (await total(`${cola} where cliente_id = $1`, [CLI_A]))
  );

  await db.close();
  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
  salir(fallos);
})();
