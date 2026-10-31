/**
 * Comprobaciones del archivo de leads antiguos (report-utm/archivo-leads.ts).
 *
 * El archivo en CSV es el ÚNICO ejemplar de los leads que se borran, así que lo
 * que se fija aquí es el orden: nada se borra sin estar antes en un CSV que se
 * ha vuelto a leer, y una corrida cortada a mitad se retoma sin perder ni
 * duplicar. Todo es puro: base y Storage son falsos, en memoria.
 *
 *   npx tsx --conditions=react-server scripts/verify-archivo-leads.ts
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BUCKET_ARCHIVO_LEADS,
  archivarLeadsAntiguos,
  filasACsv,
  idsDeCsv,
  leerCsv,
  mesDeCorte,
  mesSiguiente,
} from '../src/lib/report-utm/archivo-leads';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

type Fila = Record<string, unknown>;

function comparar(a: unknown, b: unknown): number {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && /T/.test(String(a))) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Query de PostgREST sobre un array: lo justo que usa archivo-leads.ts. */
function consulta(tabla: Fila[], ops: string[], nombre: string) {
  const filtros: ((f: Fila) => boolean)[] = [];
  let orden: { col: string; asc: boolean } | null = null;
  let limite = Infinity;
  let borrar = false;
  const ejecutar = () => {
    let filas = tabla.filter((f) => filtros.every((p) => p(f)));
    if (orden) {
      const { col, asc } = orden;
      filas = [...filas].sort((x, y) => (asc ? 1 : -1) * comparar(x[col], y[col]));
    }
    filas = filas.slice(0, limite);
    if (borrar) {
      ops.push(`delete ${nombre} ${filas.length}`);
      for (const f of filas) tabla.splice(tabla.indexOf(f), 1);
      return { data: null, error: null, count: filas.length };
    }
    return { data: filas.map((f) => ({ ...f })), error: null };
  };
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push((f) => f[c] === v), q),
    lt: (c: string, v: unknown) => (filtros.push((f) => comparar(f[c], v) < 0), q),
    gte: (c: string, v: unknown) => (filtros.push((f) => comparar(f[c], v) >= 0), q),
    gt: (c: string, v: unknown) => (filtros.push((f) => comparar(f[c], v) > 0), q),
    in: (c: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[c])), q),
    not: (c: string, _op: string, _v: null) => (filtros.push((f) => f[c] != null), q),
    order: (col: string, o?: { ascending?: boolean }) => (
      (orden = { col, asc: o?.ascending ?? true }),
      q
    ),
    limit: (n: number) => ((limite = n), q),
    delete: () => ((borrar = true), q),
    maybeSingle: async () => ({ data: ejecutar().data?.[0] ?? null, error: null }),
    then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(ok, ko),
  };
  return q;
}

function dbFalsa(o: {
  leads: Fila[];
  clientesRtm: Fila[];
  clientesPub?: Fila[];
  archivos?: Map<string, Buffer>;
  /** El archivo releído llega sin su última fila (subida truncada). */
  relecturaTruncada?: boolean;
  subidaFalla?: boolean;
}) {
  const ops: string[] = [];
  const archivos = o.archivos ?? new Map<string, Buffer>();
  const subidos = new Set<string>();
  const tablas: Record<string, Fila[]> = {
    'report_utm.clientes': o.clientesRtm,
    'report_utm.lead_events': o.leads,
    'public.clientes': o.clientesPub ?? [],
  };
  const desde = (esquema: string) => ({
    from: (t: string) => consulta(tablas[`${esquema}.${t}`] ?? [], ops, t),
  });
  const db = {
    ...desde('public'),
    schema: (s: string) => desde(s),
    storage: {
      from: (bucket: string) => {
        if (bucket !== BUCKET_ARCHIVO_LEADS) throw new Error(`bucket inesperado ${bucket}`);
        return {
          list: async (carpeta: string, opt: { search?: string }) => ({
            data: [...archivos.keys()]
              .filter((k) => k.startsWith(`${carpeta}/`))
              .map((k) => ({ name: k.slice(carpeta.length + 1), id: k }))
              .filter((f) => !opt.search || f.name.includes(opt.search)),
            error: null,
          }),
          upload: async (ruta: string, cuerpo: Buffer, opt: { upsert?: boolean }) => {
            if (o.subidaFalla) return { data: null, error: { message: 'storage caído' } };
            if (archivos.has(ruta) && !opt.upsert) {
              return { data: null, error: { message: 'The resource already exists' } };
            }
            ops.push(`upload ${ruta}`);
            archivos.set(ruta, cuerpo);
            subidos.add(ruta);
            return { data: { path: ruta }, error: null };
          },
          download: async (ruta: string) => {
            let b = archivos.get(ruta);
            if (!b) return { data: null, error: { message: 'Object not found' } };
            if (o.relecturaTruncada && subidos.has(ruta)) {
              const lineas = gunzipSync(b).toString('utf8').trimEnd().split('\r\n');
              b = gzipSync(Buffer.from(lineas.slice(0, -1).join('\r\n') + '\r\n'));
            }
            return { data: new Blob([new Uint8Array(b)]), error: null };
          },
        };
      },
    },
  };
  return { db, ops, archivos };
}

