/**
 * Cifra en el sitio los tokens de Meta y TikTok que siguen en claro
 * (`src/lib/credenciales-ads.ts`).
 *
 * El código ya los guarda cifrados al escribirlos y los lee en los dos
 * formatos (un valor sin prefijo `enc:v1:` se usa tal cual), así que no hace
 * falta para que nada funcione: sirve para que los tokens que ya había no
 * esperen a la próxima vez que alguien los guarde.
 *
 * En seco por defecto: solo cuenta lo que haría, sin tocar nada.
 *
 *   npx tsx --conditions=react-server scripts/cifrar-tokens-existentes.ts            # informe
 *   npx tsx --conditions=react-server scripts/cifrar-tokens-existentes.ts --aplicar  # escribe
 *
 * Qué toca:
 *   · public.clientes.config_api: `meta_token`, `tiktok_access_token`,
 *     `meta_accounts[].token`, `tiktok_accounts[].access_token`. Solo esas
 *     claves, con `fusionar_config_api` (parche), para no pisar lo que el
 *     worker escriba a la vez en el resto de `config_api`.
 *   · report_utm.integrations.config: `pages[].page_token` y
 *     `scoped_forms[].page_token` (Meta Lead Ads). Solo si la fila no cambió
 *     desde que se leyó (`updated_at`).
 *
 * Tras escribir cada fila la relee y comprueba que al abrir cada token sale el
 * mismo valor que había en claro. Si no, lo dice y para.
 *
 * Requiere `RUTM_ENCRYPTION_KEY` en `.env.local` (la misma del despliegue: con
 * otra, la app no podría descifrarlos). NO rotar esa clave sin volver a
 * cifrar antes estos tokens.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import {
  abrirCredencialesAds,
  abrirPaginas,
  esTokenCifrado,
  sellarCredencialesAds,
  sellarPaginas,
} from '../src/lib/credenciales-ads';
import { decrypt } from '../src/lib/report-utm/encryption';

config({ path: '.env.local' });

const aplicar = process.argv.includes('--aplicar');
const CLAVES_CONFIG = ['meta_token', 'tiktok_access_token', 'meta_accounts', 'tiktok_accounts'];

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false },
  }
);

type Dict = Record<string, unknown>;

/** Todos los valores de token de un `config_api` (para contar y comprobar). */
function tokensDeConfig(c: Dict): unknown[] {
  const lista: unknown[] = [c.meta_token, c.tiktok_access_token];
  for (const a of Array.isArray(c.meta_accounts) ? c.meta_accounts : [])
    lista.push((a as Dict)?.token);
  for (const a of Array.isArray(c.tiktok_accounts) ? c.tiktok_accounts : [])
    lista.push((a as Dict)?.access_token);
  return lista.filter((v) => typeof v === 'string' && v !== '');
}

function tokensDePaginas(c: Dict): unknown[] {
  const lista: unknown[] = [];
  for (const k of ['pages', 'scoped_forms'])
    for (const p of Array.isArray(c[k]) ? (c[k] as unknown[]) : [])
      lista.push((p as Dict)?.page_token);
  return lista.filter((v) => typeof v === 'string' && v !== '');
}

const enClaro = (lista: unknown[]) => lista.filter((v) => !esTokenCifrado(v)).length;

