'use server';

import { createAdminClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';
import * as gateway from '@/lib/whatsapp/gateway';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/whatsapp/types';
import { exigirAccesoCliente, exigirAjustePlataforma, intentarGuarda } from '@/lib/acceso/clientes';

/**
 * WhatsApp es UN número para toda la instalación (`whatsapp_session`) y sus
 * grupos son de ese número: todo este panel es ajuste de plataforma (admin).
 *
 * Las lecturas también llevan guarda: una server action se puede invocar por
 * POST aunque la página no se muestre.
 */
const requireAdmin = () => intentarGuarda(() => exigirAjustePlataforma('admin'));

// ── Estado de conexión / QR ──────────────────────────────────────
export async function getWhatsAppStatus() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };
  try {
    const status = await gateway.getStatus();
    return { status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }
}

export async function getWhatsAppQr() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };
  try {
    return await gateway.getQr();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }
}

// ── Grupos ───────────────────────────────────────────────────────
export async function syncGroups() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  let groups;
  try {
    groups = await gateway.listGroups();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }

  const admin = await createAdminClient();
  const rows = groups.map((g) => ({
    group_id: g.id,
    group_name: g.name,
    synced_at: new Date().toISOString(),
  }));
  if (rows.length > 0) {
    const { error } = await admin.from('whatsapp_groups').upsert(rows, { onConflict: 'group_id' });
    if (error) return { error: error.message };
  }

  revalidatePath('/admin/configuracion');
  return { success: true, count: rows.length };
}

export async function getGroups() {
  const guard = await requireAdmin();
  if (!guard.ok) return [];
  const admin = await createAdminClient();
  const { data } = await admin
    .from('whatsapp_groups')
    .select('id, group_id, group_name, enabled')
    .order('group_name');
  return data ?? [];
}

// ── Clientes (lista mínima para el selector de rutas) ────────────
export async function getClientesMin() {
  const guard = await requireAdmin();
  if (!guard.ok) return [];
  const admin = await createAdminClient();
  const { data, error } = await admin.from('clientes').select('id, nombre').order('nombre');
  if (error) throw new Error(`[whatsapp] clientes: ${error.message}`);
  return data ?? [];
}

// ── Rutas ────────────────────────────────────────────────────────
export async function getRoutes() {
  const guard = await requireAdmin();
  if (!guard.ok) return [];
  const admin = await createAdminClient();
  const { data, error } = await admin
    .from('whatsapp_routes')
    .select(
      'id, cliente_id, notification_type, group_id, enabled, cliente:clientes(nombre), grupo:whatsapp_groups(group_name)'
    )
    .order('created_at', { ascending: false });
  if (error) throw new Error(`[whatsapp] rutas: ${error.message}`);
  return data ?? [];
}

export async function upsertRoute(input: {
  clienteId: string | null;
  notificationType: string;
  groupId: string;
}) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!NOTIFICATION_TYPES.includes(input.notificationType as NotificationType)) {
    return { error: 'Tipo de notificación inválido' };
  }
  if (!input.groupId) return { error: 'Grupo requerido' };
  if (input.clienteId) {
    const acceso = await intentarGuarda(() => exigirAccesoCliente(input.clienteId!, 'admin'));
    if (!acceso.ok) return { error: acceso.error };
  }

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').insert({
    cliente_id: input.clienteId,
    notification_type: input.notificationType,
    group_id: input.groupId,
    enabled: true,
  });
  if (error) {
    // 23505 = unique_violation (ruta ya existe)
    if (error.code === '23505') return { error: 'Esa ruta ya existe' };
    return { error: error.message };
  }

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function setRouteEnabled(routeId: string, enabled: boolean) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').update({ enabled }).eq('id', routeId);
  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function deleteRoute(routeId: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').delete().eq('id', routeId);
  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

// ── Envío manual ─────────────────────────────────────────────────
export async function sendManualWhatsApp(input: { clienteId: string | null; message: string }) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!input.message.trim()) return { error: 'El mensaje no puede estar vacío' };
  if (input.clienteId) {
    const acceso = await intentarGuarda(() => exigirAccesoCliente(input.clienteId!, 'admin'));
    if (!acceso.ok) return { error: acceso.error };
  }

  const admin = await createAdminClient();
  const result = await sendWhatsAppNotification({
    db: admin,
    clienteId: input.clienteId,
    notificationType: 'manual',
    message: input.message.trim(),
  });

  revalidatePath('/admin/configuracion');
  if (result.skipped) {
    return { error: 'No hay ningún grupo ruteado para "Envío manual" (ni del cliente ni global)' };
  }
  return { success: true, sent: result.sent, failed: result.failed };
}

// ── Grupo general fijo del equipo (alertas) ──────────────────────
const ALERT_TEAM_GROUP_KEY = 'whatsapp_alert_team_group';

export async function getAlertTeamGroup(): Promise<{
  group_id: string | null;
  enabled: boolean;
}> {
  const guard = await requireAdmin();
  if (!guard.ok) return { group_id: null, enabled: false };
  const admin = await createAdminClient();
  const { data } = await admin
    .from('system_settings')
    .select('value')
    .eq('key', ALERT_TEAM_GROUP_KEY)
    .maybeSingle();

  const value = (data?.value ?? null) as { group_id?: string | null; enabled?: boolean } | null;
  return {
    group_id: value?.group_id ?? null,
    enabled: value?.enabled ?? false,
  };
}

export async function setAlertTeamGroup(input: { groupId: string | null; enabled: boolean }) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('system_settings').upsert({
    key: ALERT_TEAM_GROUP_KEY,
    value: { group_id: input.groupId, enabled: input.enabled },
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

// ── Log reciente ─────────────────────────────────────────────────
export async function getRecentMessages() {
  const guard = await requireAdmin();
  if (!guard.ok) return [];
  const admin = await createAdminClient();
  const { data, error } = await admin
    .from('whatsapp_messages')
    .select(
      'id, cliente_id, notification_type, group_id, message, status, error, created_at, cliente:clientes(nombre)'
    )
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`[whatsapp] mensajes: ${error.message}`);
  return data ?? [];
}
