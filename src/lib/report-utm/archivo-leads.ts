/**
 * Archivo de leads antiguos: retención por cliente.
 *
 * `lead_events` es la única tabla que crece sin tope (~1,3 KB por lead con sus
 * índices; Eduversio solo son ~26 MB al mes contra los 500 MB del plan
 * gratuito). Un cliente con `report_utm.clientes.retencion_leads_meses = N`
 * conserva en la base los últimos N meses completos más el mes en curso. Cada
 * mes anterior se pasa a un CSV comprimido en el bucket privado
 * `archivo-leads` (`<cliente UTM>/<YYYY-MM>_<sello>.csv.gz`) y se borra.
 *
 * El orden es lo que hace esto seguro, porque el archivo es el único ejemplar
 * que queda:
 *
 *   1. Se leen los ids ya archivados de ese mes (los CSV que haya).
 *   2. Las filas del mes que NO estén en ningún CSV se escriben en uno nuevo,
 *      que nunca pisa a otro (`upsert: false`, sello de tiempo en el nombre).
 *   3. Se DESCARGA el archivo recién subido y se comprueba que cada id está.
 *   4. Solo entonces se borra de la base, por lotes y solo lo archivado.
 *
 * Si una corrida se corta a mitad (presupuesto, error de red), la siguiente
 * retoma: lo ya archivado no se reescribe y lo no archivado no se borra. Un
 * lead que entre tarde en un mes ya archivado (una migración) acaba en un CSV
 * aparte del mismo mes.
 *
 * Los meses se cortan en la zona del cliente, como el resto de la plataforma.
 * Se llama una vez al día desde `limpiarHistorial` (planner).
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { fetchAllRows } from '../supabase-paginate';
import { diaEnZona, ventanaDiaEnZona, zonaHorariaDeCliente } from '../zona-horaria';

/** Bucket privado (migración 20261027200549): solo lo usa el service role. */
export const BUCKET_ARCHIVO_LEADS = 'archivo-leads';
/**
 * Por debajo de esto la atribución de ventas de Hotmart (180 días) se quedaría
 * sin el lead. La columna tiene el mismo CHECK; esto es la segunda red.
 */
export const RETENCION_LEADS_MIN_MESES = 6;
/** Tiempo por corrida: lo que no quepa se retoma al día siguiente. */
const PRESUPUESTO_MS = 25_000;
/** Ids por DELETE: 200 uuid caben en la URL de PostgREST con margen. */
const LOTE_BORRADO = 200;
/** Meses por cliente y corrida (solo importa la primera vez, para ponerse al día). */
const MAX_MESES_POR_CORRIDA = 3;
/** Excel abre el CSV como UTF-8 (tildes, eñes) solo si empieza con BOM. */
const BOM = '﻿';

export interface ResumenArchivoLeads {
  /** Leads escritos en CSV nuevos en esta corrida. */
  archivados: number;
  /** Leads borrados de la base (todos ya estaban archivados). */
  borrados: number;
  /** Rutas de los CSV creados. */
  archivos: string[];
  /** Quedó un mes a medias por presupuesto: la próxima corrida sigue. */
  pendiente: boolean;
  errores: string[];
}

// ── Puro ────────────────────────────────────────────────────────────

/**
 * Primer día (YYYY-MM-DD) del mes más antiguo que se conserva: el mes en curso
 * menos `meses`. Con hoy = 2026-12-27 y 6 meses → 2026-06-01; junio se queda.
 */
export function mesDeCorte(hoy: string, meses: number): string {
  const [y, m] = hoy.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - meses, 1)).toISOString().slice(0, 10);
}