async function main() {
  if (!process.env.RUTM_ENCRYPTION_KEY) {
    console.error('Falta RUTM_ENCRYPTION_KEY en .env.local: no se cifra nada.');
    process.exit(1);
  }
  console.log(aplicar ? 'MODO: --aplicar (escribe)\n' : 'MODO: en seco (no escribe nada)\n');

  // La clave local tiene que ser la del despliegue: se prueba descifrando un
  // secreto que ya cifró la app en producción. Con otra clave, los tokens
  // quedarían ilegibles para la app y se pararían todas las sincronizaciones.
  const { data: muestra, error: em } = await db
    .schema('report_utm')
    .from('integrations')
    .select('id, webhook_secret_enc, access_token_encrypted')
    .or('webhook_secret_enc.not.is.null,access_token_encrypted.not.is.null')
    .limit(1)
    .maybeSingle();
  if (em) throw new Error(`muestra cifrada: ${em.message}`);
  const cifrado = muestra?.webhook_secret_enc ?? muestra?.access_token_encrypted;
  if (!cifrado) {
    console.error('No hay ningún secreto cifrado con que comprobar la clave: no se sigue.');
    process.exit(1);
  }
  try {
    decrypt(cifrado);
    console.log('✓ RUTM_ENCRYPTION_KEY local descifra los secretos de producción\n');
  } catch {
    console.error(
      'RUTM_ENCRYPTION_KEY de .env.local NO es la de producción (no descifra sus secretos): no se cifra nada.'
    );
    process.exit(1);
  }
  let pendientes = 0;
  let hechos = 0;

  // ── clientes.config_api ──────────────────────────────────────────
  const { data: clientes, error } = await db.from('clientes').select('id, nombre, config_api');
  if (error) throw new Error(`clientes: ${error.message}`);
  for (const c of clientes ?? []) {
    const cfg = (c.config_api ?? {}) as Dict;
    const claro = enClaro(tokensDeConfig(cfg));
    if (claro === 0) continue;
    pendientes += claro;
    console.log(`cliente ${c.nombre} (${c.id}): ${claro} token(s) en claro`);
    if (!aplicar) continue;

    const sellado = sellarCredencialesAds(cfg) as Dict;
    const parche: Dict = {};
    for (const k of CLAVES_CONFIG) if (k in sellado) parche[k] = sellado[k];
    const { error: e } = await db.rpc('fusionar_config_api', {
      p_cliente_id: c.id,
      p_parche: parche,
    });
    if (e) throw new Error(`fusionar_config_api ${c.id}: ${e.message}`);

    const { data: releido, error: er } = await db
      .from('clientes')
      .select('config_api')
      .eq('id', c.id)
      .single();
    if (er) throw new Error(`releer ${c.id}: ${er.message}`);
    const nuevo = (releido.config_api ?? {}) as Dict;
    const antes = tokensDeConfig(abrirCredencialesAds(cfg) as Dict);
    const despues = tokensDeConfig(abrirCredencialesAds(nuevo) as Dict);
    if (enClaro(tokensDeConfig(nuevo)) > 0 || JSON.stringify(antes) !== JSON.stringify(despues)) {
      throw new Error(`cliente ${c.id}: al releer, los tokens no coinciden. Se para aquí.`);
    }
    hechos += claro;
    console.log('  ✓ cifrados y comprobados');
  }

  // ── report_utm.integrations.config (páginas de Meta Lead Ads) ────
  const { data: integraciones, error: ei } = await db
    .schema('report_utm')
    .from('integrations')
    .select('id, cliente_id, tipo, config, updated_at');
  if (ei) throw new Error(`integrations: ${ei.message}`);
  for (const i of integraciones ?? []) {
    const cfg = (i.config ?? {}) as Dict;
    const claro = enClaro(tokensDePaginas(cfg));
    if (claro === 0) continue;
    pendientes += claro;
    console.log(`integración ${i.tipo} (${i.id}): ${claro} page token(s) en claro`);
    if (!aplicar) continue;

    const nuevo: Dict = { ...cfg };
    for (const k of ['pages', 'scoped_forms']) if (k in cfg) nuevo[k] = sellarPaginas(cfg[k]);
    const { data: cambiadas, error: e } = await db
      .schema('report_utm')
      .from('integrations')
      .update({ config: nuevo })
      .eq('id', i.id)
      .eq('updated_at', i.updated_at)
      .select('id, config');
    if (e) throw new Error(`integración ${i.id}: ${e.message}`);
    if (!cambiadas?.length) {
      console.log('  · la fila cambió mientras tanto (sync en curso): se deja para otra pasada');
      continue;
    }
    const releido = cambiadas[0].config as Dict;
    const abrir = (c: Dict) =>
      tokensDePaginas({ pages: abrirPaginas(c.pages), scoped_forms: abrirPaginas(c.scoped_forms) });
    if (
      enClaro(tokensDePaginas(releido)) > 0 ||
      JSON.stringify(abrir(cfg)) !== JSON.stringify(abrir(releido))
    ) {
      throw new Error(`integración ${i.id}: al releer, los tokens no coinciden. Se para aquí.`);
    }
    hechos += claro;
    console.log('  ✓ cifrados y comprobados');
  }

  console.log(
    aplicar
      ? `\n${hechos} de ${pendientes} token(s) cifrados.`
      : `\n${pendientes} token(s) en claro. Con --aplicar se cifran.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
