'use server';

import { createAdminClient } from '@/utils/supabase/server';
import { notifyUsers } from '@/lib/notifications/notify';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { esUuid } from '@/lib/acceso/reglas';
import { contextoAcceso } from '@/lib/acceso/clientes';

type Role = 'superadmin' | 'admin' | 'trafficker' | 'viewer';

const ROLE_HIERARCHY: Record<Role, number> = {
  superadmin: 4,
  admin: 3,
  trafficker: 2,
  viewer: 1,
};

const ROLES_VALIDOS: Role[] = ['superadmin', 'admin', 'trafficker', 'viewer'];

/**
 * Rol actual de otro usuario, o un error. Falla cerrado: si la lectura falla o
 * el perfil no existe NO se supone `viewer` (con un error puntual, un admin
 * habría podido cambiar o borrar a otro admin).
 */
async function rolDeUsuario(
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string
): Promise<{ role: Role } | { error: string }> {
  if (!esUuid(userId)) return { error: 'Usuario no encontrado' };
  const { data, error } = await adminSupabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (error) return { error: `No se pudo leer el usuario: ${error.message}` };
  const role = data?.role as Role | undefined;
  if (!role || !ROLES_VALIDOS.includes(role)) return { error: 'Usuario no encontrado' };
  return { role };
}

/** ¿Existen todos estos clientes? Los ids llegan del navegador. */
async function clientesExisten(
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  clientIds: string[]
): Promise<string | null> {
  if (clientIds.length === 0) return null;
  if (!clientIds.every(esUuid)) return 'Alguno de los clientes elegidos no es válido';
  const { data, error } = await adminSupabase.from('clientes').select('id').in('id', clientIds);
  if (error) return `No se pudieron comprobar los clientes: ${error.message}`;
  if ((data ?? []).length !== new Set(clientIds).size)
    return 'Alguno de los clientes elegidos no existe';
  return null;
}

async function getCurrentUserRole(): Promise<{ userId: string; role: Role } | null> {
  // Sesión y rol memoizados por petición; un rol desconocido cuenta como viewer.
  const ctx = await contextoAcceso();
  return ctx ? { userId: ctx.userId, role: ctx.rol } : null;
}

export async function getUsers() {
  const current = await getCurrentUserRole();
  if (!current || !['superadmin', 'admin'].includes(current.role)) return [];

  const adminSupabase = await createAdminClient();
  const { data: profiles, error: profileError } = await adminSupabase
    .from('user_profiles')
    .select('*')
    .order('updated_at', { ascending: false });

  if (profileError) return [];

  const {
    data: { users: authUsers },
    error: authError,
  } = await adminSupabase.auth.admin.listUsers();
  if (authError) return profiles;

  const mergedUsers = profiles.map((p) => {
    const authUser = authUsers.find((u) => u.id === p.id);
    return { ...p, email: authUser?.email || 'No email' };
  });

  return mergedUsers;
}

