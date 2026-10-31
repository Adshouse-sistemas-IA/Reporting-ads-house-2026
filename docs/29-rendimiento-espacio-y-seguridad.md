# 29 · Rendimiento, espacio y seguridad de la base (2026-10-31)

Mejoras de base de datos y de servidor de rendimiento, espacio y seguridad, sin ningún cambio de producto. Todo está en la rama `mejoras-rendimiento-seguridad`.

## 1 · Estado de partida (producción, 2026-10-31, solo lectura)

| Medida                                      | Valor                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tamaño de la base                           | **625 MB**                                                                                        |
| `report_utm.lead_events`                    | 286 MB (Eduversio: ~96.000 leads, ~130 MB)                                                        |
| `report_utm.pixel_events`                   | 123 MB, sin filas nuevas desde el 2026-09-21                                                      |
| `page_url` con parámetros duplicados        | 90.297 filas, 42 MB → 5 MB al limpiarlas                                                          |
| Funciones ejecutables con la clave pública  | Las 55 de `public` y `report_utm`, entre ellas las `SECURITY DEFINER` de GA4 y `claim_agent_turn` |
| Políticas con un correo fijo                | 20 (`robinson@adshouse.com`)                                                                      |
| Registro público en Supabase Auth           | Abierto (`disable_signup = false`)                                                                |
| Tokens de Meta/TikTok y de páginas en claro | 42                                                                                                |

## 2 · Qué cambia

### Base de datos (`migrations/104`–`109`)

| Migración                              | Qué hace                                                                                                                                                                                             | Medido                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `104_rpc_planes_por_llamada`           | `plan_cache_mode = force_custom_plan` en las seis RPC calientes; `ads_entidades_ids` y la atribución de Hotmart pasan a plpgsql; la atribución usa dos ramas indexadas (email, teléfono) con `UNION` | 6.ª llamada de `ads_daily_resumen`: 5,8–6,9 s → ~0,45 s; webhook de Hotmart: 562 ms → 0,4 ms |
| `105_indice_ads_daily_entidades`       | Índice `(cliente_id, plataforma, nivel, entidad_id, fecha DESC)` en lugar de `idx_ads_daily_entidad_id` (0 lecturas)                                                                                 | 533 ms y 16 MB de temporales → 45 ms y 0                                                     |
| `106_cola_espera_y_dueno`              | `sync_jobs.disponible_desde` (espera creciente entre reintentos), exclusión por cliente dentro de `claim_sync_job`, heartbeat que dice si el ejecutor sigue siendo el dueño; solo service role       | 30–33 solapes del mismo cliente por carga → 0                                                |
| `107_retencion_leads`                  | `report_utm.clientes.retencion_leads_meses` (NULL = todo, mínimo 6) y bucket privado `archivo-leads`                                                                                                 | —                                                                                            |
| `108_funciones_y_privilegios_sin_anon` | Ninguna función ni tabla al alcance de `anon` salvo leer la marca; las RPC de GA4 y del agente solo para la service role; fuera TRUNCATE para `authenticated`                                        | —                                                                                            |
| `109_politicas_rls_por_cliente`        | Fuera los correos fijos y los `USING (true)`; leads, informes, pestañas y cola por cliente asignado; el permiso se calcula una vez por consulta; todo `TO authenticated`                             | Contar 93.000 leads con sesión: 57,9 s → 131 ms                                              |

Cada migración es idempotente y lleva su reversión en la cabecera. La de la 109 está entera en [revertir/109_politicas_previas.sql](./revertir/109_politicas_previas.sql) (volcado de producción).

Cambia lo que ve cada rol **con su sesión** (con la service role, que es casi toda la app, no cambia nada):

| Rol                    | Antes                                                                                                          | Después                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| superadmin, admin      | Todo                                                                                                           | Todo                                |
| trafficker             | Leads, informes, cola y pestañas de **todos** los clientes                                                     | Solo los de sus clientes asignados  |
| viewer                 | Sin leads; informes y cola de todos                                                                            | Sin leads; informes de sus clientes |
| Clave pública (`anon`) | Ejecutar las 55 funciones; leer informes compartidos con su token; leer y escribir el catálogo de conversiones | Solo la marca del login             |

### Servidor

