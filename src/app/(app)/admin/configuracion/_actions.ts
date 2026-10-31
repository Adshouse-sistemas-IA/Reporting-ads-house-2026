'use server';

import { createClient, createAdminClient } from '@/utils/supabase/server';
import { revalidatePath, updateTag } from 'next/cache';
import {
  cumpleCondicion,
  evaluateAlertRules,
  medirRegla,
  type RuleRow,
} from '@/lib/notifications/rules-engine';
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils';
import { format, subDays, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import { parseTabFilter, type AnyCampaignFilter } from '@/lib/campaign-filter';
import { BRANDING_CACHE_TAG } from '@/lib/branding';
import {
  exigirAccesoCliente,
  exigirAjustePlataforma,
  exigirSesion,
  intentarGuarda,
} from '@/lib/acceso/clientes';

/**
 * Las reglas de alerta las gestiona un admin. Todo va con la service role, así
 * que la guarda es la única barrera.
 */
const requireAdmin = () => intentarGuarda(() => exigirSesion('admin'));

/** El cliente de una regla tiene que existir y la pestaña ser de ese cliente. */
async function validarDestinoRegla(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  clienteId: string | null | undefined,
  tabId: string | null | undefined
): Promise<string | null> {
  if (clienteId) {
    const acceso = await intentarGuarda(() => exigirAccesoCliente(clienteId, 'admin'));
    if (!acceso.ok) return acceso.error;
  }
  if (tabId) {
    const { data: tab, error } = await db
      .from('cliente_tabs')
      .select('cliente_id')
      .eq('id', tabId)
      .maybeSingle();
    if (error) return error.message;
    const t = tab as { cliente_id: string } | null;
    if (!t) return 'Pestaña no encontrada';
    if (clienteId && t.cliente_id !== clienteId) return 'La pestaña no es de ese cliente';
  }
  return null;
}

// ── Rules CRUD ──────────────────────────────────────────────────────────────

export async function getNotificationRules() {
  const guard = await requireAdmin();
  if (!guard.ok) throw new Error(guard.error);

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('notification_rules')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data as RuleRow[];
}

export async function createNotificationRule(
  payload: Omit<RuleRow, 'id' | 'created_at' | 'updated_at' | 'last_triggered_at'>
) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const invalido = await validarDestinoRegla(supabase, payload.cliente_id, payload.tab_id);
  if (invalido) return { error: invalido };
  const { error } = await supabase.from('notification_rules').insert({
    cliente_id: payload.cliente_id || null,
    tab_id: payload.tab_id || null,
    nombre: payload.nombre,
    metric: payload.metric,
    operator: payload.operator,
    value: payload.value,
    time_window: payload.time_window,
    channels: payload.channels,
    cooldown_hours: payload.cooldown_hours,
    enabled: payload.enabled,
  });

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function updateNotificationRule(
  id: string,
  payload: Partial<Omit<RuleRow, 'id' | 'created_at' | 'updated_at'>>
) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  // Un nuevo destino se valida.
  const cambios = payload;
  if ('cliente_id' in cambios || 'tab_id' in cambios) {
    const { data: actual, error: e } = await supabase
      .from('notification_rules')
      .select('cliente_id, tab_id')
      .eq('id', id)
      .maybeSingle();
    if (e) return { error: e.message };
    if (!actual) return { error: 'Regla no encontrada' };
    const a = actual as { cliente_id: string | null; tab_id: string | null };
    const invalido = await validarDestinoRegla(
      supabase,
      'cliente_id' in cambios ? cambios.cliente_id : a.cliente_id,
      'tab_id' in cambios ? cambios.tab_id : a.tab_id
    );
    if (invalido) return { error: invalido };
  }
  const { error } = await supabase.from('notification_rules').update(cambios).eq('id', id);

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function deleteNotificationRule(id: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('notification_rules').delete().eq('id', id);

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

// ── Dropdowns Helpers ────────────────────────────────────────────────────────

export async function getClientesAndTabs() {
  const guard = await requireAdmin();
  if (!guard.ok) throw new Error(guard.error);

  const supabase = await createAdminClient();

  const { data: clientes, error: ec } = await supabase
    .from('clientes')
    .select('id, nombre')
    .order('nombre');
  if (ec) throw new Error(ec.message);

  const { data: tabs, error: et } = await supabase
    .from('cliente_tabs')
    .select(
      'id, nombre, cliente_id, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion'
    )
    .eq('archived', false)
    .order('nombre');
  if (et) throw new Error(et.message);

  return {
    clientes: clientes ?? [],
    tabs: tabs ?? [],
  };
}

// ── Manual Evaluation / Test Action ──────────────────────────────────────────

export async function triggerRulesEvaluation() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  try {
    const supabase = await createAdminClient();
    // force: evalúa y envía notificaciones reales ignorando el cooldown (y sin
    // escribirlo), para verificar la entrega a los grupos sin afectar la
    // corrida automática nocturna.
    const result = await evaluateAlertRules(supabase, { force: true });
    revalidatePath('/admin/configuracion');
    return { success: true, ...result };
  } catch (err: any) {
    return { error: err.message || 'Error evaluando reglas' };
  }
}

export async function testRule(ruleId: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  try {
    const db = await createAdminClient();

    // 1. Fetch the rule
    const { data: rule, error: ruleError } = await db
      .from('notification_rules')
      .select('*')
      .eq('id', ruleId)
      .single();

    if (ruleError || !rule) {
      return { error: ruleError?.message || 'Regla no encontrada' };
    }

    const { cliente_id, tab_id, metric, operator, value, time_window } = rule;

    // Get target client ID(s)
    let targetClientIds: string[] = [];
    if (cliente_id) {
      targetClientIds = [cliente_id];
    } else {
      const { data: clients } = await db.from('clientes').select('id');
      targetClientIds = (clients ?? []).map((c) => c.id);
    }

    if (targetClientIds.length === 0) {
      return { error: 'No hay clientes para evaluar' };
    }

    // Evaluate for the first client (in test we evaluate just one client as a sample)
    const testClientId = targetClientIds[0];

    const { data: clientObj } = await db
      .from('clientes')
      .select('nombre')
      .eq('id', testClientId)
      .single();
    const clientName = clientObj?.nombre || 'Cliente';

    // Date range
    const today = colombiaToday();
    const yesterday = colombiaYesterday();
    let start = today;
    let end = today;

    if (time_window === 'yesterday') {
      start = yesterday;
      end = yesterday;
    } else if (time_window === 'last_7_days') {
      start = format(subDays(parseISO(today), 6), 'yyyy-MM-dd');
    } else if (time_window === 'last_30_days') {
      start = format(subDays(parseISO(today), 29), 'yyyy-MM-dd');
    } else if (time_window === 'current_tab_period' && tab_id) {
      const { data: tab } = await db
        .from('cliente_tabs')
        .select('fecha_inicio, fecha_finalizacion')
        .eq('id', tab_id)
        .single();
      if (tab?.fecha_inicio && tab?.fecha_finalizacion) {
        start = tab.fecha_inicio;
        end = tab.fecha_finalizacion;
      } else {
        start = format(startOfMonth(new Date()), 'yyyy-MM-dd');
        end = format(endOfMonth(new Date()), 'yyyy-MM-dd');
      }
    } else if (time_window === 'custom_range') {
      start = (rule as any).custom_start || format(startOfMonth(new Date()), 'yyyy-MM-dd');
      end = (rule as any).custom_end || format(endOfMonth(new Date()), 'yyyy-MM-dd');
    }

    // Tab info
    let keywordFilter: AnyCampaignFilter = '';
    let tabBudget: number | null = null;
    let tabName = '';

    if (tab_id) {
      const { data: tab } = await db
        .from('cliente_tabs')
        .select('nombre, keyword_meta, presupuesto_objetivo')
        .eq('id', tab_id)
        .single();
      if (tab) {
        keywordFilter = parseTabFilter(tab.keyword_meta);
        tabBudget = tab.presupuesto_objetivo ? Number(tab.presupuesto_objetivo) : null;
        tabName = tab.nombre;
      }
    }

    // Groups
    const { data: campaignGroups } = await db
      .from('campaign_groups')
      .select('id, nombre, campaign_group_mappings(campaign_id, campaign_name_pattern)')
      .eq('cliente_id', testClientId);

    // La MISMA medición que la evaluación real (`medirRegla`): ingresos de
    // Hotmart convertidos a la moneda del gasto, con downsell y sin sumar
    // `VENTAS_CERRADAS`, que es un conteo.
    const medida = await medirRegla(db, {
      clientId: testClientId,
      metric,
      start,
      end,
      keywordFilter,
      campaignGroups: campaignGroups ?? [],
      tabBudget,
      clientName,
    });
    const { totalSpend, totalRevenue, totalLeads, moneda, diasSinTasa } = medida;
    // Sin presupuesto la evaluación real se salta la pestaña; aquí se enseña 0 %
    // con el aviso de abajo.
    const actualValue = medida.actualValue ?? 0;

    // Evaluate
    const threshold = Number(value);
    const isTriggered =
      medida.actualValue !== null && cumpleCondicion(actualValue, operator, threshold);

    return {
      success: true,
      clientName,
      tabName,
      metric,
      operator,
      threshold,
      actualValue,
      isTriggered,
      start,
      end,
      totalSpend,
      totalRevenue,
      totalLeads,
      tabBudget,
      moneda,
      diasSinTasa,
      budgetWarning:
        metric === 'budget_percentage' && (!tabBudget || tabBudget <= 0)
          ? 'Esta pestaña no tiene un Presupuesto Objetivo configurado. Ve a Ajustes de Sistema → Pestañas del cliente para configurarlo.'
          : null,
    };
  } catch (err: any) {
    return { error: err.message || 'Error al probar regla' };
  }
}

// La marca es de toda la instalación: la cambia el propietario.
const requireSuperAdmin = () => intentarGuarda(() => exigirAjustePlataforma('superadmin'));

export async function getBrandingSettings() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'branding')
    .maybeSingle();

  if (error) {
    console.error('Error fetching branding settings:', error);
    return null;
  }
  return data?.value || null;
}

export async function updateBrandingSettings(brandingValue: {
  logo_url: string;
  favicon_url?: string;
  app_name?: string;
  app_tag?: string;
  utm_name?: string;
  utm_tag?: string;
  colors: { primary: string; secondary: string };
}) {
  const guard = await requireSuperAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('system_settings').upsert({
    key: 'branding',
    value: brandingValue,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error('Error updating branding settings:', error);
    return { error: error.message };
  }

  // El branding va cacheado (`lib/branding.ts`): sin invalidar la etiqueta, el
  // cambio no se vería hasta que expirase el revalidate de 5 min. `updateTag`
  // y no `revalidateTag` porque esto es una server action y el admin tiene que
  // ver su propio cambio en la siguiente petición, sin stale-while-revalidate.
  updateTag(BRANDING_CACHE_TAG);
  revalidatePath('/', 'layout');
  return { success: true };
}
