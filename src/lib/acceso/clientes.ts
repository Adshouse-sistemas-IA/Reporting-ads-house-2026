import 'server-only';
import { cache } from 'react';
import { createAdminClient } from '@/utils/supabase/server';
import { getSesionActual } from '@/lib/auth-session';
import {
  decidirAccesoCliente,
  esRolAdmin,
  esUuid,
  normalizarRol,
  rolCumpleNivel,
  type NivelAcceso,
  type RolApp,
} from './reglas';

/**
 * Autorización del servidor por cliente.
 *
 * El servidor lee y escribe con la service role, que se salta el RLS. Hasta
 * ahora muchas server actions y rutas de API recibían un id de cliente y lo
 * usaban sin comprobar quién llamaba: cualquier sesión —también la de un
 * usuario recién registrado en /signup— podía leer o modificar cualquier
 * cliente. Toda acción o ruta que reciba un id de cliente empieza por
 * `exigirAccesoCliente` (o su variante UTM); `verify-acceso-clientes.ts` lo
 * comprueba en el código fuente.
 *
 * Errores: lanzan `AccesoDenegado` (status 401/403/404). Las rutas de API lo
 * convierten con `respuestaAccesoDenegado`; en una server action basta con que
 * lance (el usuario legítimo nunca lo ve).
 */

export class AccesoDenegado extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    message: string
  ) {
    super(message);
    this.name = 'AccesoDenegado';
  }
}

export type ContextoAcceso = {
  userId: string;
  rol: RolApp;
};

/** Usuario y rol de la petición, una vez por petición. */
export const contextoAcceso = cache(async (): Promise<ContextoAcceso | null> => {
  const sesion = await getSesionActual();
  if (!sesion.userId) return null;
  return { userId: sesion.userId, rol: normalizarRol(sesion.role) };
});

/**
 * Exige sesión y un rol con al menos `nivel`. Para acciones que no son de un
 * cliente (plantillas, usuarios, alertas).
 */
export async function exigirSesion(nivel: NivelAcceso = 'lectura'): Promise<ContextoAcceso> {
  const ctx = await contextoAcceso();
  if (!ctx) throw new AccesoDenegado(401, 'Sin sesión');
  if (!rolCumpleNivel(ctx.rol, nivel))
    throw new AccesoDenegado(403, 'Tu rol no permite esta acción');
  return ctx;
}

async function decidir(clienteId: string, nivel: NivelAcceso): Promise<ContextoAcceso> {
  const ctx = await contextoAcceso();
  if (!ctx) throw new AccesoDenegado(401, 'Sin sesión');
  if (!esUuid(clienteId)) throw new AccesoDenegado(404, 'Cliente no encontrado');
  const db = await createAdminClient();
  const [cliente, asignacion] = await Promise.all([
    db.from('clientes').select('id').eq('id', clienteId).maybeSingle(),
    esRolAdmin(ctx.rol)
      ? Promise.resolve({ data: null, error: null })
      : db
          .from('user_client_assignments')
          .select('id')
          .eq('user_id', ctx.userId)
          .eq('client_id', clienteId)
          .maybeSingle(),
  ]);
  // Fallar cerrado: sin poder leer el cliente o la asignación no se concede nada.
  if (cliente.error) throw new Error(`[acceso] cliente ${clienteId}: ${cliente.error.message}`);
  if (asignacion.error) throw new Error(`[acceso] asignación: ${asignacion.error.message}`);
  const d = decidirAccesoCliente({
    userId: ctx.userId,
    rol: ctx.rol,
    clienteExiste: !!cliente.data,
    asignado: !!asignacion.data,
    nivel,
  });
  if (!d.ok) throw new AccesoDenegado(d.status, d.motivo);
  return ctx;
}

/** Exige poder acceder (`nivel`) al cliente `clienteId` de public.clientes. */
export async function exigirAccesoCliente(
  clienteId: string,
  nivel: NivelAcceso = 'lectura'
): Promise<ContextoAcceso> {
  return decidir(clienteId, nivel);
}

