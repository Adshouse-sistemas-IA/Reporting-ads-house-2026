/* eslint-disable @typescript-eslint/no-explicit-any -- configs de prueba sin tipar */
/**
 * Tokens de Meta y TikTok cifrados en reposo (src/lib/credenciales-ads.ts, docs/40).
 *
 * PURO: sin base ni red. La clave de cifrado es aleatoria y se genera aquí;
 * no se usa ninguna credencial real.
 *
 *   1. sellarToken / abrirToken: ida y vuelta, idempotencia, tokens heredados
 *      en claro, clave equivocada (nunca lanza) y sin clave (lanza al cifrar).
 *   2. config_api completo y páginas de Meta Lead Ads.
 *   3. Enmascarado para el navegador y parche de la pestaña: SECRETO_GUARDADO
 *      conserva/restaura el guardado (también por cuenta), un valor nuevo se
 *      cifra y uno que llega ya cifrado se rechaza.
 *   4. Barrera en el código: cada escritura de un token de Meta/TikTok pasa
 *      por `sellarToken` y cada uso contra la API, por `abrirToken`.
 *
 *   npx tsx --conditions=react-server scripts/verify-credenciales-ads.ts
 */

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);
}
function lanza(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const CLAVE_A = randomBytes(32).toString('hex');
const CLAVE_B = randomBytes(32).toString('hex');
process.env.RUTM_ENCRYPTION_KEY = CLAVE_A;

async function main() {
  const ads = await import('../src/lib/credenciales-ads');
  const cp = await import('../src/lib/clientes/config-pestanas');
  const { sellarToken, abrirToken, esTokenCifrado, PREFIJO_TOKEN_CIFRADO } = ads;
  const sellar = (v: string) => String(sellarToken(v));

  seccion('1. Un token');
  const t = 'EAAG-token-de-prueba-' + randomBytes(6).toString('hex');
  const c = sellar(t);
  check('cifrado lleva el prefijo y no contiene el token', esTokenCifrado(c) && !c.includes(t));
  check('abrirToken devuelve el original', abrirToken(c) === t);
  check('dos cifrados del mismo token son distintos (IV aleatorio)', sellar(t) !== c);
  check('sellar es idempotente sobre un valor ya cifrado', sellar(c) === c);
  check('vacío y no-string quedan igual', sellarToken('') === '' && sellarToken(null) === null);
  check('un token heredado en claro se lee tal cual', abrirToken('EAAG-claro') === 'EAAG-claro');
  check(
    'abrirToken de vacío/undefined es ""',
    abrirToken(undefined) === '' && abrirToken('') === ''
  );
  check(
    'ciphertext manipulado → "" (GCM detecta el cambio), sin lanzar',
    abrirToken(c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA')) === ''
  );
  process.env.RUTM_ENCRYPTION_KEY = CLAVE_B;
  check('con otra clave → "" sin lanzar', abrirToken(c) === '');
  delete process.env.RUTM_ENCRYPTION_KEY;
  check(
    'sin clave, cifrar lanza (no se guarda en claro creyendo que va cifrado)',
    lanza(() => sellar('x'))
  );
  check('sin clave, abrir no lanza', !lanza(() => abrirToken(c)));
  process.env.RUTM_ENCRYPTION_KEY = CLAVE_A;
  check(
    'el prefijo es el mismo en el módulo puro y en el de servidor',
    PREFIJO_TOKEN_CIFRADO === cp.PREFIJO_TOKEN_CIFRADO
  );

  seccion('2. config_api y páginas');
  const config = {
    meta_token: 'M-compartido',
    tiktok_access_token: 'T-compartido',
    meta_accounts: [
      { account_id: 'act_1', token: 'M-propio' },
      { account_id: 'act_2', token: '' },
    ],
    tiktok_accounts: [{ advertiser_id: '99', access_token: 'T-propio' }],
    meta_keywords: ['x'],
  };
  const sellada = ads.sellarCredencialesAds(config);
  const texto = JSON.stringify(sellada);
  check(
    'sellarCredencialesAds cifra los 4 sitios y no deja ningún token en claro',
    ['M-compartido', 'T-compartido', 'M-propio', 'T-propio'].every((x) => !texto.includes(x))
  );
  check('no muta el original', config.meta_token === 'M-compartido');
  check('lo que no es token queda igual', JSON.stringify(sellada.meta_keywords) === '["x"]');
  check('token vacío de una cuenta sigue vacío', sellada.meta_accounts[1].token === '');
  const abierta = ads.abrirCredencialesAds(sellada);
  check(
    'abrirCredencialesAds devuelve la config original',
    JSON.stringify(abierta) === JSON.stringify(config)
  );
  const paginas = [
    { page_id: '1', page_token: 'P-1' },
    { page_id: '2', page_token: '' },
  ];
  const pSell = ads.sellarPaginas(paginas);
  check(
    'sellarPaginas cifra page_token',
    esTokenCifrado(pSell[0].page_token) && pSell[1].page_token === ''
  );
  check(
    'abrirPaginas lo recupera',
    JSON.stringify(ads.abrirPaginas(pSell)) === JSON.stringify(paginas)
  );
  check('listas no-array quedan igual', ads.sellarPaginas(null) === null);

  seccion('3. Navegador: enmascarado y parche de la pestaña');
  const G = cp.SECRETO_GUARDADO;
  const masc = cp.enmascararTokensAds(sellada);
  const textoMasc = JSON.stringify(masc);
  check(
    'al navegador no llega ni el token ni el cifrado',
    !textoMasc.includes(PREFIJO_TOKEN_CIFRADO)
  );
  check(
    'compartidos y por cuenta llegan como SECRETO_GUARDADO',
    masc.meta_token === G &&
      masc.tiktok_access_token === G &&
      (masc.meta_accounts as any[])[0].token === G &&
      (masc.tiktok_accounts as any[])[0].access_token === G
  );
  check(
    'una cuenta sin token propio sigue sin token',
    (masc.meta_accounts as any[])[1].token === ''
  );

  // El formulario devuelve lo enmascarado sin tocar.
  const sinCambios = cp.prepararParcheTokensAds(
    { meta_token: G, meta_accounts: masc.meta_accounts },
    sellada,
    sellar
  );
  check(
    'SECRETO_GUARDADO compartido sale del parche (se conserva lo guardado)',
    !('meta_token' in sinCambios)
  );
  const cuentas = sinCambios.meta_accounts as any[];
  check(
    'SECRETO_GUARDADO de una cuenta se restaura con SU token guardado',
    abrirToken(cuentas[0].token) === 'M-propio' && cuentas[1].token === ''
  );

  const nuevo = cp.prepararParcheTokensAds(
    {
      meta_token: 'M-nuevo',
      meta_accounts: [
        { account_id: 'act_2', token: 'M-nuevo-2' },
        { account_id: 'act_3', token: G },
      ],
    },
    sellada,
    sellar
  );
  check(
    'un token nuevo se guarda cifrado',
    esTokenCifrado(nuevo.meta_token) && abrirToken(nuevo.meta_token) === 'M-nuevo'
  );
  check(
    'token nuevo de una cuenta, cifrado',
    abrirToken((nuevo.meta_accounts as any[])[0].token) === 'M-nuevo-2'
  );
  check(
    'cuenta nueva con el marcador se queda sin token propio',
    (nuevo.meta_accounts as any[])[1].token === ''
  );
  const vaciado = cp.prepararParcheTokensAds({ tiktok_access_token: '' }, sellada, sellar);
  check('vaciar el compartido lo borra (null)', vaciado.tiktok_access_token === null);
  check(
    'un valor que llega ya cifrado se rechaza (no se puede copiar el token de otro cliente)',
    lanza(() => cp.prepararParcheTokensAds({ meta_token: sellada.meta_token }, {}, sellar)) &&
      lanza(() =>
        cp.prepararParcheTokensAds(
          { tiktok_accounts: [{ advertiser_id: '1', access_token: sellada.tiktok_access_token }] },
          {},
          sellar
        )
      )
  );
  check(
    'restaurar un token heredado en claro lo guarda ya cifrado',
    esTokenCifrado(
      (
        cp.prepararParcheTokensAds(
          { meta_accounts: [{ account_id: 'act_1', token: G }] },
          { meta_accounts: [{ account_id: 'act_1', token: 'heredado' }] },
          sellar
        ).meta_accounts as any[]
      )[0].token
    )
  );

  seccion('4. Barrera en el código');
  const RAIZ = join(__dirname, '..');
  const archivos = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) archivos(p, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
    return out;
  };
  const exentos = new Set([
    'src/lib/credenciales-ads.ts',
    'src/lib/clientes/config-pestanas.ts',
    'src/app/(app)/admin/settings/components/ClientConfigForm.tsx',
  ]);
  const escrituras: string[] = [];
  const usos: string[] = [];
  for (const f of archivos(join(RAIZ, 'src'))) {
    const rel = relative(RAIZ, f);
    if (exentos.has(rel)) continue;
    const lineas = readFileSync(f, 'utf8').split('\n');
    lineas.forEach((l, i) => {
      if (/^\s*(\*|\/\/)/.test(l)) return;
      // Escritura: `meta_token: …` / `tiktok_access_token: …` / `page_token: …` en un objeto.
      if (
        /\b(meta_token|tiktok_access_token)\s*:\s*[^\s,}]/.test(l) &&
        !/:\s*(string|unknown|any)\b/.test(l)
      ) {
        if (!/sellarToken\(/.test(l)) escrituras.push(`${rel}:${i + 1}`);
      }
      // Uso: `token: <algo con meta_token|access_token|.token>`.
      if (
        /\btoken\s*:\s*[^,}]*\b(meta_token|tiktok_access_token|a\.token|a\.access_token)\b/.test(l)
      ) {
        if (!/abrirToken\(/.test(l)) usos.push(`${rel}:${i + 1}`);
      }
    });
  }
  check(
    'toda escritura de un token de Meta/TikTok lo cifra',
    escrituras.length === 0,
    escrituras.join(', ')
  );
  check('todo uso contra la API lo descifra', usos.length === 0, usos.join(', '));
  const persisten = readFileSync(join(RAIZ, 'src/lib/report-utm/meta-leads.ts'), 'utf8');
  check(
    'meta-leads guarda pages y scoped_forms cifrados',
    /pages:\s*sellarPaginas\(/.test(persisten) && /scoped_forms:\s*sellarPaginas\(/.test(persisten)
  );
  const conexiones = readFileSync(
    join(RAIZ, 'src/app/(app)/admin/settings/[id]/_actions-conexiones.ts'),
    'utf8'
  );
  check(
    'la activación de Meta Lead Ads guarda las páginas cifradas',
    /pages:\s*sellarPaginas\(pages\)/.test(conexiones)
  );
  const acciones = readFileSync(join(RAIZ, 'src/app/(app)/admin/settings/_actions.ts'), 'utf8');
  check(
    'la ficha enmascara los tokens y ya no existe updateClienteConfig',
    /enmascararTokensAds\(/.test(acciones) &&
      !/export async function updateClienteConfig/.test(acciones)
  );

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} comprobación(es) fallida(s)`);
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