- **Guardas por cliente** (`src/lib/acceso/`): las 90 acciones con id de cliente, las 135 que usan la service role, las 8 rutas OAuth y las 26 rutas de API pasan por una guarda. Antes, cualquier sesión (también una cuenta recién registrada) podía leer o cambiar cualquier cliente, p. ej. `/api/report-utm/bi/query` solo exigía sesión. `scripts/verify-acceso-clientes.ts` hace fallar el CI si aparece una acción o ruta nueva sin guarda.
- **Paneles de administración**: `getSyncPanelData` (jobs y `logs` crudos de las APIs) y las lecturas del agente (`listarCanales`, `listarContactos`…) no comprobaban ni la sesión.
- **Usuarios**: un trafficker podía bajar a viewer a cualquiera, también al superadmin; cambiar rol y borrar fallan cerrado si no se puede leer el otro perfil; el alta valida rol y clientes antes de crear y se deshace si la asignación falla (antes devolvía éxito); reasignar clientes ya no borra todo antes de insertar.
- **Registro público cerrado** en la app (`/signup` lleva al login).
- **Tokens cifrados en reposo** (`src/lib/credenciales-ads.ts`): los tokens de Meta/TikTok y los de página de Lead Ads se guardan como `enc:v1:…` con `RUTM_ENCRYPTION_KEY` y el navegador solo recibe `SECRETO_GUARDADO`. Un token heredado en claro se sigue usando tal cual.
- **Cola** (`src/lib/sync/queue.ts`, `runner.ts`): espera entre reintentos y transiciones que exigen ser el dueño del lease; `limpiarHistorial` comprueba el error de cada borrado.
- **Retención de leads** (`src/lib/report-utm/archivo-leads.ts`): para un cliente con `retencion_leads_meses`, la purga diaria pasa cada mes antiguo a CSV comprimido, lo relee y solo entonces lo borra.

## 3 · Pruebas

`npm run validate` y `npm run test:puro` pasan. Nuevas en `test:puro`:

- `verify-migraciones-rendimiento-seguridad.ts`: base PGlite con el historial 001–103 (`scripts/bd-local/`), aplica 104–109 dos veces, compara fila a fila las RPC reescritas y prueba qué ve cada rol.
- `verify-cola-sync.ts`, `verify-archivo-leads.ts`, `verify-acceso-clientes.ts`, `verify-credenciales-ads.ts`.

No hay staging (`.env.staging.local`): la base reconstruida es una aproximación de producción.

## 4 · Orden de despliegue

Cada paso que toca producción necesita la aprobación del dueño (docs/00 §4).

1. **Migraciones 104, 105, 106 y 107.** Solo añaden o son compatibles con el código actual.
   `npx tsx scripts/sql-remoto.ts migrations/104_rpc_planes_por_llamada.sql` (y así cada una).
2. **Migraciones 109 y 108**, en la misma ventana. No dependen del código nuevo.
3. **Desplegar la app y el `sync-worker` juntos** (la cola nueva escribe `disponible_desde`).
4. **Cerrar el registro en Supabase Auth**: Authentication → Sign In / Providers → «Allow new users to sign up» apagado.
5. **Cifrar los tokens existentes**: `npx tsx --conditions=react-server scripts/cifrar-tokens-existentes.ts` (en seco) y luego con `--aplicar`. Antes de escribir comprueba que la `RUTM_ENCRYPTION_KEY` local descifra los secretos de producción.
6. **Espacio** (operaciones, no migraciones):
   - `npx tsx --conditions=react-server scripts/backfill-page-url.ts --aplicar` (por lotes, reanudable).
   - Retención por cliente: `update report_utm.clientes set retencion_leads_meses = 6 where id = '<id>'`. El primer archivo se genera en la purga diaria siguiente.
   - `VACUUM FULL` de `lead_events`, `ads_daily` y, cuando se vacíe, `pixel_events`. Bloquea la tabla mientras dura: en una ventana sin tráfico.

## 5 · Lo que no se trasladó

- Multi-tenant (organizaciones) y cambios de interfaz.
- Alertas, notificaciones y agente por organización (en AdsHouse hay una sola empresa).
- Correcciones de comportamiento que no son de rendimiento ni de seguridad (p. ej. caducidad de un token de Meta pegado a mano, reintentos de GoHighLevel ante 429).