/** Id de public.clientes del espejo de report_utm, o null (huérfano o inexistente). */
export async function clientePublicoDeUtm(clienteUtmId: string): Promise<string | null> {
  if (!esUuid(clienteUtmId)) return null;
  const db = await createAdminClient();
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('public_cliente_id')
    .eq('id', clienteUtmId)
    .maybeSingle();
  if (error) throw new Error(`[acceso] espejo UTM ${clienteUtmId}: ${error.message}`);
  return (data as { public_cliente_id?: string | null } | null)?.public_cliente_id ?? null;
}

/**
 * Igual que `exigirAccesoCliente`, con el id de report_utm.clientes (leads,
 * ventas, informes BI). Un espejo huérfano (sin cliente del reporting) no tiene
 * asignaciones posibles: nadie accede por esta vía, como en la 109.
 */
export async function exigirAccesoClienteUtm(
  clienteUtmId: string,
  nivel: NivelAcceso = 'lectura'
): Promise<ContextoAcceso & { clientePublicoId: string }> {
  const ctx = await contextoAcceso();
  if (!ctx) throw new AccesoDenegado(401, 'Sin sesión');
  const publico = await clientePublicoDeUtm(clienteUtmId);
  if (!publico) throw new AccesoDenegado(404, 'Cliente no encontrado');
  await decidir(publico, nivel);
  return { ...ctx, clientePublicoId: publico };
}

/**
 * Para lecturas que también usa el espejo público `/p/<token>` desde el
 * navegador: vale una sesión con acceso o el token público de ese mismo
 * cliente (de cliente o de una de sus pestañas).
 */
export async function exigirAccesoClienteOToken(
  clienteId: string,
  tokenPublico: string | null | undefined
): Promise<void> {
  if (tokenPublico) {
    if (!esUuid(clienteId) || !esUuid(tokenPublico))
      throw new AccesoDenegado(404, 'Cliente no encontrado');
    const db = await createAdminClient();
    const [c, t] = await Promise.all([
      db
        .from('clientes')
        .select('id')
        .eq('id', clienteId)
        .eq('public_token', tokenPublico)
        .maybeSingle(),
      db
        .from('cliente_tabs')
        .select('id')
        .eq('cliente_id', clienteId)
        .eq('public_token', tokenPublico)
        .maybeSingle(),
    ]);
    if (c.error || t.error)
      throw new Error(`[acceso] token público: ${(c.error ?? t.error)!.message}`);
    if (c.data || t.data) return;
    throw new AccesoDenegado(404, 'Cliente no encontrado');
  }
  await decidir(clienteId, 'lectura');
}

/**
 * Ids de los clientes que el usuario puede ver, SIEMPRE como lista explícita:
 * los admin, todos; el resto, sus asignados. Nunca «todos» a secas.
 */
export async function clientesVisiblesDeUsuario(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
  rol: RolApp
): Promise<string[]> {
  if (esRolAdmin(rol)) {
    const { data, error } = await db.from('clientes').select('id');
    if (error) throw new Error(`[acceso] clientes: ${error.message}`);
    return ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
  }
  const { data: asign, error: ea } = await db
    .from('user_client_assignments')
    .select('client_id')
    .eq('user_id', userId);
  if (ea) throw new Error(`[acceso] asignaciones: ${ea.message}`);
  return [...new Set(((asign ?? []) as Array<{ client_id: string }>).map((a) => a.client_id))];
}

/** Respuesta JSON de una ruta de API ante `AccesoDenegado`; relanza lo demás. */
export function respuestaAccesoDenegado(e: unknown): Response {
  if (e instanceof AccesoDenegado) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  throw e;
}

/**
 * Consultas sin cliente («todos los clientes»): el motor BI y algunas rutas
 * agregan entonces TODA la base. Solo se permiten a un admin, que es quien ve
 * todos los clientes.
 */
export async function exigirConsultaGlobal(): Promise<ContextoAcceso> {
  return exigirSesion('admin');
}

/**
 * Configuración de toda la instalación, no de un cliente: la marca, los
 * modelos del agente, el catálogo de estrategias, el número y los grupos de
 * WhatsApp y los remitentes que ve. Exige admin (o superadmin si se pide).
 */
