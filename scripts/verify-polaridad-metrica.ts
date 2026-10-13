/**
 * Comprobaciones de la polaridad de métricas (`src/lib/polaridad-metrica.ts`).
 *
 * Todo PURO: no toca la base ni la red.
 *
 *   npx tsx --conditions=react-server scripts/verify-polaridad-metrica.ts
 */

import { polaridadMetrica, tonoDelta } from '../src/lib/polaridad-metrica';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

console.log('Polaridad inferida');
const casos: Array<[string, string | null, ReturnType<typeof polaridadMetrica>]> = [
  ['meta_spend', null, 'neutro'],
  ['presupuesto_gastado_total', null, 'neutro'],
  ['meta_spend / meta_leads', null, 'baja'],
  ['(meta_spend / meta_impressions) * 1000', null, 'baja'],
  ['meta_spend / (ventas_principal + ventas_bump + ventas_upsell)', null, 'baja'],
  ['meta_cpl', null, 'baja'],
  ['meta_cpc_link', null, 'baja'],
  ['meta_cpm', null, 'baja'],
  ['meta_leads', null, 'sube'],
  ['meta_ctr', null, 'sube'],
  ['meta_roas', null, 'sube'],
  ['(ventas_principal + ventas_bump + ventas_upsell) / meta_spend', null, 'sube'],
  ['(ventas_principal + ventas_bump + ventas_upsell) - meta_spend', null, 'sube'],
  ['manual_nueva_metrica', 'Costo por agendamiento', 'baja'],
  ['manual_nueva_metrica', 'Agendamientos', 'sube'],
];
for (const [formula, rotulo, esperado] of casos) {
  const r = polaridadMetrica(formula, rotulo);
  check(`${formula}${rotulo ? ` («${rotulo}»)` : ''} → ${esperado}`, r === esperado, `dio ${r}`);
}
check('declarada manda', polaridadMetrica('meta_leads', null, 'baja') === 'baja');

console.log('Tono del delta');
check('CPL sube → mal', tonoDelta(12, 'baja') === 'mal');
check('CPL baja → bien', tonoDelta(-8, 'baja') === 'bien');
check('leads suben → bien', tonoDelta(5, 'sube') === 'bien');
check('gasto sube → neutro', tonoDelta(30, 'neutro') === 'neutro');
check('variación mínima → neutro', tonoDelta(0.2, 'sube') === 'neutro');
check('null → neutro', tonoDelta(null, 'sube') === 'neutro');

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} fallo(s)`);
salir(fallos);
