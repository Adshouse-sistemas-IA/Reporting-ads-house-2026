import { getDashboardData } from '../_actions';
import { DateRangeSelector } from '../components/DateRangeSelector';
import { DashboardClient } from '../components/DashboardClient';
// Trae recharts; el envoltorio cliente lo carga bajo demanda (ver el archivo).
import { ConversionesOfflineCardLazy as ConversionesOfflineCard } from '../components/ConversionesOfflineCardLazy';
import { PublicLinkButton } from '../components/PublicLinkButton';
import { BitacorasSidebar } from '../components/BitacorasSidebar';
import { getBitacoras } from '../../admin/settings/[id]/_actions';
import { rangoPorDefectoCliente } from '@/lib/colombia-date';
import { accesoClienteONull } from '@/lib/acceso/clientes';
import { resolveRtmClienteId } from '@/lib/report-utm/campaign-resolver';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PieChart } from 'lucide-react';

export default async function DashboardPage(props: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await props.params;
  const clientId = params.clientId;
  const searchParams = await props.searchParams;
  // Hora Colombia, no la del servidor: allí `new Date()` es UTC, así que a
  // partir de las 19:00 el rango por defecto terminaba en MAÑANA y pintaba una
  // fila futura en ceros. Y son 30 días inclusive (no 31) para que coincida con
  // el preset "Últimos 30 días" del selector: si no, `getActivePreset` no lo
  // reconocía y el botón decía "Personalizado".
  const { from: fallbackFrom, to: fallbackTo } = rangoPorDefectoCliente(30);
  const fromStr = typeof searchParams.from === 'string' ? searchParams.from : fallbackFrom;
  const toStr = typeof searchParams.to === 'string' ? searchParams.to : fallbackTo;

  // Acceso con el mismo criterio que el RLS y que las acciones: admin o
  // asignado al cliente. Va ANTES de cargar datos:
  // getDashboardData también lo exige y, si fallara en paralelo, se vería un
  // error en vez de volver al listado.
  const acceso = await accesoClienteONull(clientId, 'lectura');
  if (!acceso) redirect('/dashboard');
  const userRole: string = acceso.rol;
  const userId: string | null = acceso.userId;

  // Los clientes del dashboard (public.clientes) y los de report_utm son entidades
  // distintas: el puente es report_utm.clientes.public_cliente_id. Sin enlace no hay
  // informes que filtrar, así que el botón simplemente no se muestra.
  const resolveInformesClienteId = async (): Promise<string | null> =>
    resolveRtmClienteId(clientId);

  const [dashboardData, initialBitacoras, informesClienteId] = await Promise.all([
    getDashboardData(clientId, fromStr, toStr),
    getBitacoras(clientId),
    resolveInformesClienteId(),
  ]);

  return (
    <div className="space-y-6">
      <BitacorasSidebar
        key={clientId}
        clientId={clientId}
        userRole={userRole}
        userId={userId}
        initialEntries={initialBitacoras}
      />
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {dashboardData?.cliente?.nombre ?? 'Dashboard'}
            </h1>
            <PublicLinkButton
              clienteId={clientId}
              tabs={dashboardData?.tabs || []}
              initialTabIds={
                dashboardData?.layoutPublico?.type === 'tab_mirror'
                  ? (dashboardData.layoutPublico.tab_ids ?? [])
                  : []
              }
              initialBranding={dashboardData?.layoutPublico?.branding ?? {}}
            />
            {informesClienteId && (
              <Link
                href={`/informes?cliente=${informesClienteId}`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border bg-card text-foreground hover:bg-accent transition-colors"
              >
                <PieChart className="h-3.5 w-3.5" />
                Informes
              </Link>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Embudo de ventas · Meta, Hotmart y Google Analytics 4
          </p>
        </div>
        <DateRangeSelector />
      </div>

      <div className="pt-4">
        <DashboardClient
          data={dashboardData || { cliente: null, metrics: [], weeks: [] }}
          userRole={userRole}
          initialTabId={typeof searchParams.tab === 'string' ? searchParams.tab : 'general'}
        />
      </div>

      {/* La card de "Leads desde Google Sheets" se retiró en la migración 059:
                esa hoja se sincroniza ahora por el módulo unificado y sus leads
                aparecen en Conversiones Offline y en los campos de Sheet. */}

      {/* Conversiones Offline Section — show if at least one sheet is enabled */}
      {(() => {
        const raw = dashboardData?.cliente?.config_api?.google_sheets_conversiones;
        const hasEnabled = Array.isArray(raw)
          ? raw.some((s: any) => s.enabled)
          : raw?.enabled === true;
        return hasEnabled ? (
          <div className="pt-6 border-t border-border">
            <h3 className="text-lg font-semibold text-foreground mb-4">Conversiones Offline</h3>
            <ConversionesOfflineCard
              dailyData={dashboardData?.conversionesOfflineRaw || []}
              error={null}
              clientId={clientId}
              canSync={userRole === 'admin' || userRole === 'trafficker'}
            />
          </div>
        ) : null;
      })()}
    </div>
  );
}
