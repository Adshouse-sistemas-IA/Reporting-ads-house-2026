import Link from 'next/link';
import { getClientes, getActiveAlerts, type ActiveAlert } from '../admin/settings/_actions';
import { getAllSoporteTickets } from './_actions';
import {
  BarChart3,
  ArrowRight,
  Users,
  Zap,
  Settings,
  Sliders,
  TrendingUp,
  Globe,
  ChevronRight,
  AlertTriangle,
  Bell,
  Headphones,
} from 'lucide-react';

export default async function DashboardHomePage() {
  const [todosLosClientes, activeAlerts, soporteResult] = await Promise.all([
    getClientes(),
    getActiveAlerts(),
    getAllSoporteTickets(),
  ]);
  // Archivar un cliente es dejar de verlo en el día a día sin perder su
  // historia: sigue en Ajustes, pero no en la grilla ni en los contadores.
  const clientes = (todosLosClientes ?? []).filter((c: any) => !c.archivado);

  // Las conexiones salen de `conexiones` (calculado en el servidor por
  // `flagsConexion`), no de `config_api`: el listado llega ya saneado, sin
  // credenciales, y mirar ahí daba Meta, Hotmart y GA4 siempre desconectados.
  const totalClientes = clientes?.length ?? 0;
  const totalIntegrations = (clientes ?? []).reduce((acc: number, c: any) => {
    let n = 0;
    if (c.conexiones?.meta) n++;
    if (c.conexiones?.hotmart) n++;
    if (c.conexiones?.ga) n++;
    return acc + n;
  }, 0);
  const activePlatforms = new Set<string>();
  (clientes ?? []).forEach((c: any) => {
    if (c.conexiones?.meta) activePlatforms.add('meta');
    if (c.conexiones?.hotmart) activePlatforms.add('hotmart');
    if (c.conexiones?.ga) activePlatforms.add('ga4');
  });

  return (
    <div className="space-y-8">
      {/* ── Cabecera ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Resumen general</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalClientes} {totalClientes === 1 ? 'cliente activo' : 'clientes activos'} ·{' '}
            {totalIntegrations} integraciones conectadas
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <AccesoRapido
            href="/informes"
            icon={<TrendingUp className="h-4 w-4" />}
            label="Informes"
          />
          <AccesoRapido href="/leads" icon={<BarChart3 className="h-4 w-4" />} label="Leads" />
          <AccesoRapido
            href="/admin/configuracion"
            icon={<Sliders className="h-4 w-4" />}
            label="Alertas"
          />
          <AccesoRapido
            href="/admin/settings"
            icon={<Settings className="h-4 w-4" />}
            label="Clientes y conexiones"
          />
        </div>
      </div>

      {/* ── Lo urgente primero ── */}
      {activeAlerts.length > 0 && <AlertsPanel alerts={activeAlerts} />}

      {/* ── Cifras ── */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Clientes activos"
          value={totalClientes}
        />
        <StatCard
          icon={<Zap className="h-4 w-4" />}
          label="Integraciones activas"
          value={totalIntegrations}
        />
        <StatCard
          icon={<Globe className="h-4 w-4" />}
          label="Plataformas conectadas"
          value={activePlatforms.size}
          suffix="/ 3"
        />
        <StatCard
          icon={<Bell className="h-4 w-4" />}
          label="Alertas activas"
          value={activeAlerts.length}
          alerta={activeAlerts.length > 0}
        />
      </div>

      {/* ── Clientes ── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-foreground">Clientes</h2>
          <span className="text-xs text-muted-foreground">Abre un cliente para ver su embudo</span>
        </div>

        {!clientes || clientes.length === 0 ? (
          <EmptyClients />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {clientes.map((cliente: any) => (
              <ClientRow key={cliente.id} cliente={cliente} />
            ))}
          </ul>
        )}
      </section>

      {/* ── Soporte Ads House ── */}
      <SoportePanel tickets={soporteResult.data ?? []} />
    </div>
  );
}

/* ─── Sub-components ────────────────────────────────────────────────────────── */

function StatCard({
  icon,
  label,
  value,
  suffix,
  alerta,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  alerta?: boolean;
}) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <span className={alerta ? 'text-bad' : ''}>{icon}</span>
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${alerta ? 'text-bad' : 'text-foreground'}`}
      >
        {value}
        {suffix && (
          <span className="ml-1 text-base font-normal text-muted-foreground">{suffix}</span>
        )}
      </p>
    </div>
  );
}

function ClientRow({ cliente }: { cliente: any }) {
  const hasMeta = !!cliente.conexiones?.meta;
  const hasHotmart = !!cliente.conexiones?.hotmart;
  const hasGA4 = !!cliente.conexiones?.ga;
  const iniciales = String(cliente.nombre ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p: string) => p[0])
    .join('')
    .toUpperCase();

  return (
    <li>
      <a
        href={`/dashboard/${cliente.id}`}
        className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs font-semibold text-primary dark:text-brand-blue-light">
          {iniciales}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {cliente.nombre}
        </span>
        <span className="flex flex-wrap gap-1.5">
          <IntegrationBadge active={hasMeta} label="Meta" />
          <IntegrationBadge active={hasHotmart} label="Hotmart" />
          <IntegrationBadge active={hasGA4} label="GA4" />
        </span>
        <span className="flex items-center gap-1 text-sm font-medium text-primary dark:text-brand-blue-light">
          Abrir
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </a>
    </li>
  );
}

function IntegrationBadge({ active, label }: { active: boolean; label: string }) {
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-good-soft px-2 py-0.5 text-xs font-medium text-good">
      <span className="h-1.5 w-1.5 rounded-full bg-good" />
      {label}
    </span>
  );
}

function EmptyClients() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted">
        <Users className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="font-medium text-foreground/90">Sin clientes activos</p>
      <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
        Ve a{' '}
        <Link
          href="/admin/settings"
          className="text-brand-blue dark:text-brand-blue-light underline underline-offset-2 hover:text-brand-blue"
        >
          Ajustes de Sistema
        </Link>{' '}
        para agregar tu primer cliente.
      </p>
    </div>
  );
}

function AlertsPanel({ alerts }: { alerts: ActiveAlert[] }) {
  const critical = alerts.filter((a) => a.level === 100).length;
  const warning = alerts.filter((a) => a.level === 90).length;

  return (
    <a
      href="/notificaciones?type=alert_threshold"
      className="group flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-3.5 transition-colors hover:bg-accent"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15">
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-foreground">Alertas de presupuesto:</span>
        {critical > 0 && (
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
            {critical} crítica{critical !== 1 ? 's' : ''}
          </span>
        )}
        {warning > 0 && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            {warning} advertencia{warning !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-blue dark:text-brand-blue-light">
        Ver detalle
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </a>
  );
}

function AccesoRapido({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </Link>
  );
}

/* ─── Soporte Panel ──────────────────────────────────────────────────────────── */

function SoportePanel({ tickets }: { tickets: any[] }) {
  const total = tickets.length;
  const abiertos = tickets.filter((t) => t.estado === 'abierto').length;
  const enProgreso = tickets.filter((t) => t.estado === 'en_progreso').length;
  const completados = tickets.filter((t) => t.estado === 'completado').length;
  const urgentes = tickets.filter((t) => {
    if (t.estado !== 'abierto' && t.estado !== 'en_progreso') return false;
    if (!t.fecha_entrega) return false;
    // eslint-disable-next-line react-hooks/purity -- Server Component: se evalúa una vez por request
    const dl = Math.ceil((new Date(t.fecha_entrega).getTime() - Date.now()) / 86400000);
    return dl <= 2;
  }).length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
            <Headphones className="h-4 w-4 text-primary dark:text-brand-blue-light" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Soporte Ads House</h2>
            <p className="text-sm text-muted-foreground">Requerimientos de todos los clientes</p>
          </div>
        </div>
        <a
          href="/soporte"
          className="flex items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/15 transition-colors"
        >
          Ver todos <ChevronRight className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <SoporteStat label="Total" value={total} color="zinc" />
        <SoporteStat label="Abiertos" value={abiertos} color="blue" />
        <SoporteStat label="En Progreso" value={enProgreso} color="amber" />
        <SoporteStat label="Completados" value={completados} color="emerald" />
        {urgentes > 0 && <SoporteStat label="Vencen Pronto" value={urgentes} color="red" pulse />}
      </div>
    </section>
  );
}

function SoporteStat({
  label,
  value,
  color,
  pulse,
}: {
  label: string;
  value: number;
  color: 'zinc' | 'blue' | 'amber' | 'emerald' | 'red';
  pulse?: boolean;
}) {
  const colorMap = {
    zinc: {
      bg: 'bg-card',
      text: 'text-foreground',
      sub: 'text-muted-foreground',
      border: 'border-border',
    },
    blue: {
      bg: 'bg-card',
      text: 'text-blue-600 dark:text-blue-300',
      sub: 'text-muted-foreground',
      border: 'border-border',
    },
    amber: {
      bg: 'bg-card',
      text: 'text-amber-600 dark:text-amber-300',
      sub: 'text-muted-foreground',
      border: 'border-border',
    },
    emerald: {
      bg: 'bg-card',
      text: 'text-emerald-600 dark:text-emerald-300',
      sub: 'text-muted-foreground',
      border: 'border-border',
    },
    red: {
      bg: 'bg-card',
      text: 'text-red-600 dark:text-red-300',
      sub: 'text-muted-foreground',
      border: 'border-border',
    },
  };
  const c = colorMap[color];
  return (
    <div className={`relative flex flex-col gap-1 rounded-xl border p-4 ${c.bg} ${c.border}`}>
      {pulse && (
        <span className="absolute right-3 top-3 h-2 w-2 rounded-full bg-red-500">
          <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-75" />
        </span>
      )}
      <span className={`text-2xl font-semibold tabular-nums ${c.text}`}>{value}</span>
      <span className={`text-xs font-medium ${c.sub}`}>{label}</span>
    </div>
  );
}
