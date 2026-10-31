/**
 * Reglas de acceso a un cliente de reporting. PURO: sin base de datos ni red,
 * para poder probarlo entero (scripts/verify-acceso-clientes.ts).
 *
 * Es el mismo criterio que `public.puede_ver_cliente` (migración 075) y
 * `report_utm.clientes_operables` (109), que protegen lo que llega con el JWT
 * del usuario. Esto protege lo que el servidor hace con la service role, que se
 * salta el RLS. Si cambia uno, cambia el otro.
 *
 *   · superadmin/admin ven y operan todos los clientes;
 *   · trafficker/viewer, solo los que tienen asignados;
 *   · operar (escribir) exige trafficker o superior;
 *   · administrar (borrar, credenciales) exige admin o superior.
 */

export type RolApp = 'superadmin' | 'admin' | 'trafficker' | 'viewer';
export type NivelAcceso = 'lectura' | 'operacion' | 'admin';

const ROLES: readonly RolApp[] = ['superadmin', 'admin', 'trafficker', 'viewer'];

/** Ante la duda, el rol menos capaz. */
export function normalizarRol(valor: unknown): RolApp {
  return ROLES.includes(valor as RolApp) ? (valor as RolApp) : 'viewer';
}

export function esRolAdmin(rol: RolApp): boolean {
  return rol === 'superadmin' || rol === 'admin';
}

export function rolPuedeOperar(rol: RolApp): boolean {
  return rol !== 'viewer';
}

export function rolCumpleNivel(rol: RolApp, nivel: NivelAcceso): boolean {
  if (nivel === 'admin') return esRolAdmin(rol);
  if (nivel === 'operacion') return rolPuedeOperar(rol);
  return true;
}

export type Decision = { ok: true } | { ok: false; status: 401 | 403 | 404; motivo: string };

export function decidirAccesoCliente(e: {
  /** null = sin sesión. */
  userId: string | null;
  rol: RolApp;
  /** ¿Existe el cliente? */
  clienteExiste: boolean;
  /** ¿Tiene el usuario una asignación a este cliente? */
  asignado: boolean;
  nivel: NivelAcceso;
}): Decision {
  if (!e.userId) return { ok: false, status: 401, motivo: 'Sin sesión' };
  if (!e.clienteExiste) return { ok: false, status: 404, motivo: 'Cliente no encontrado' };
  // 404 y no 403: a quien no lo tiene asignado ni se le confirma que existe.
  if (!esRolAdmin(e.rol) && !e.asignado) {
    return { ok: false, status: 404, motivo: 'Cliente no encontrado' };
  }
  if (!rolCumpleNivel(e.rol, e.nivel)) {
    return { ok: false, status: 403, motivo: 'Tu rol no permite esta acción en el cliente' };
  }
  return { ok: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ¿Es un uuid? Los ids de cliente se interpolan en filtros `or(...)` de
 * PostgREST en varios sitios: validar la forma cierra cualquier inyección de
 * condiciones por esa vía.
 */
export function esUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}
