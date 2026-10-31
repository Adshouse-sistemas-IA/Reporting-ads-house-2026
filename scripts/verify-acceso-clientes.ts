/**
 * Autorización del servidor por cliente.
 *
 * PURO: sin base ni red.
 *   1. La matriz de `decidirAccesoCliente` (src/lib/acceso/reglas.ts), que es
 *      el mismo criterio que `puede_ver_cliente` / `puede_operar_cliente` en
 *      SQL.
 *   2. Barrera en el código fuente: toda server action exportada que recibe un
 *      id de cliente, y toda ruta de API con sesión que lee un id de cliente y
 *      usa la service role, pasa por una guarda de `@/lib/acceso/clientes`.
 *      Hasta esta versión, decenas de acciones (p. ej. `getDashboardData`,
 *      `updateClienteConfig`, `deleteClienteTab`) y la ruta `/bi/query`
 *      aceptaban cualquier id: cualquier sesión leía o escribía cualquier
 *      cliente. Una acción nueva sin guarda hace fallar esta prueba.
 *
 *   npx tsx --conditions=react-server scripts/verify-acceso-clientes.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  decidirAccesoCliente,
  normalizarRol,
  esUuid,
  type NivelAcceso,
  type RolApp,
} from '../src/lib/acceso/reglas';
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

const RAIZ = join(__dirname, '..');
function archivos(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

/** Llamadas que cuentan como guarda. */
const GUARDA =
  /\b(exigirAccesoCliente|exigirAccesoClienteUtm|exigirAccesoClienteOToken|exigirClienteUtmOGlobal|exigirConsultaGlobal|exigirAccesoInforme|exigirSesion|guardaRuta|clientesUtmVisibles|clientesVisiblesDeUsuario)\(/;
/** Parámetros que son un id de cliente. */
const PARAM_CLIENTE =
  /^_?(clienteId|clientId|cliente_id|rtmClienteId|publicClienteId|clienteUtmId)$/;

/**
 * Excepciones con su motivo. Cada una es una acción que recibe un id de
 * cliente y NO usa la service role con él (o lo autoriza de otra forma).
 */
const ACCIONES_PERMITIDAS: Record<string, string> = {
  updateBitacora: 'escribe con la sesión del usuario: lo protege el RLS (bitacoras_update)',
  deleteBitacora: 'escribe con la sesión del usuario: lo protege el RLS (bitacoras_delete)',
};

/** Guardas que cuentan en la sección 2b (cualquier guarda de `@/lib/acceso`). */
const GUARDA_ACCESO = new RegExp(
  GUARDA.source.replace(')\\(', '|contextoAcceso|exigirAjustePlataforma|intentarGuarda)\\(')
);

/**
 * Acciones exportadas que usan la service role SIN guarda de `@/lib/acceso`,
 * con su motivo. Todo lo demás que use `createAdminClient` debe pasar por una.
 */
const SERVICE_ROLE_SIN_GUARDA: Record<string, string> = {
  getPublicBitacoras:
    'enlace público: resuelve un token de pestaña o cliente y solo da bitácoras públicas',
  getMirrorDashboardData: 'enlace público /p/[token]: resuelve el token y sanea config_api',
  sendTestNotification: 'exige admin y solo se notifica al propio usuario (audience = su id)',
};

async function main() {
  seccion('1. Reglas de acceso (src/lib/acceso/reglas.ts)');
  const base = { userId: 'u', clienteExiste: true, asignado: false };
  const d = (rol: RolApp, nivel: NivelAcceso, extra: Partial<typeof base> = {}) =>
    decidirAccesoCliente({ ...base, rol, nivel, ...extra });
  check(
    'sin sesión → 401',
    (() => {
      const r = d('admin', 'lectura', { userId: null as unknown as string });
      return !r.ok && r.status === 401;
    })()
  );
  check(
    'cliente inexistente → 404',
    (() => {
      const r = d('superadmin', 'lectura', { clienteExiste: false });
      return !r.ok && r.status === 404;
    })()
  );
  check(
    'admin/superadmin ven cualquier cliente',
    d('admin', 'lectura').ok && d('superadmin', 'operacion').ok
  );
  check('trafficker sin asignación → 404', !d('trafficker', 'lectura').ok);
  check(
    'trafficker asignado lee y opera',
    d('trafficker', 'lectura', { asignado: true }).ok &&
      d('trafficker', 'operacion', { asignado: true }).ok
  );
  check(
    'trafficker asignado no administra',
    (() => {
      const r = d('trafficker', 'admin', { asignado: true });
      return !r.ok && r.status === 403;
    })()
  );
  check(
    'viewer asignado lee pero no opera',
    d('viewer', 'lectura', { asignado: true }).ok &&
      !d('viewer', 'operacion', { asignado: true }).ok
  );
  check(
    'un rol desconocido cuenta como viewer',
    normalizarRol('root') === 'viewer' && normalizarRol('admin') === 'admin'
  );
  check(
    'esUuid rechaza ids con filtros inyectados',
    esUuid('10000000-0000-0000-0000-0000000000a1') &&
      !esUuid('x,cliente_id.is.null') &&
      !esUuid(undefined)
  );

  seccion('2. Server actions con id de cliente pasan por una guarda');
  const sinGuarda: string[] = [];
  let revisadas = 0;
  for (const f of archivos(join(RAIZ, 'src', 'app'))) {
    const texto = readFileSync(f, 'utf8');
    if (!/^\s*['"]use server['"]/.test(texto)) continue;
    const sf = ts.createSourceFile(f, texto, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const params = st.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
      if (!params.some((p) => PARAM_CLIENTE.test(p))) continue;
      revisadas++;
      if (ACCIONES_PERMITIDAS[st.name.text]) continue;
      if (!GUARDA.test(st.body.getText(sf)))
        sinGuarda.push(`${relative(RAIZ, f)} :: ${st.name.text}`);
    }
  }
  check(
    `las ${revisadas} acciones con id de cliente tienen guarda`,
    revisadas > 80 && sinGuarda.length === 0,
    sinGuarda.join('\n      ')
  );

  seccion('2b. Toda acción con service role pasa por una guarda');
  // Antes la barrera solo miraba las acciones que reciben un id de cliente. Las
  // de los paneles de administración (agente, sync, WhatsApp, reglas, marca)
  // no reciben ninguno, usaban la service role y solo comprobaban el rol —
  // algunas, ni la sesión: `getSyncPanelData` daba jobs y `logs` (respuestas
  // crudas de las APIs) a cualquiera; `listarCanales` o `listarContactos`, la
  // configuración del agente.
  const sinGuardaOrg: string[] = [];
  let conServiceRole = 0;
  for (const f of archivos(join(RAIZ, 'src', 'app'))) {
    const texto = readFileSync(f, 'utf8');
    if (!/^\s*['"]use server['"]/.test(texto)) continue;
    const sf = ts.createSourceFile(f, texto, ts.ScriptTarget.Latest, true);
    // Ayudantes locales (funciones y `const x = () => …`), un nivel.
    const ayudantes = new Map<string, string>();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) ayudantes.set(st.name.text, st.getText(sf));
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.initializer) ayudantes.set(d.name.text, d.getText(sf));
    }
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      let cuerpo = st.body.getText(sf);
      for (const [nombre, txt] of ayudantes)
        if (nombre !== st.name.text && new RegExp(`\\b${nombre}\\b`).test(cuerpo)) cuerpo += txt;
      if (!/createAdminClient\(/.test(cuerpo)) continue;
      conServiceRole++;
      if (SERVICE_ROLE_SIN_GUARDA[st.name.text]) continue;
      if (!GUARDA_ACCESO.test(cuerpo)) sinGuardaOrg.push(`${relative(RAIZ, f)} :: ${st.name.text}`);
    }
  }
  check(
    `las ${conServiceRole} acciones con service role pasan por una guarda de @/lib/acceso`,
    conServiceRole > 100 && sinGuardaOrg.length === 0,
    sinGuardaOrg.join('\n      ')
  );

  seccion('2c. OAuth: firmar o aceptar un state exige acceso al cliente');
  // El callback escribe el token en la configuración del cliente con la
  // service role: el `state` solo se firma y se acepta para un cliente que
  // quien llama administra.
  const oauthSinGuarda: string[] = [];
  let oauthRevisadas = 0;
  for (const f of archivos(join(RAIZ, 'src', 'app', 'api'))) {
    const texto = readFileSync(f, 'utf8');
    if (
      !/\b(firmarStateCliente|firmarState|verificarStateCliente|verificarState|verificarStateGoogle)\(/.test(
        texto
      )
    )
      continue;
    oauthRevisadas++;
    if (!/\b(exigirAccesoCliente|exigirAjustePlataforma)\(/.test(texto))
      oauthSinGuarda.push(relative(RAIZ, f));
  }
  check(
    `las ${oauthRevisadas} rutas OAuth (inicio y callback) comprueban el cliente o la plataforma`,
    oauthRevisadas >= 8 && oauthSinGuarda.length === 0,
    oauthSinGuarda.join(', ')
  );

  seccion('3. Rutas de API con sesión que leen un id de cliente');
  // Rutas con credencial propia (no de usuario): cron/worker (CRON_SECRET),
  // v1/mcp (token de API), webhooks y píxel (HMAC o token del cliente),
  // informes públicos (token del informe), OAuth (state firmado).
  const PROPIA =
    /\/api\/(cron|worker|v1|mcp|auth|health)\/|\/webhooks\/|\/pixel\/|\/bi\/public\/|\/agent\/whatsapp\/|\/api\/backfill-forms\//;
  const sinGuardaRuta: string[] = [];
  let rutas = 0;
  for (const f of archivos(join(RAIZ, 'src', 'app', 'api'))) {
    if (!f.endsWith('route.ts') || PROPIA.test(f.replace(/\\/g, '/'))) continue;
    const texto = readFileSync(f, 'utf8');
    const leeCliente =
      /(get\('(cliente_id|clientId|public_cliente_id)'\)|body\??\.cliente_id|\{\s*clienteId|\bclientId\b|params;\s*$|leerFiltros\(|parseBiQueryParams\(|reportId)/m.test(
        texto
      );
    const servicio =
      /createAdminClient|reportUtmAdminClient|dispatchBiQuery|SUPABASE_SERVICE_ROLE_KEY/.test(
        texto
      );
    if (!leeCliente || !servicio) continue;
    rutas++;
    if (!GUARDA.test(texto)) sinGuardaRuta.push(relative(RAIZ, f));
  }
  check(
    `las ${rutas} rutas con id de cliente y service role tienen guarda`,
    rutas > 20 && sinGuardaRuta.length === 0,
    sinGuardaRuta.join('\n      ')
  );

  seccion('4. Listas de clientes acotadas al usuario');
  const acceso = readFileSync(join(RAIZ, 'src', 'lib', 'acceso', 'clientes.ts'), 'utf8');
  check(
    'clientesVisiblesDeUsuario: admin todos; el resto, solo sus asignaciones',
    /esRolAdmin\(rol\)/.test(acceso) && /user_client_assignments/.test(acceso)
  );
  const settings = readFileSync(
    join(RAIZ, 'src', 'app', '(app)', 'admin', 'settings', '_actions.ts'),
    'utf8'
  );
  check(
    'getClientes usa la lista de visibles (antes un viewer recibía todos)',
    /export async function getClientes\(\)[\s\S]{0,600}clientesVisiblesDeUsuario\(/.test(settings)
  );

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} comprobación(es) fallida(s)`);
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
