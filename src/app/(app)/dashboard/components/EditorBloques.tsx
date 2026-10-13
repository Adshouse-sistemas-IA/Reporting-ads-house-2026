'use client';

/**
 * Editor lista-detalle de tarjetas y columnas del modal de layout.
 *
 * Antes cada fila mostraba todos sus ajustes a la vez (fórmula, formato,
 * resaltado, filtro de campañas, de Sheet, variante…): con ocho columnas había
 * unas sesenta casillas en pantalla y los rótulos quedaban cortados. Aquí la
 * lista solo enseña nombre, métrica y valor, y los ajustes aparecen para el
 * elemento elegido. Arriba, una vista previa con los datos del período.
 *
 * Solo cambia la presentación: lo que se guarda es el mismo `ColDef`/`CardDef`.
 */

import { useMemo, useRef, useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  Plus,
  Search,
  Trash2,
  ChevronDown,
  TrendingDown,
  TrendingUp,
  Minus,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { CardColor, CardDef, CardThreshold, CardVariant, ColDef } from '@/lib/layout-types';
import { formatValue } from '@/lib/formula-engine';
import { getMetricType, applyMetricType } from '@/lib/dashboard/metric-catalog';
import type { MetricOption } from '@/lib/dashboard/metric-catalog';
import { polaridadMetrica, tonoDelta, type MejorSi } from '@/lib/polaridad-metrica';
import { useMonedaReporte } from './MonedaReporteContext';
import {
  CampaignFilterPicker,
  FormulaInput,
  SheetFilterPicker,
  TikTokAccountPicker,
  hasTikTokFormula,
} from './LayoutConfigModal';

/** Lo que el dashboard sabe calcular para previsualizar un bloque. */
export type VistaPreviaEditor = {
  valor: (def: CardDef | ColDef) => { actual: number | null; anterior: number | null };
  filas: (def: ColDef, n: number) => Array<{ fecha: string; v: number | null }>;
};

type Preset = { label: string; formula: string; prefix?: string; suffix?: string };
type Bloque = CardDef | ColDef;

// ─── Formato ──────────────────────────────────────────────────────────────────

type Formato = 'number' | 'currency' | 'currency_usd' | 'percent' | 'multiplier';

const FORMATOS: { val: Formato; label: string }[] = [
  { val: 'number', label: 'Número' },
  { val: 'currency', label: 'Moneda' },
  { val: 'currency_usd', label: 'Dólares' },
  { val: 'percent', label: 'Porcentaje' },
  { val: 'multiplier', label: 'Multiplicador' },
];

function formatoDe(b: Bloque): Formato {
  if (b.suffix === 'x') return 'multiplier';
  return getMetricType(b.prefix, b.suffix);
}

function aplicarFormato(f: Formato) {
  if (f === 'multiplier') return { prefix: '', suffix: 'x', decimals: 2 };
  return applyMetricType(f);
}

// ─── Colores y variantes de tarjeta ───────────────────────────────────────────

const COLORES: { val: CardColor; label: string; dot: string }[] = [
  { val: 'default', label: 'Neutro', dot: 'bg-foreground/70' },
  { val: 'emerald', label: 'Verde', dot: 'bg-emerald-500' },
  { val: 'blue', label: 'Azul', dot: 'bg-blue-500' },
  { val: 'amber', label: 'Ámbar', dot: 'bg-amber-500' },
  { val: 'red', label: 'Rojo', dot: 'bg-red-500' },
];

const VARIANTES: { val: CardVariant; label: string; desc: string }[] = [
  { val: 'default', label: 'Número', desc: 'Solo el valor' },
  { val: 'stat', label: 'Con variación', desc: 'Valor y cambio' },
  { val: 'sparkline', label: 'Con tendencia', desc: 'Minigráfico diario' },
  { val: 'threshold', label: 'Semáforo', desc: 'Color por umbrales' },
  { val: 'progress', label: 'Progreso', desc: 'Hacia un objetivo' },
];

const UMBRAL_VACIO: CardThreshold = {
  greenOperator: '>=',
  greenValue: 0,
  yellowOperator: '>=',
  yellowValue: 0,
};

const POLARIDADES: { val: MejorSi | ''; label: string }[] = [
  { val: '', label: 'Automático' },
  { val: 'sube', label: 'Mejor si sube' },
  { val: 'baja', label: 'Mejor si baja' },
  { val: 'neutro', label: 'Sin juicio' },
];

const esTarjeta = (b: Bloque): b is CardDef => 'color' in b || 'variant' in b || 'showDelta' in b;

function nombreMetrica(formula: string, metrics: MetricOption[]): string {
  const f = formula.trim();
  if (!f) return 'Sin métrica';
  if (f === 'fecha') return 'Fecha del día';
  const exacta = metrics.find((m) => m.id === f);
  return exacta ? exacta.label : 'Fórmula personalizada';
}

function tieneFiltro(b: Bloque): boolean {
  return !!(b.campaignFilter || b.sheetFilter || ('account_id' in b && b.account_id));
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function EditorBloques({
  tipo,
  items,
  onItemsChange,
  availableMetrics,
  presets,
  onAddManual,
  vistaPrevia,
  campaignGroups = [],
  campaignNames = [],
  tiktokAccounts = [],
  googleSheetsConversiones = [],
  conversionesOfflineRaw = [],
}: {
  tipo: 'card' | 'col';
  items: Bloque[];
  onItemsChange: (items: Bloque[]) => void;
  availableMetrics: MetricOption[];
  presets: Preset[];
  onAddManual?: () => void;
  vistaPrevia?: VistaPreviaEditor;
  campaignGroups?: { id: string; nombre: string }[];
  campaignNames?: string[];
  tiktokAccounts?: { id: string; label: string; advertiser_id: string }[];
  googleSheetsConversiones?: unknown[];
  conversionesOfflineRaw?: unknown[];
}) {
  const moneda = useMonedaReporte();
  const [sel, setSel] = useState(() => (tipo === 'col' && items.length > 1 ? 1 : 0));
  const [busqueda, setBusqueda] = useState('');
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const [destino, setDestino] = useState<number | null>(null);
  const [menuAgregar, setMenuAgregar] = useState(false);
  const listaRef = useRef<HTMLUListElement>(null);

  const seleccionado = items[Math.min(sel, items.length - 1)] as Bloque | undefined;
  const iSel = Math.min(sel, items.length - 1);

  // Un cálculo por bloque y render, no uno por cada sitio donde se pinta.
  const valores = useMemo(
    () => items.map((b) => (vistaPrevia && b.formula !== 'fecha' ? vistaPrevia.valor(b) : null)),
    [items, vistaPrevia]
  );

  const fmt = (b: Bloque, v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v)
      ? '—'
      : formatValue(v, {
          prefix: b.prefix,
          suffix: b.suffix,
          decimals: b.decimals ?? 2,
          moneda,
        });

  function actualizar(i: number, b: Bloque) {
    const copia = [...items];
    copia[i] = b;
    onItemsChange(copia);
  }

  function mover(desde: number, hasta: number) {
    if (desde === hasta) return;
    const copia = [...items];
    const [m] = copia.splice(desde, 1);
    copia.splice(hasta, 0, m);
    onItemsChange(copia);
    setSel(hasta);
  }

  function agregar(p: Preset) {
    const base = {
      id: crypto.randomUUID(),
      label: p.label,
      formula: p.formula,
      prefix: p.prefix || '',
      suffix: p.suffix || '',
      decimals: 2,
    };
    const nuevo: Bloque =
      tipo === 'card' ? { ...base, color: 'default' } : { ...base, align: 'right' };
    onItemsChange([...items, nuevo]);
    setSel(items.length);
    setMenuAgregar(false);
  }

  function duplicar(i: number) {
    const b = items[i];
    const copia = [...items];
    copia.splice(i + 1, 0, { ...b, id: crypto.randomUUID(), label: `${b.label} (copia)` });
    onItemsChange(copia);
    setSel(i + 1);
  }

  function eliminar(i: number) {
    onItemsChange(items.filter((_, k) => k !== i));
    setSel(Math.max(0, i - 1));
  }

  const q = busqueda.trim().toLowerCase();
  const nombre = tipo === 'card' ? 'tarjeta' : 'columna';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Vista previa ── */}
      {vistaPrevia && items.length > 0 && (
        <div className="border-b border-border bg-muted/40 px-5 py-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Vista previa con los datos del período · haz clic para editar
          </p>
          {tipo === 'card' ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {items.map((b, i) => {
                const v = valores[i];
                const card = b as CardDef;
                const delta =
                  v && v.actual !== null && v.anterior !== null && v.anterior !== 0
                    ? ((v.actual - v.anterior) / Math.abs(v.anterior)) * 100
                    : null;
                const tono = tonoDelta(
                  delta,
                  polaridadMetrica(card.formula, card.label, card.mejorSi)
                );
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setSel(i)}
                    className={`min-w-0 rounded-lg border bg-card px-3 py-2 text-left transition ${i === iSel ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground/40'}`}
                  >
                    <span className="block truncate text-xs text-muted-foreground">
                      {b.label || 'Sin nombre'}
                    </span>
                    <span className="block truncate text-lg font-semibold tabular-nums">
                      {fmt(b, v?.actual)}
                    </span>
                    {card.showDelta && delta !== null ? (
                      <span
                        className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 text-xs font-semibold tabular-nums ${tono === 'bien' ? 'bg-good-soft text-good' : tono === 'mal' ? 'bg-bad-soft text-bad' : 'bg-muted text-muted-foreground'}`}
                      >
                        {delta > 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : delta < 0 ? (
                          <TrendingDown className="h-3 w-3" />
                        ) : (
                          <Minus className="h-3 w-3" />
                        )}
                        {Math.abs(delta).toFixed(1)}%
                        {tono === 'bien' ? ' mejor' : tono === 'mal' ? ' peor' : ''}
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {card.showDelta ? 'Sin período anterior' : 'Sin comparar'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <TablaPrevia
              items={items as ColDef[]}
              seleccion={iSel}
              onSeleccion={setSel}
              vistaPrevia={vistaPrevia}
              fmt={fmt}
            />
          )}
        </div>
      )}

      {/* ── Lista + detalle ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r">
          <div className="relative px-3 pt-3 pb-2">
            <Search className="pointer-events-none absolute left-5.5 top-1/2 mt-0.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder={`Buscar ${nombre}`}
              aria-label={`Buscar ${nombre}`}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <ul
            ref={listaRef}
            className="max-h-[260px] flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar md:max-h-none"
          >
            {items.map((b, i) => {
              if (q && !b.label.toLowerCase().includes(q)) return null;
              const col = b as ColDef;
              const oculto = tipo === 'col' && col.hidden;
              const esFecha = b.formula === 'fecha';
              const color = tipo === 'card' ? (b as CardDef).color || 'default' : null;
              return (
                <li
                  key={b.id}
                  draggable={!esFecha}
                  onDragStart={() => setArrastrando(i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (arrastrando !== null) setDestino(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (arrastrando !== null) mover(arrastrando, i);
                    setArrastrando(null);
                    setDestino(null);
                  }}
                  onDragEnd={() => {
                    setArrastrando(null);
                    setDestino(null);
                  }}
                  className={`group relative ${destino === i && arrastrando !== null && arrastrando !== i ? 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded before:bg-primary' : ''}`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSel(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSel(i);
                      }
                    }}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition ${i === iSel ? 'bg-secondary' : 'hover:bg-accent'} ${arrastrando === i ? 'opacity-50' : ''}`}
                  >
                    <GripVertical
                      className={`h-4 w-4 shrink-0 ${esFecha ? 'invisible' : 'cursor-grab text-muted-foreground opacity-40 group-hover:opacity-100'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`flex items-center gap-1.5 truncate text-sm font-medium ${oculto ? 'text-muted-foreground line-through' : 'text-foreground'}`}
                      >
                        {color && (
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${COLORES.find((c) => c.val === color)?.dot}`}
                          />
                        )}
                        <span className="truncate">{b.label || 'Sin nombre'}</span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {esFecha ? 'Siempre primera' : nombreMetrica(b.formula, availableMetrics)}
                      </span>
                    </span>
                    {tieneFiltro(b) ? (
                      <span
                        className="flex shrink-0 items-center gap-1 rounded bg-warn-soft px-1.5 text-xs font-semibold text-warn"
                        title="Tiene un filtro de campañas, Sheet o cuenta"
                      >
                        <Filter className="h-3 w-3" />
                        Filtro
                      </span>
                    ) : (
                      !esFecha &&
                      vistaPrevia && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {fmt(b, valores[i]?.actual)}
                        </span>
                      )
                    )}
                    {tipo === 'col' && !esFecha && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          actualizar(i, { ...col, hidden: !col.hidden });
                        }}
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                        aria-label={col.hidden ? 'Mostrar columna' : 'Ocultar columna'}
                        title={col.hidden ? 'Mostrar columna' : 'Ocultar columna'}
                      >
                        {col.hidden ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                Todavía no hay {tipo === 'card' ? 'tarjetas' : 'columnas'}.
              </li>
            )}
          </ul>
          <div className="flex gap-2 p-3 pt-1">
            <Popover open={menuAgregar} onOpenChange={setMenuAgregar}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  <Plus className="h-4 w-4" />
                  Añadir {nombre}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-1" style={{ zIndex: 200 }}>
                <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
                  Empieza con una métrica habitual
                </p>
                {presets.map((p) => (
                  <button
                    key={p.formula}
                    type="button"
                    onClick={() => agregar(p)}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    {p.label}
                    <span className="text-xs text-muted-foreground">
                      {p.prefix === '$' ? 'Moneda' : p.suffix === '%' ? '%' : p.suffix || ''}
                    </span>
                  </button>
                ))}
                {onAddManual && (
                  <button
                    type="button"
                    onClick={() => {
                      onAddManual();
                      setSel(items.length);
                      setMenuAgregar(false);
                    }}
                    className="mt-1 flex w-full items-center gap-2 rounded border-t border-border px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    Columna de carga manual
                  </button>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="min-w-0 overflow-y-auto p-5 custom-scrollbar">
          {seleccionado ? (
            <DetalleBloque
              key={seleccionado.id}
              tipo={tipo}
              bloque={seleccionado}
              onChange={(b) => actualizar(iSel, b)}
              onDuplicar={() => duplicar(iSel)}
              onEliminar={() => eliminar(iSel)}
              valor={valores[iSel]?.actual ?? null}
              availableMetrics={availableMetrics}
              campaignGroups={campaignGroups}
              campaignNames={campaignNames}
              tiktokAccounts={tiktokAccounts}
              googleSheetsConversiones={googleSheetsConversiones}
              conversionesOfflineRaw={conversionesOfflineRaw}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Elige un elemento de la lista o añade uno nuevo.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tabla de vista previa ────────────────────────────────────────────────────

function TablaPrevia({
  items,
  seleccion,
  onSeleccion,
  vistaPrevia,
  fmt,
}: {
  items: ColDef[];
  seleccion: number;
  onSeleccion: (i: number) => void;
  vistaPrevia: VistaPreviaEditor;
  fmt: (b: Bloque, v: number | null | undefined) => string;
}) {
  const visibles = items.map((c, i) => ({ c, i })).filter((x) => !x.c.hidden);
  const filas = useMemo(
    () => visibles.map((x) => vistaPrevia.filas(x.c, 3)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `visibles` se deriva de `items`
    [items, vistaPrevia]
  );
  const n = Math.max(0, ...filas.map((f) => f.length));
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card custom-scrollbar">
      <table className="w-full text-xs">
        <thead>
          <tr>
            {visibles.map(({ c, i }) => (
              <th
                key={c.id}
                onClick={() => onSeleccion(i)}
                className={`cursor-pointer whitespace-nowrap border-b border-border px-3 py-1.5 font-medium ${c.formula === 'fecha' ? 'text-left' : 'text-right'} ${i === seleccion ? 'text-primary shadow-[inset_0_-2px_0_var(--primary)] dark:text-brand-blue-light' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: n }).map((_, r) => (
            <tr key={r} className="border-b border-border last:border-0">
              {visibles.map(({ c }, k) => {
                const f = filas[k]?.[r];
                return (
                  <td
                    key={c.id}
                    className={`whitespace-nowrap px-3 py-1.5 tabular-nums ${c.formula === 'fecha' ? 'text-left text-muted-foreground' : 'text-right'}`}
                  >
                    {c.formula === 'fecha' ? (f?.fecha ?? '') : fmt(c, f?.v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Detalle del bloque elegido ───────────────────────────────────────────────

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium text-foreground">{etiqueta}</span>
      {children}
      {ayuda && <span className="text-xs text-muted-foreground">{ayuda}</span>}
    </div>
  );
}

function Opcion({
  activa,
  onClick,
  titulo,
  detalle,
}: {
  activa: boolean;
  onClick: () => void;
  titulo: string;
  detalle?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={activa}
      onClick={onClick}
      className={`flex min-w-[96px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left text-sm transition ${activa ? 'border-primary bg-secondary text-primary dark:text-brand-blue-light' : 'border-border bg-card hover:border-muted-foreground/50'}`}
    >
      {titulo}
      {detalle && (
        <span className={`text-xs tabular-nums ${activa ? '' : 'text-muted-foreground'}`}>
          {detalle}
        </span>
      )}
    </button>
  );
}

function Interruptor({
  titulo,
  detalle,
  checked,
  onChange,
}: {
  titulo: string;
  detalle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
      <span>
        <span className="block text-sm font-medium">{titulo}</span>
        <span className="block text-xs text-muted-foreground">{detalle}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={titulo} />
    </label>
  );
}

function DetalleBloque({
  tipo,
  bloque,
  onChange,
  onDuplicar,
  onEliminar,
  valor,
  availableMetrics,
  campaignGroups,
  campaignNames,
  tiktokAccounts,
  googleSheetsConversiones,
  conversionesOfflineRaw,
}: {
  tipo: 'card' | 'col';
  bloque: Bloque;
  onChange: (b: Bloque) => void;
  onDuplicar: () => void;
  onEliminar: () => void;
  valor: number | null;
  availableMetrics: MetricOption[];
  campaignGroups: { id: string; nombre: string }[];
  campaignNames: string[];
  tiktokAccounts: { id: string; label: string; advertiser_id: string }[];
  googleSheetsConversiones: unknown[];
  conversionesOfflineRaw: unknown[];
}) {
  const moneda = useMonedaReporte();
  const [confirmarBorrado, setConfirmarBorrado] = useState(false);
  const esFecha = bloque.formula === 'fecha';
  const formato = formatoDe(bloque);
  const card = tipo === 'card' && esTarjeta(bloque) ? bloque : null;
  const col = tipo === 'col' ? (bloque as ColDef) : null;
  const filtroAbiertoInicial = tieneFiltro(bloque);
  const ejemplo = valor ?? 12480.5;
  const polInferida = polaridadMetrica(bloque.formula, bloque.label);

  if (esFecha) {
    return (
      <div className="grid max-w-xl gap-4">
        <div>
          <h3 className="text-base font-semibold">Fecha</h3>
          <p className="text-sm text-muted-foreground">
            La fecha siempre es la primera columna. Solo puedes cambiar su nombre.
          </p>
        </div>
        <Campo etiqueta="Nombre visible">
          <Input
            value={bloque.label}
            onChange={(e) => onChange({ ...bloque, label: e.target.value })}
          />
        </Campo>
      </div>
    );
  }

  return (
    <div className="grid max-w-2xl gap-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">{bloque.label || 'Sin nombre'}</h3>
        <span className="text-xs text-muted-foreground">
          {tipo === 'card' ? 'Tarjeta superior' : 'Columna de la tabla'}
        </span>
        {col?.isManual && (
          <span className="rounded bg-good-soft px-1.5 text-xs font-semibold text-good">
            Carga manual
          </span>
        )}
      </div>

      <Campo etiqueta="Nombre visible">
        <Input
          value={bloque.label}
          onChange={(e) => onChange({ ...bloque, label: e.target.value })}
          placeholder="Ej.: Costo por lead"
        />
      </Campo>

      <Campo
        etiqueta="Métrica"
        ayuda={`${nombreMetrica(bloque.formula, availableMetrics)} · escribe o elige del catálogo; puedes combinar métricas con + − × ÷`}
      >
        <FormulaInput
          value={bloque.formula}
          onChange={(val) => onChange({ ...bloque, formula: val.trim() })}
          availableMetrics={availableMetrics}
          onMetricInserted={(_id, format, formula) => {
            if (format)
              onChange({ ...bloque, formula: formula.trim(), ...applyMetricType(format) });
          }}
        />
      </Campo>

      <Campo etiqueta="Formato">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Formato">
          {FORMATOS.map((f) => {
            const muestra = aplicarFormato(f.val);
            return (
              <Opcion
                key={f.val}
                activa={formato === f.val}
                onClick={() => onChange({ ...bloque, ...muestra })}
                titulo={f.label}
                detalle={formatValue(ejemplo, { ...muestra, moneda })}
              />
            );
          })}
        </div>
      </Campo>

      {card && (
        <>
          <Campo
            etiqueta="Color del número"
            ayuda="Úsalo con moderación: la variación ya se pinta en verde o rojo según sea mejor o peor."
          >
            <div className="flex flex-wrap gap-2" role="group" aria-label="Color">
              {COLORES.map((c) => (
                <button
                  key={c.val}
                  type="button"
                  aria-pressed={(card.color || 'default') === c.val}
                  onClick={() => onChange({ ...card, color: c.val })}
                  className={`inline-flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-1.5 text-sm transition ${(card.color || 'default') === c.val ? 'border-foreground font-semibold' : 'border-border hover:border-muted-foreground/50'}`}
                >
                  <span className={`h-3.5 w-3.5 rounded-full ${c.dot}`} />
                  {c.label}
                </button>
              ))}
            </div>
          </Campo>

          <Campo etiqueta="Cómo se muestra">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Variante">
              {VARIANTES.map((v) => (
                <Opcion
                  key={v.val}
                  activa={(card.variant || 'default') === v.val}
                  onClick={() =>
                    onChange({
                      ...card,
                      variant: v.val,
                      showDelta: v.val === 'stat' ? true : card.showDelta,
                    })
                  }
                  titulo={v.label}
                  detalle={v.desc}
                />
              ))}
            </div>
          </Campo>

          {card.variant === 'threshold' && (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <span className="text-sm font-medium">Umbrales del semáforo</span>
              {(['green', 'yellow'] as const).map((nivel) => {
                const t = card.threshold ?? UMBRAL_VACIO;
                const op = nivel === 'green' ? t.greenOperator : t.yellowOperator;
                const val = nivel === 'green' ? t.greenValue : t.yellowValue;
                return (
                  <div key={nivel} className="flex flex-wrap items-center gap-2 text-sm">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${nivel === 'green' ? 'bg-good' : 'bg-warn'}`}
                    />
                    <span className="w-16">{nivel === 'green' ? 'Verde si' : 'Ámbar si'}</span>
                    <select
                      value={op}
                      onChange={(e) =>
                        onChange({
                          ...card,
                          threshold: {
                            ...t,
                            [nivel === 'green' ? 'greenOperator' : 'yellowOperator']: e.target
                              .value as CardThreshold['greenOperator'],
                          },
                        })
                      }
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      aria-label={`Operador ${nivel === 'green' ? 'verde' : 'ámbar'}`}
                    >
                      {['>=', '<=', '>', '<'].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <Input
                      type="number"
                      value={val ?? ''}
                      onChange={(e) =>
                        onChange({
                          ...card,
                          threshold: {
                            ...t,
                            [nivel === 'green' ? 'greenValue' : 'yellowValue']:
                              parseFloat(e.target.value) || 0,
                          },
                        })
                      }
                      className="h-8 w-28"
                      aria-label={`Valor ${nivel === 'green' ? 'verde' : 'ámbar'}`}
                    />
                  </div>
                );
              })}
              <span className="text-xs text-muted-foreground">Si no cumple ninguno, rojo.</span>
            </div>
          )}

          {card.variant === 'progress' && (
            <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_180px]">
              <Campo etiqueta="Objetivo">
                <FormulaInput
                  value={card.targetFormula || ''}
                  onChange={(val) => onChange({ ...card, targetFormula: val.trim() })}
                  availableMetrics={availableMetrics}
                />
              </Campo>
              <Campo etiqueta="Rótulo del objetivo">
                <Input
                  value={card.targetLabel || ''}
                  onChange={(e) => onChange({ ...card, targetLabel: e.target.value })}
                  placeholder="Objetivo"
                />
              </Campo>
            </div>
          )}

          <Interruptor
            titulo="Comparar con el período anterior"
            detalle="Muestra la variación y si es mejor o peor"
            checked={!!card.showDelta}
            onChange={(v) => onChange({ ...card, showDelta: v })}
          />

          {card.showDelta && (
            <Campo
              etiqueta="¿Cuándo es mejor?"
              ayuda={`En automático se deduce de la métrica: ${POLARIDADES.find((p) => p.val === polInferida)?.label.toLowerCase()}.`}
            >
              <div className="flex flex-wrap gap-2" role="group" aria-label="Cuándo es mejor">
                {POLARIDADES.map((p) => (
                  <Opcion
                    key={p.val || 'auto'}
                    activa={(card.mejorSi ?? '') === p.val}
                    onClick={() => onChange({ ...card, mejorSi: p.val || undefined })}
                    titulo={p.label}
                  />
                ))}
              </div>
            </Campo>
          )}
        </>
      )}

      {col && (
        <Interruptor
          titulo="Colorear según impacto"
          detalle="En porcentajes y multiplicadores: verde si es positivo (o ≥ 1x), rojo si no"
          checked={!!col.highlight}
          onChange={(v) => onChange({ ...col, highlight: v })}
        />
      )}

      <details className="group rounded-lg border border-border" open={filtroAbiertoInicial}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-sm font-medium">Filtros</span>
            <span className="block text-xs text-muted-foreground">
              {tieneFiltro(bloque)
                ? 'Este bloque solo cuenta una parte de los datos'
                : 'Todas las campañas y filas'}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-border px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 text-sm text-muted-foreground">Campañas</span>
            <CampaignFilterPicker
              value={bloque.campaignFilter}
              onChange={(v) => onChange({ ...bloque, campaignFilter: v })}
              campaignGroups={campaignGroups}
              campaignNames={campaignNames}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 text-sm text-muted-foreground">Sheet</span>
            <SheetFilterPicker
              value={bloque.sheetFilter}
              onChange={(v) => onChange({ ...bloque, sheetFilter: v })}
              googleSheetsConversiones={googleSheetsConversiones}
              conversionesOfflineRaw={conversionesOfflineRaw}
            />
          </div>
          {card && hasTikTokFormula(card.formula) && (
            <TikTokAccountPicker
              value={card.account_id}
              accounts={tiktokAccounts}
              onChange={(v) => onChange({ ...card, account_id: v || undefined })}
            />
          )}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={onDuplicar}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Copy className="h-4 w-4" />
          Duplicar
        </button>
        <span className="flex-1" />
        {confirmarBorrado ? (
          <span className="flex items-center gap-2 text-sm">
            ¿Eliminar {tipo === 'card' ? 'esta tarjeta' : 'esta columna'}?
            <button
              type="button"
              onClick={onEliminar}
              className="rounded-lg bg-bad px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Eliminar
            </button>
            <button
              type="button"
              onClick={() => setConfirmarBorrado(false)}
              className="rounded-lg px-3 py-1.5 text-sm hover:bg-accent"
            >
              Cancelar
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmarBorrado(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-bad transition hover:bg-bad-soft"
          >
            <Trash2 className="h-4 w-4" />
            Eliminar
          </button>
        )}
      </div>
    </div>
  );
}