export async function exigirAjustePlataforma(
  nivel: 'admin' | 'superadmin' = 'admin'
): Promise<ContextoAcceso> {
  const ctx = await exigirSesion('admin');
  if (nivel === 'superadmin' && ctx.rol !== 'superadmin') {
    throw new AccesoDenegado(403, 'Solo el propietario puede cambiar esto');
  }
  return ctx;
}

/**
 * Convierte una guarda que lanza `AccesoDenegado` en el contrato de las server
 * actions de administración (`{ ok: false, error }`). Cualquier otro error se
 * propaga: no es una denegación y no debe disfrazarse de una.
 */
export async function intentarGuarda<T>(
  guarda: () => Promise<T>
): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await guarda()) };
  } catch (e) {
    if (e instanceof AccesoDenegado) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Para rutas de API: ejecuta la guarda y devuelve la respuesta de error, o
 * null si puede seguir.
 *
 *   const denegado = await guardaRuta(() => exigirAccesoClienteUtm(id, 'lectura'));
 *   if (denegado) return denegado;
 */
export async function guardaRuta(guarda: () => Promise<unknown>): Promise<Response | null> {
  try {
    await guarda();
    return null;
  } catch (e) {
    return respuestaAccesoDenegado(e);
  }
}

/** Con cliente (id de report_utm): acceso a ese cliente. Sin cliente: consulta global. */
export async function exigirClienteUtmOGlobal(
  clienteUtmId: string | null | undefined,
  nivel: NivelAcceso = 'lectura'
): Promise<void> {
  if (clienteUtmId) await exigirAccesoClienteUtm(clienteUtmId, nivel);
  else await exigirConsultaGlobal();
}

/** Ids de report_utm.clientes de los clientes visibles del usuario de la petición. */
export async function clientesUtmVisibles(): Promise<{ ctx: ContextoAcceso; ids: string[] }> {
  const ctx = await exigirSesion();
  const db = await createAdminClient();
  const publicos = await clientesVisiblesDeUsuario(db, ctx.userId, ctx.rol);
  if (publicos.length === 0) return { ctx, ids: [] };
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .in('public_cliente_id', publicos);
  if (error) throw new Error(`[acceso] espejos UTM: ${error.message}`);
  return { ctx, ids: ((data ?? []) as Array<{ id: string }>).map((c) => c.id) };
}

export type InformeAcceso = {
  id: string;
  cliente_id: string | null;
  created_by: string | null;
  is_template: boolean | null;
};

/**
 * Exige acceso a un informe BI. Con cliente, el del cliente. Sin cliente es una
 * plantilla: la lee cualquier sesión; modificarla exige el nivel pedido.
 */
export async function exigirAccesoInforme(
  reportId: string,
  nivel: NivelAcceso = 'lectura'
): Promise<InformeAcceso> {
  const ctx = await contextoAcceso();
  if (!ctx) throw new AccesoDenegado(401, 'Sin sesión');
  if (!esUuid(reportId)) throw new AccesoDenegado(404, 'Informe no encontrado');
  const db = await createAdminClient();
  const { data, error } = await db
    .from('bi_reports')
    .select('id, cliente_id, created_by, is_template')
    .eq('id', reportId)
    .maybeSingle();
  if (error) throw new Error(`[acceso] informe ${reportId}: ${error.message}`);
  if (!data) throw new AccesoDenegado(404, 'Informe no encontrado');
  const inf = data as InformeAcceso;
  if (inf.cliente_id) {
    await exigirAccesoClienteUtm(inf.cliente_id, nivel);
    return inf;
  }
  await exigirSesion(nivel);
  return inf;
}

/** Para páginas: el contexto si puede acceder, o null para redirigir (sin lanzar). */
export async function accesoClienteONull(
  clienteId: string,
  nivel: NivelAcceso = 'lectura'
): Promise<ContextoAcceso | null> {
  try {
    return await exigirAccesoCliente(clienteId, nivel);
  } catch (e) {
    if (e instanceof AccesoDenegado) return null;
    throw e;
  }
}