const A = '0a000000-0000-4000-8000-000000000001';
const B = '0b000000-0000-4000-8000-000000000002';
const PUB_A = 'aa000000-0000-4000-8000-000000000001';

let n = 0;
function lead(cliente: string, created_at: string, extra: Fila = {}): Fila {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    cliente_id: cliente,
    created_at,
    lead_name: `Lead ${n}`,
    raw_fields: { pregunta: `respuesta ${n}` },
    ...extra,
  };
}

function idsDe(archivos: Map<string, Buffer>, prefijo: string): string[] {
  return [...archivos]
    .filter(([k]) => k.startsWith(prefijo))
    .flatMap(([, b]) => idsDeCsv(gunzipSync(b).toString('utf8')));
}

const AHORA = new Date('2026-12-27T15:00:00Z');

async function main() {
  // ── 1. Puro ──────────────────────────────────────────────────────
  console.log('\n── Meses y CSV ─────────────────────────────────────────');
  check('corte con 6 meses el 27-dic → 1-jun', mesDeCorte('2026-12-27', 6) === '2026-06-01');
  check('el corte cruza de año', mesDeCorte('2027-01-15', 6) === '2026-07-01');
  check('mes siguiente de diciembre', mesSiguiente('2026-12') === '2027-01');

  const raras: Fila[] = [
    {
      id: 'x1',
      lead_name: 'Peña, "la jefa"',
      lead_email: null,
      raw_fields: { a: 'línea 1\nlínea 2', b: [1, 2] },
    },
    { id: 'x2', lead_name: 'Ñandú', utm_term: '35-55' },
  ];
  const csv = filasACsv(raras);
  const [cab, f1, f2] = leerCsv(csv);
  check('empieza con BOM (Excel lo abre en UTF-8)', csv.startsWith('﻿'));
  check('id es la primera columna', cab[0] === 'id', cab.join(','));
  check('cabecera con la unión de columnas', cab.includes('utm_term') && cab.length === 5);
  check(
    'comas, comillas y saltos de línea sobreviven',
    f1[cab.indexOf('lead_name')] === 'Peña, "la jefa"' &&
      JSON.parse(f1[cab.indexOf('raw_fields')]).a === 'línea 1\nlínea 2'
  );
  check('null queda vacío', f1[cab.indexOf('lead_email')] === '');
  check('la columna que falta en una fila queda vacía', f1[cab.indexOf('utm_term')] === '');
  check('segunda fila intacta', f2[cab.indexOf('lead_name')] === 'Ñandú');
  check('idsDeCsv lee los ids', idsDeCsv(csv).join() === 'x1,x2');
  check('sin columna id no da nada por archivado', idsDeCsv('nombre\r\nx\r\n').length === 0);

  // ── 2. Corrida normal ────────────────────────────────────────────
  console.log('\n── Archiva y borra solo lo anterior al corte ───────────');
  {
    const abril = lead(A, '2026-04-10T15:00:00.000Z');
    const mayo1 = lead(A, '2026-05-02T15:00:00.000Z');
    // 31-may 22:00 en Bogotá: es MAYO aunque en UTC ya sea junio.
    const mayoTarde = lead(A, '2026-06-01T03:00:00.000Z');
    const junio = lead(A, '2026-06-01T06:00:00.000Z');
    const dic = lead(A, '2026-12-20T15:00:00.000Z');
    const deB = lead(B, '2026-01-10T15:00:00.000Z');
    const leads = [dic, junio, mayoTarde, abril, mayo1, deB];
    const { db, ops, archivos } = dbFalsa({
      leads,
      clientesRtm: [
        { id: A, nombre: 'A', public_cliente_id: PUB_A, retencion_leads_meses: 6 },
        { id: B, nombre: 'B', public_cliente_id: null, retencion_leads_meses: null },
      ],
      clientesPub: [{ id: PUB_A, config_api: { zona_horaria: 'America/Bogota' } }],
    });
    const r = await archivarLeadsAntiguos(db, { ahora: AHORA });
    check('sin errores', r.errores.length === 0, r.errores.join(' | '));
    check('un CSV por mes: abril y mayo', r.archivos.length === 2, r.archivos.join(', '));
    check(
      'nombres <cliente>/<mes>_<sello>.csv.gz',
      r.archivos.every((p) =>
        /^0a0{6}-0{4}-4000-8000-0{11}1\/2026-0[45]_\d{8}T\d{6}Z\.csv\.gz$/.test(p)
      )
    );
    check(
      'mayo incluye el lead del 31-may por la noche (zona del cliente)',
      idsDe(archivos, `${A}/2026-05`).sort().join() === [mayo1.id, mayoTarde.id].sort().join()
    );
    check('archivados 3, borrados 3', r.archivados === 3 && r.borrados === 3, JSON.stringify(r));
    const quedan = new Set(leads.map((l) => l.id));
    check('junio y diciembre se quedan', quedan.has(junio.id) && quedan.has(dic.id));
    check('el cliente sin retención no se toca', quedan.has(deB.id));
    check(
      'cada mes se sube ANTES de borrarse',
      ops.indexOf(ops.find((x) => x.startsWith('upload') && x.includes('2026-04'))!) <
        ops.indexOf(ops.find((x) => x.startsWith('delete'))!)
    );

    const otra = await archivarLeadsAntiguos(db, { ahora: AHORA });
    check(
      'una segunda corrida no hace nada',
      otra.archivos.length === 0 && otra.borrados === 0 && otra.errores.length === 0
    );
  }

  // ── 3. Retoma tras un corte ──────────────────────────────────────
  console.log('\n── Retoma lo que quedó a medias ────────────────────────');
  {
    const ya1 = lead(A, '2026-05-03T15:00:00.000Z');
    const ya2 = lead(A, '2026-05-04T15:00:00.000Z');
    const tarde = lead(A, '2026-05-05T15:00:00.000Z');
    // Una corrida anterior archivó ya1 y ya2 y se cortó antes de borrar;
    // `tarde` entró después (p. ej. una migración).
    const archivos = new Map([
      [`${A}/2026-05_20261201T110000Z.csv.gz`, gzipSync(Buffer.from(filasACsv([ya1, ya2])))],
    ]);
    const leads = [ya1, ya2, tarde];
    const { db } = dbFalsa({
      leads,
      archivos,
      clientesRtm: [{ id: A, nombre: 'A', public_cliente_id: null, retencion_leads_meses: 6 }],
    });
    const r = await archivarLeadsAntiguos(db, { ahora: AHORA });
    check('sin errores', r.errores.length === 0, r.errores.join(' | '));
    check(
      'el lead que faltaba va a un CSV nuevo, sin reescribir el anterior',
      r.archivos.length === 1 &&
        archivos.size === 2 &&
        idsDe(archivos, r.archivos[0]).join() === tarde.id
    );
    check('se borran los tres', leads.length === 0 && r.borrados === 3);
  }

  // ── 4. Fallos: nada se borra ─────────────────────────────────────
  console.log('\n── Si el archivo no está completo, no se borra nada ────');
  for (const [nombre, fallo] of [
    ['la relectura no trae todos los leads', { relecturaTruncada: true }],
    ['la subida falla', { subidaFalla: true }],
  ] as const) {
    const leads = [
      lead(A, '2026-03-03T15:00:00.000Z'),
      lead(A, '2026-03-04T15:00:00.000Z'),
      lead(A, '2026-03-05T15:00:00.000Z'),
    ];
    const { db } = dbFalsa({
      leads,
      clientesRtm: [{ id: A, nombre: 'A', public_cliente_id: null, retencion_leads_meses: 6 }],
      ...fallo,
    });
    const r = await archivarLeadsAntiguos(db, { ahora: AHORA });
    check(
      `${nombre}: error y los 3 leads siguen`,
      r.errores.length === 1 && leads.length === 3 && r.borrados === 0,
      JSON.stringify(r)
    );
  }

  // ── 5. Mínimo de retención y presupuesto ─────────────────────────
  console.log('\n── Mínimo de 6 meses y presupuesto ─────────────────────');
  {
    const julio = lead(A, '2026-07-10T15:00:00.000Z');
    const leads = [julio];
    const { db } = dbFalsa({
      leads,
      clientesRtm: [{ id: A, nombre: 'A', public_cliente_id: null, retencion_leads_meses: 2 }],
    });
    await archivarLeadsAntiguos(db, { ahora: AHORA });
    check('una retención de 2 meses se trata como 6 (julio se queda)', leads.length === 1);

    const sinTiempo = await archivarLeadsAntiguos(
      dbFalsa({
        leads: [lead(A, '2026-01-01T15:00:00.000Z')],
        clientesRtm: [{ id: A, nombre: 'A', public_cliente_id: null, retencion_leads_meses: 6 }],
      }).db,
      { ahora: AHORA, presupuestoMs: 0 }
    );
    check(
      'sin presupuesto no toca nada y lo marca pendiente',
      sinTiempo.pendiente && sinTiempo.borrados === 0
    );
  }

  console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} fallo(s)`);
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
