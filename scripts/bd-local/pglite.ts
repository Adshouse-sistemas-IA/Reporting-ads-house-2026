/**
 * Base de datos efímera para probar migraciones: Postgres en WASM (PGlite) con
 * el shim de Supabase (`supabase-shim.sql`).
 *
 * No toca la red ni ninguna base remota. Cada llamada a `crearBaseLocal()`
 * devuelve una base en memoria nueva y vacía.
 *
 * `aplicarHistorial` reproduce la base de producción a partir del repo: la base
 * que el historial da por existente (`historial-base-reconstruida.sql`, deducida
 * del código, de docs/04 y de la 081) y encima `migrations/*.sql` en orden. Es
 * una aproximación: la verdad es producción (docs/00 §4). Sirve para probar una
 * migración nueva antes de aplicarla, cuando no hay staging.
 *
 *   const db = await crearBaseLocal();
 *   await aplicarHistorial(db, { hasta: '103' });
 *   await comoUsuario(db, userId, async () => db.query('select …'));
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

export const RAIZ = join(__dirname, '..', '..');
export const DIR_MIGRACIONES = join(RAIZ, 'migrations');

export type BaseLocal = PGlite;

export async function crearBaseLocal(): Promise<BaseLocal> {
  const db = await PGlite.create({ extensions: { pg_trgm } });
  await db.exec(readFileSync(join(__dirname, 'supabase-shim.sql'), 'utf8'));
  return db;
}

/** Archivos de `migrations/` en orden de nombre (el número repetido va por nombre). */
export function archivosMigraciones(): string[] {
  return readdirSync(DIR_MIGRACIONES)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Lee una migración como la aplicaría `sql-remoto.ts`, salvo lo que PGlite no
 * admite: `VACUUM` se omite y `CREATE INDEX CONCURRENTLY` va sin CONCURRENTLY.
 */
export function leerMigracion(archivo: string): string {
  return readFileSync(join(DIR_MIGRACIONES, archivo), 'utf8')
    .replace(/^VACUUM.*$/gm, '')
    .replace(/CREATE INDEX CONCURRENTLY/g, 'CREATE INDEX');
}

/**
 * Aplica una migración en su propia transacción, como la Management API (que
 * envía el archivo entero como una transacción implícita).
 */
export async function aplicarMigracion(db: BaseLocal, archivo: string): Promise<void> {
  try {
    await db.exec(`BEGIN;\n${leerMigracion(archivo)}\nCOMMIT;`);
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw new Error(`[${archivo}] ${(e as Error).message}`);
  }
}

/**
 * Base reconstruida + `migrations/` hasta el número `hasta` (incluido). Las del
 * historial que fallan sobre la base reconstruida se registran y se saltan: el
 * historial se aplicó a mano sobre producción y alguna no es repetible.
 */
export async function aplicarHistorial(
  db: BaseLocal,
  { hasta }: { hasta: string }
): Promise<{ aplicadas: string[]; fallidas: string[] }> {
  await db.exec(readFileSync(join(__dirname, 'historial-base-reconstruida.sql'), 'utf8'));
  const aplicadas: string[] = [];
  const fallidas: string[] = [];
  for (const f of archivosMigraciones()) {
    if (f.slice(0, 3) > hasta) break;
    try {
      await aplicarMigracion(db, f);
      aplicadas.push(f);
    } catch (e) {
      fallidas.push(`${f}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return { aplicadas, fallidas };
}

/**
 * Ejecuta `fn` como lo haría PostgREST para una petición: dentro de una
 * transacción, con el rol de la API y los claims del JWT. Siempre deshace la
 * transacción, así que las escrituras de la prueba no se quedan.
 *
 * `rol = 'anon'` simula la clave anónima (sin `sub`).
 */
export async function comoRol<T>(
  db: BaseLocal,
  rol: 'anon' | 'authenticated' | 'service_role',
  userId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const claims = JSON.stringify(userId ? { sub: userId, role: rol } : { role: rol });
  await db.exec('BEGIN');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await db.exec(`SET LOCAL ROLE ${rol}`);
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

export function comoUsuario<T>(db: BaseLocal, userId: string, fn: () => Promise<T>): Promise<T> {
  return comoRol(db, 'authenticated', userId, fn);
}

export function comoAnonimo<T>(db: BaseLocal, fn: () => Promise<T>): Promise<T> {
  return comoRol(db, 'anon', null, fn);
}
