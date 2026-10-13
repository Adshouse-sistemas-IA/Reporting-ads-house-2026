/**
 * Polaridad de una métrica: si que el valor suba es bueno, malo o neutro.
 *
 * Las tarjetas pintaban cualquier subida en verde, así que un CPL que pasaba de
 * 8 a 12 se celebraba. Con la polaridad, el delta dice «mejor» o «peor» según
 * la métrica y no según el signo.
 *
 * Si la tarjeta declara `mejorSi`, manda eso. Si no, se infiere de la fórmula y
 * del rótulo: los costes (gasto ÷ algo, cpl/cpa/cpc/cpm…) mejoran al bajar, el
 * gasto o presupuesto a secas es neutro y todo lo demás mejora al subir.
 */

export type MejorSi = 'sube' | 'baja' | 'neutro';

const TOKEN_COSTE = /(^|[^a-z])(cpl|cpa|cpc|cpc_link|cpm|cpp|cpv|cpr|cac|frequency|frecuencia)\b/i;
const ROTULO_COSTE =
  /\b(cpl|cpa|cpc|cpm|cpp|cac|costo|coste|cost per|costo por|frecuencia|rebote)\b/i;
const GASTO_A_SECAS = /^\s*\(?\s*[a-z_]*(spend|gasto|presupuesto)[a-z_]*\s*\)?\s*$/i;
const GASTO_ENTRE_ALGO =
  /^\s*\(?\s*[a-z_]*(spend|gasto)[a-z_]*\s*\/(?!\s*\(?\s*[a-z_]*(spend|gasto))/i;

export function polaridadMetrica(
  formula: string | null | undefined,
  rotulo?: string | null,
  declarada?: MejorSi | null
): MejorSi {
  if (declarada) return declarada;
  const f = (formula ?? '').trim();
  if (GASTO_A_SECAS.test(f)) return 'neutro';
  if (GASTO_ENTRE_ALGO.test(f) || TOKEN_COSTE.test(f)) return 'baja';
  if (rotulo && ROTULO_COSTE.test(rotulo)) return 'baja';
  return 'sube';
}

/** Tono del delta: `bien`, `mal` o `neutro` (sin variación o métrica neutra). */
export function tonoDelta(
  delta: number | null | undefined,
  polaridad: MejorSi
): 'bien' | 'mal' | 'neutro' {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return 'neutro';
  if (polaridad === 'neutro' || Math.abs(delta) < 0.5) return 'neutro';
  const sube = delta > 0;
  return (polaridad === 'sube') === sube ? 'bien' : 'mal';
}
