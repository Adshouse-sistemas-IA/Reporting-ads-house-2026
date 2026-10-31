import 'server-only';

/**
 * Tokens de Meta y TikTok cifrados en reposo.
 *
 * Hasta esta versión `clientes.config_api` guardaba en claro `meta_token`,
 * `tiktok_access_token` y el token propio de cada cuenta (`meta_accounts[].token`,
 * `tiktok_accounts[].access_token`), y `report_utm.integrations.config` los page
 * tokens de Meta Lead Ads (`pages[].page_token`, `scoped_forms[].page_token`).
 * Quien leyera la fila —una copia de seguridad, un volcado, un log— tenía las
 * credenciales de las cuentas publicitarias de todos los clientes.
 *
 * ── Formato ─────────────────────────────────────────────────────
 * El valor cifrado ocupa la MISMA clave, con prefijo: `enc:v1:<iv:tag:texto>`
 * (AES-256-GCM, `RUTM_ENCRYPTION_KEY`, la misma clave que los secretos de
 * Hotmart). Mantener la clave tiene una ventaja decisiva: todo el código que
 * solo pregunta «¿hay token?» (planificador, puesta en marcha, salud de
 * fuentes, flags de conexión) sigue funcionando sin cambios. Solo descifran
 * los sitios que USAN el token contra la API, y lo hacen con `abrirToken`.
 *
 * ── Compatibilidad ──────────────────────────────────────────────
 * Un valor sin prefijo es un token heredado en claro y se devuelve tal cual: la
 * siguiente escritura lo guarda cifrado. En una instalación nueva no existe.
 *
 * ── Sin clave ───────────────────────────────────────────────────
 * `sellarToken` lanza si falta `RUTM_ENCRYPTION_KEY`: guardar en claro creyendo
 * que se cifró sería peor que fallar (mismo criterio que `cifrarSecreto`).
 * `abrirToken` nunca lanza: si no puede descifrar devuelve `''` y lo registra,
 * y el sitio que lo usa se comporta como «sin token» (no se manda basura a Meta).
 */

import { decrypt, encrypt } from '@/lib/report-utm/encryption';
import { PREFIJO_TOKEN_CIFRADO } from '@/lib/clientes/config-pestanas';

export { PREFIJO_TOKEN_CIFRADO };

type Dict = Record<string, unknown>;

export function esTokenCifrado(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIJO_TOKEN_CIFRADO);
}

/** Cifra un token. Vacío o ya cifrado: se devuelve igual. Lanza sin clave. */
export function sellarToken<T>(valor: T): T | string {
  if (typeof valor !== 'string' || valor.trim() === '' || esTokenCifrado(valor)) return valor;
  return PREFIJO_TOKEN_CIFRADO + encrypt(valor);
}

/** El token en claro para usarlo contra la API. Nunca lanza. */
export function abrirToken(valor: unknown): string {
  if (typeof valor !== 'string' || valor === '') return '';
  if (!esTokenCifrado(valor)) return valor; // heredado en claro
  try {
    return decrypt(valor.slice(PREFIJO_TOKEN_CIFRADO.length));
  } catch (e) {
    console.error(
      '[credenciales-ads] no se pudo descifrar un token (¿RUTM_ENCRYPTION_KEY distinta?):',
      e instanceof Error ? e.message : e
    );
    return '';
  }
}

function esObjeto(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Aplica `f` a cada token de Meta/TikTok de un `config_api`, sin mutar el original. */
function transformarConfigApi<T>(config: T, f: (v: unknown) => unknown): T {
  if (!esObjeto(config)) return config;
  const salida: Dict = { ...config };
  for (const clave of ['meta_token', 'tiktok_access_token'] as const) {
    if (clave in salida) salida[clave] = f(salida[clave]);
  }
  if (Array.isArray(salida.meta_accounts)) {
    salida.meta_accounts = salida.meta_accounts.map((a) =>
      esObjeto(a) && 'token' in a ? { ...a, token: f(a.token) } : a
    );
  }
  if (Array.isArray(salida.tiktok_accounts)) {
    salida.tiktok_accounts = salida.tiktok_accounts.map((a) =>
      esObjeto(a) && 'access_token' in a ? { ...a, access_token: f(a.access_token) } : a
    );
  }
  return salida as T;
}

/** `config_api` con los tokens de Meta/TikTok en claro (solo en memoria del servidor). */
export function abrirCredencialesAds<T>(config: T): T {
  return transformarConfigApi(config, abrirToken);
}

/** `config_api` con los tokens de Meta/TikTok cifrados, listo para guardar. Lanza sin clave. */
export function sellarCredencialesAds<T>(config: T): T {
  return transformarConfigApi(config, sellarToken);
}

/** Lista de páginas/formularios de Meta Lead Ads con su `page_token` cifrado. */
export function sellarPaginas<T>(lista: T): T {
  if (!Array.isArray(lista)) return lista;
  return lista.map((p) =>
    esObjeto(p) && 'page_token' in p ? { ...p, page_token: sellarToken(p.page_token) } : p
  ) as T;
}

/** Lista de páginas/formularios de Meta Lead Ads con su `page_token` en claro. */
export function abrirPaginas<T>(lista: T): T {
  if (!Array.isArray(lista)) return lista;
  return lista.map((p) =>
    esObjeto(p) && 'page_token' in p ? { ...p, page_token: abrirToken(p.page_token) } : p
  ) as T;
}