export async function updateUserRole(targetUserId: string, newRole: string) {
  const current = await getCurrentUserRole();
  if (!current) return { error: 'No autorizado' };
  // Antes un trafficker pasaba: «no subir a alguien a tu nivel» le dejaba
  // bajar a viewer a cualquiera, también al superadmin.
  if (!['superadmin', 'admin'].includes(current.role)) {
    return { error: 'Sin permisos para cambiar roles' };
  }

  if (!ROLES_VALIDOS.includes(newRole as Role)) return { error: 'Rol inválido' };

  const newRoleLevel = ROLE_HIERARCHY[newRole as Role];
  const currentLevel = ROLE_HIERARCHY[current.role];

  // Only superadmin can assign superadmin role
  if (newRole === 'superadmin' && current.role !== 'superadmin') {
    return { error: 'Solo el superadmin puede asignar el rol de superadmin' };
  }

  // Cannot elevate someone to your own level unless you're superadmin
  if (newRoleLevel >= currentLevel && current.role !== 'superadmin') {
    return { error: 'No puedes asignar un rol igual o superior al tuyo' };
  }

  // Get target user's current role
  const adminSupabase = await createAdminClient();
  const objetivo = await rolDeUsuario(adminSupabase, targetUserId);
  if ('error' in objetivo) return { error: objetivo.error };

  const targetCurrentRole = objetivo.role;
  const targetCurrentLevel = ROLE_HIERARCHY[targetCurrentRole];

  // Admin cannot modify superadmin or other admins
  if (current.role === 'admin' && targetCurrentLevel >= ROLE_HIERARCHY['admin']) {
    return { error: 'No puedes modificar a un admin o superadmin' };
  }

  // Prevent self-demotion
  if (targetUserId === current.userId && newRoleLevel < currentLevel) {
    return { error: 'No puedes reducir tu propio rol' };
  }

  // Solo si el rol sigue siendo el comprobado: si otro lo cambió entretanto,
  // no se pisa una decisión que no se ha evaluado.
  const { data: cambiado, error } = await adminSupabase
    .from('user_profiles')
    .update({ role: newRole, updated_at: new Date().toISOString() })
    .eq('id', targetUserId)
    .eq('role', targetCurrentRole)
    .select('id');

  if (error) return { error: error.message };
  if (!cambiado?.length)
    return { error: 'El rol del usuario cambió; recarga y vuelve a intentarlo' };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function deleteUser(userId: string) {
  const current = await getCurrentUserRole();
  if (!current) return { error: 'No autorizado' };
  if (!['superadmin', 'admin'].includes(current.role))
    return { error: 'Sin permisos para eliminar usuarios' };
  if (current.userId === userId) return { error: 'No puedes eliminarte a ti mismo' };

  const adminSupabase = await createAdminClient();

  // Admins cannot delete other admins or superadmins
  const objetivo = await rolDeUsuario(adminSupabase, userId);
  if ('error' in objetivo) return { error: objetivo.error };

  const targetRole = objetivo.role;
  if (current.role === 'admin' && ROLE_HIERARCHY[targetRole] >= ROLE_HIERARCHY['admin']) {
    return { error: 'No puedes eliminar a un admin o superadmin' };
  }

  // Los clientes son de la empresa, no de quien los creó (migración 098):
  // borrar un usuario no toca ningún cliente ni hay que «pasarlos» a otro. Por
  // cascada solo se van sus datos personales (asignaciones, tokens de API,
  // notificaciones, contactos del agente); sus bitácoras y autorías quedan con
  // el autor a NULL.
  //
  // Primero el usuario: si falla, no queda un usuario sin perfil. El perfil cae
  // con él (FK en cascada); el borrado explícito solo cubre una base sin ella.
  const { error: authError } = await adminSupabase.auth.admin.deleteUser(userId);
  if (authError) return { error: authError.message };
  await adminSupabase.from('user_profiles').delete().eq('id', userId);

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function getClientAssignments(targetUserId: string) {
  const current = await getCurrentUserRole();
  if (!current || !['superadmin', 'admin'].includes(current.role)) return [];

  const adminSupabase = await createAdminClient();
  const { data, error } = await adminSupabase
    .from('user_client_assignments')
    .select('client_id')
    .eq('user_id', targetUserId);

  if (error) return [];
  return data.map((r) => r.client_id);
}

export async function setClientAssignments(targetUserId: string, clientIds: string[]) {
  const current = await getCurrentUserRole();
  if (!current || !['superadmin', 'admin'].includes(current.role)) {
    return { error: 'Sin permisos para asignar clientes' };
  }

  const adminSupabase = await createAdminClient();

  // Un admin no toca las asignaciones de otro admin ni del superadmin.
  const objetivo = await rolDeUsuario(adminSupabase, targetUserId);
  if ('error' in objetivo) return { error: objetivo.error };
  if (current.role === 'admin' && ROLE_HIERARCHY[objetivo.role] >= ROLE_HIERARCHY['admin']) {
    return { error: 'No puedes modificar a un admin o superadmin' };
  }
  const pedidos = [...new Set(clientIds)];
  const invalido = await clientesExisten(adminSupabase, pedidos);
  if (invalido) return { error: invalido };

  // Capture previous assignments so we only notify about newly added clients
  const { data: previous, error: prevError } = await adminSupabase
    .from('user_client_assignments')
    .select('client_id')
    .eq('user_id', targetUserId);
  if (prevError) return { error: prevError.message };
  const previousIds = new Set((previous ?? []).map((r) => r.client_id));

  // Solo la diferencia, y primero lo que se añade: antes se borraban todas y
  // luego se insertaban, y un fallo entre medias dejaba al usuario sin clientes.
  const addedIds = pedidos.filter((id) => !previousIds.has(id));
  const removedIds = [...previousIds].filter((id) => !pedidos.includes(id));

  if (addedIds.length > 0) {
    const rows = addedIds.map((client_id) => ({
      user_id: targetUserId,
      client_id,
      assigned_by: current.userId,
    }));
    const { error } = await adminSupabase.from('user_client_assignments').insert(rows);
    if (error) return { error: error.message };
  }
  if (removedIds.length > 0) {
    const { error } = await adminSupabase
      .from('user_client_assignments')
      .delete()
      .eq('user_id', targetUserId)
      .in('client_id', removedIds);
    if (error) return { error: error.message };
  }

  if (addedIds.length > 0) {
    // after() completa los inserts sin retrasar la respuesta
    after(() => notifyNewAssignments(adminSupabase, targetUserId, addedIds));
  }

  revalidatePath('/admin/configuracion');
  return { success: true };
}

// Notifica al usuario los clientes recién asignados (fire-and-forget)
async function notifyNewAssignments(
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>,
  targetUserId: string,
  clientIds: string[]
) {
  const { data: clientes } = await adminSupabase
    .from('clientes')
    .select('id, nombre')
    .in('id', clientIds);

  for (const cliente of clientes ?? []) {
    await notifyUsers({
      db: adminSupabase,
      type: 'client_assigned',
      severity: 'info',
      clienteId: cliente.id,
      audience: { userIds: [targetUserId] },
      title: `Cliente asignado: ${cliente.nombre}`,
      message: 'Ya puedes ver y gestionar este cliente en tu dashboard.',
      link: `/dashboard/${cliente.id}`,
    });
  }
}

export async function getAllClients() {
  const current = await getCurrentUserRole();
  if (!current || !['superadmin', 'admin'].includes(current.role)) return [];

  const adminSupabase = await createAdminClient();
  const { data, error } = await adminSupabase
    .from('clientes')
    .select('id, nombre')
    .order('nombre', { ascending: true });

  if (error) return [];
  return data;
}

export async function createUser(input: {
  email: string;
  password: string;
  fullName: string;
  role: Role;
  clientIds: string[];
}) {
  const current = await getCurrentUserRole();
  if (!current || !['superadmin', 'admin'].includes(current.role)) {
    return { error: 'Sin permisos para crear usuarios' };
  }

  // El tipo de TypeScript no llega al servidor: el rol se valida aquí.
  if (!ROLES_VALIDOS.includes(input.role)) return { error: 'Rol inválido' };
  // Admin cannot create admins or superadmins
  if (current.role === 'admin' && ['superadmin', 'admin'].includes(input.role)) {
    return { error: 'Solo el superadmin puede crear admins' };
  }

  const adminSupabase = await createAdminClient();
  // Los clientes se comprueban ANTES de crear el usuario: con uno inexistente
  // no se crea nada.
  const clientIds = [...new Set(input.clientIds ?? [])];
  const invalido = await clientesExisten(adminSupabase, clientIds);
  if (invalido) return { error: invalido };

  // 1. Create auth user
  const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });

  if (authError) return { error: authError.message };
  const newUserId = authData.user.id;

  // 2. Create profile (trigger may do this, but upsert to be safe)
  const { error: profileError } = await adminSupabase.from('user_profiles').upsert({
    id: newUserId,
    role: input.role,
    full_name: input.fullName,
    updated_at: new Date().toISOString(),
  });

  if (profileError) {
    // Rollback auth user
    await adminSupabase.auth.admin.deleteUser(newUserId);
    return { error: profileError.message };
  }

  // 3. Assign clients if any
  if (clientIds.length > 0) {
    const rows = clientIds.map((client_id) => ({
      user_id: newUserId,
      client_id,
      assigned_by: current.userId,
    }));
    const { error: assignError } = await adminSupabase.from('user_client_assignments').insert(rows);
    if (assignError) {
      // Antes se ignoraba y se devolvía éxito: quedaba un usuario sin sus
      // clientes. Todo o nada: se deshace el alta (el perfil cae en cascada).
      await adminSupabase.auth.admin.deleteUser(newUserId);
      return { error: `No se pudieron asignar sus clientes: ${assignError.message}` };
    }
    after(() => notifyNewAssignments(adminSupabase, newUserId, clientIds));
  }

  revalidatePath('/admin/configuracion');
  return {
    success: true,
    user: {
      id: newUserId,
      email: input.email,
      role: input.role,
      full_name: input.fullName,
      updated_at: new Date().toISOString(),
    },
  };
}