/** `YYYY-MM` del mes siguiente. */
export function mesSiguiente(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

function campoCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV (RFC 4180) con TODAS las columnas de `lead_events`, `id` primero. Los
 * JSONB van como JSON: es un archivo para poder restaurar, no un informe (para
 * eso está la exportación de /leads).
 */
export function filasACsv(filas: Record<string, unknown>[]): string {
  const columnas = ['id'];
  const vistas = new Set(columnas);
  for (const f of filas) {
    for (const k of Object.keys(f)) {
      if (!vistas.has(k)) {
        vistas.add(k);
        columnas.push(k);
      }
    }
  }
  const lineas = [columnas.join(',')];
  for (const f of filas) lineas.push(columnas.map((c) => campoCsv(f[c])).join(','));
  return BOM + lineas.join('\r\n') + '\r\n';
}

/** Lee un CSV RFC 4180: comillas dobles, comillas escapadas y saltos dentro de un campo. */
export function leerCsv(texto: string): string[][] {
  const s = texto.startsWith(BOM) ? texto.slice(1) : texto;
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (entreComillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          campo += '"';
          i++;
        } else entreComillas = false;
      } else campo += ch;
    } else if (ch === '"') entreComillas = true;
    else if (ch === ',') {
      fila.push(campo);
      campo = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += ch;
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

/** Ids de un CSV de archivo. Sin columna `id` no hay nada que dé por archivado. */
export function idsDeCsv(texto: string): string[] {
  const [cabecera, ...resto] = leerCsv(texto);
  const i = cabecera?.indexOf('id') ?? -1;
  if (i < 0) return [];
  return resto.map((r) => r[i]).filter((v): v is string => !!v);
}

function sello(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

// ── Base y Storage ──────────────────────────────────────────────────

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Mismo tipo laxo que el planner: recibe el cliente de la app y el del worker.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

async function zonaDe(db: Db, publicId: string | null): Promise<string> {
  if (!publicId) return zonaHorariaDeCliente(null);
  const { data, error } = await db
    .from('clientes')
    .select('config_api')
    .eq('id', publicId)
    .maybeSingle();
  // Sin la zona no se sabe dónde empieza el mes: mejor saltarse el día.
  if (error) throw new Error(`zona del cliente: ${error.message}`);
  return zonaHorariaDeCliente(data?.config_api ?? null);
}

async function idsDeArchivo(bucket: Db, ruta: string): Promise<string[]> {
  const { data, error } = await bucket.download(ruta);
  if (error || !data) throw new Error(`no se pudo leer ${ruta}: ${error?.message ?? 'vacío'}`);
  const bytes = Buffer.from(await (data as Blob).arrayBuffer());
  return idsDeCsv(gunzipSync(bytes).toString('utf8'));
}

/** Ids ya archivados de un mes: la unión de todos sus CSV. */
async function idsArchivados(bucket: Db, clienteId: string, mes: string): Promise<Set<string>> {
  const { data, error } = await bucket.list(clienteId, { limit: 1000, offset: 0, search: mes });
  if (error) throw new Error(`no se pudo listar el archivo: ${error.message}`);
  const ids = new Set<string>();
  for (const f of (data ?? []) as { name: string }[]) {
    if (!f.name.startsWith(`${mes}_`)) continue;
    for (const id of await idsDeArchivo(bucket, `${clienteId}/${f.name}`)) ids.add(id);
  }
  return ids;
}

/**
 * Archiva y borra el mes más antiguo anterior al corte. Devuelve `vacio` si no
 * queda nada antes del corte, `pendiente` si se acabó el presupuesto a mitad.
 */
async function archivarMes(
  db: Db,
  clienteId: string,
  tz: string,
  corteIso: string,
  resumen: ResumenArchivoLeads,
  quedaTiempo: () => boolean
): Promise<'vacio' | 'completo' | 'pendiente'> {
  const rutm = db.schema('report_utm');
  const { data: viejo, error } = await rutm
    .from('lead_events')
    .select('created_at')
    .eq('cliente_id', clienteId)
    .lt('created_at', corteIso)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(`lead más antiguo: ${error.message}`);
  if (!viejo || viejo.length === 0) return 'vacio';

  const mes = diaEnZona(viejo[0].created_at as string, tz).slice(0, 7);
  const desde = new Date(ventanaDiaEnZona(`${mes}-01`, tz).inicio).toISOString();
  const hasta = new Date(
    Math.min(ventanaDiaEnZona(`${mesSiguiente(mes)}-01`, tz).inicio, Date.parse(corteIso))
  ).toISOString();

  const bucket = db.storage.from(BUCKET_ARCHIVO_LEADS);
  const archivados = await idsArchivados(bucket, clienteId, mes);
  // Estricto: un mes leído a medias no puede darse por archivado.
  const filas = await fetchAllRows(
    () =>
      rutm
        .from('lead_events')
        .select('*')
        .eq('cliente_id', clienteId)
        .gte('created_at', desde)
        .lt('created_at', hasta),
    1000,
    500_000,
    { estricto: true }
  );

  const nuevas = filas.filter((f) => !archivados.has(String(f.id)));
  if (nuevas.length > 0) {
    const ruta = `${clienteId}/${mes}_${sello(new Date())}.csv.gz`;
    const cuerpo = gzipSync(Buffer.from(filasACsv(nuevas), 'utf8'));
    const { error: errSubida } = await bucket.upload(ruta, cuerpo, {
      contentType: 'application/gzip',
      upsert: false,
    });
    if (errSubida) throw new Error(`no se pudo subir ${ruta}: ${errSubida.message}`);

    // Se relee lo SUBIDO, no lo que se quiso subir.
    const releidos = new Set(await idsDeArchivo(bucket, ruta));
    const faltan = nuevas.filter((f) => !releidos.has(String(f.id))).length;
    if (faltan > 0) {
      throw new Error(`${ruta}: faltan ${faltan} lead(s) al releerlo; no se borra nada`);
    }
    for (const f of nuevas) archivados.add(String(f.id));
    resumen.archivados += nuevas.length;
    resumen.archivos.push(ruta);
  }

  const aBorrar = filas.map((f) => String(f.id)).filter((id) => archivados.has(id));
  for (let i = 0; i < aBorrar.length; i += LOTE_BORRADO) {
    if (!quedaTiempo()) {
      resumen.pendiente = true;
      return 'pendiente';
    }
    const { error: errBorrado, count } = await rutm
      .from('lead_events')
      .delete({ count: 'exact' })
      .eq('cliente_id', clienteId)
      .in('id', aBorrar.slice(i, i + LOTE_BORRADO));
    if (errBorrado) throw new Error(`borrado de ${mes}: ${errBorrado.message}`);
    resumen.borrados += count ?? 0;
  }
  return 'completo';
}

/**
 * Archiva y borra los leads de los clientes con retención. No lanza: los
 * errores van en el resumen (y al `mantenimiento_log` vía el planner), y el
 * fallo de un cliente no impide los demás.
 */
export async function archivarLeadsAntiguos(
  db: Db,
  opts: { ahora?: Date; presupuestoMs?: number } = {}
): Promise<ResumenArchivoLeads> {
  const t0 = Date.now();
  const ahora = opts.ahora ?? new Date();
  const presupuesto = opts.presupuestoMs ?? PRESUPUESTO_MS;
  const quedaTiempo = () => Date.now() - t0 < presupuesto;
  const resumen: ResumenArchivoLeads = {
    archivados: 0,
    borrados: 0,
    archivos: [],
    pendiente: false,
    errores: [],
  };

  const { data: clientes, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id, nombre, public_cliente_id, retencion_leads_meses')
    .not('retencion_leads_meses', 'is', null);
  if (error) {
    resumen.errores.push(`clientes con retención: ${error.message}`);
    return resumen;
  }

  for (const c of (clientes ?? []) as {
    id: string;
    nombre: string;
    public_cliente_id: string | null;
    retencion_leads_meses: number;
  }[]) {
    if (!quedaTiempo()) {
      resumen.pendiente = true;
      break;
    }
    try {
      const tz = await zonaDe(db, c.public_cliente_id);
      const meses = Math.max(RETENCION_LEADS_MIN_MESES, Math.floor(c.retencion_leads_meses));
      const corte = mesDeCorte(diaEnZona(ahora, tz), meses);
      const corteIso = new Date(ventanaDiaEnZona(corte, tz).inicio).toISOString();
      for (let i = 0; i < MAX_MESES_POR_CORRIDA && quedaTiempo(); i++) {
        if ((await archivarMes(db, c.id, tz, corteIso, resumen, quedaTiempo)) !== 'completo') break;
      }
    } catch (e) {
      resumen.errores.push(`${c.nombre}: ${mensaje(e)}`);
    }
  }
  return resumen;
}
