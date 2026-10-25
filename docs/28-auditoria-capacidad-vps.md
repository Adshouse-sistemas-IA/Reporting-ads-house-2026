# Auditoría de capacidad: AdsHouse Reporting en un VPS Hostinger (KVM 4 vs KVM 8)

Fecha: 2026-10-25 · Alcance: este repositorio (app Next.js, `sync-worker`, base Supabase) · Modo: solo lectura. No se ejecutó ninguna prueba de carga.

**Leyenda de la fuente de cada dato:**

- **MEDIDO**: consultado en producción con SQL de solo lectura sobre `pg_stat_*` y tablas de registro, el 2026-10-25.
- **CÓDIGO**: confirmado leyendo el código o la configuración del repositorio.
- **DOC**: tomado de `docs/` (informe de entrega del 2026-09-30).
- **INFERIDO / ESTIMADO**: razonamiento propio. No es una medición.
- **NO DISPONIBLE**: no hay datos accesibles. No se ha inventado ninguna cifra.

---

## 1. Resumen ejecutivo

- **Hoy la carga es muy baja.** Postgres promedia **1,4 transacciones/s** y su tiempo de ejecución equivale al **0,45 % de un núcleo** (MEDIDO, ventana de 32,6 días). Hay 7 clientes, 4 usuarios activos en 30 días y unos 925 leads al día (máximo 133 por hora y 8 por minuto).
- **El tamaño del VPS no es el límite principal de esta app, sino su diseño:**
  1. **Informes BI** (CÓDIGO): cada widget pide su propia consulta. El servidor descarga todas las filas de leads del rango, en páginas secuenciales de 1.000, y agrega en memoria de Node. Un informe tiene de media unos 11 widgets y hasta 34 (MEDIDO, aprox.). El cliente mayor genera 18.353 leads en 30 días, unas 19 páginas por widget. Es el primer punto que se degrada con usuarios concurrentes.
  2. **La app es un único proceso Node** (CÓDIGO: `node server.js`, sin réplicas). El trabajo de CPU (parsear JSON, agregar, fórmulas) usa como máximo ~1 vCPU, sea cual sea el VPS.
  3. **El `sync-worker` ejecuta los trabajos de uno en uno** (CÓDIGO). Un día normal ocupa 10–31 minutos, pero el cierre de mes del 7 de octubre ocupó **5,9 horas** seguidas (MEDIDO). Con más clientes, esto crece de forma lineal y no depende de la CPU.
  4. **Límite de 8 s por consulta** (MEDIDO, rol `authenticator`). Ya hay consultas de leads con máximos de 7,4–7,8 s. Bajo carga se cortan y el widget sale vacío.
- **El riesgo real de RAM está en el VPS compartido,** no en esta app sola: Supabase autoalojado completo, Dokploy, n8n, otras apps, el futuro sistema de agentes y, sobre todo, los `next build`, que necesitan ~2 GB cada uno (DOC).
- **Veredicto provisional:**
  - **KVM 4: viable con condiciones** para esta app dentro del VPS compartido. Las condiciones son: compilar las imágenes fuera del VPS, poner límites de memoria en Docker, ajustar Supabase (desactivar `analytics` si no se usa) y copias de seguridad externas.
  - **KVM 8: recomendable** si las otras apps tienen un tamaño parecido o si el sistema de agentes ejecutará procesos pesados en local.
  - Ningún tamaño arregla el techo del BI: eso requiere cambios de código (sección 9).

---

## 2. Arquitectura y mapa de procesos

### 2.1 Servicios y procesos (CÓDIGO salvo indicación)

| Servicio | Imagen / proceso | Puerto | Estado | Notas de recursos |
|---|---|---|---|---|
| App web | `Dockerfile`: `node:22-alpine`, Next.js 16 `output: standalone`, `node server.js` | 3000 | En Dokploy | Un único proceso. Sin `NODE_OPTIONS` ni `--max-old-space-size`. Sin estado en disco. Healthcheck cada 30 s |
| sync-worker | `sync-worker/Dockerfile`: Express + `node-cron` | 8080 | En Dokploy, sin dominio | Revisa la cola cada 15 s, procesa 1 trabajo a la vez en tandas de 10 min y espera hasta 120 s por llamada (240 s para `meta_leads`). Logs limitados a 3×10 MB |
| Base de datos | Supabase en la nube (Postgres 17.6, PostgREST, Auth, Storage, Realtime) | — | Plan Pro, cómputo Micro | Sustituido por Supabase autoalojado si se migra |
| Respaldo de la cola | GitHub Actions `sync-fallback.yml` (:07 y :37) | — | Fuera del VPS | Llama a `/api/worker/run-jobs` y a `/api/worker/health` |
| WhatsApp | Evolution API (`WHATSAPP_PROVIDER` definido en `.env.local`) o `whatsapp-gateway/` (Baileys) | — | INFERIDO: Evolution está fuera de este repo | Si se aloja en el mismo VPS, sumar su contenedor |
| Plugin WordPress / píxel JS | En los sitios de los clientes | — | Externo | Generan tráfico de entrada (webhooks y S2S) |

### 2.2 Dependencias externas (CÓDIGO)

- **APIs de datos:** Meta Graph, TikTok Business, Hotmart, GA4 / Google APIs, GoHighLevel (LeadConnector) y Google Sheets. Las URL base están fijas en el código, en unos 45 sitios.
- **IA:** OpenRouter (`src/lib/agent/llm/client.ts`), con 3 niveles de modelo y cadena de reserva. Máximo **8 iteraciones** por turno del agente. **No hay transcripción de audio** en este repo, ni Groq/Whisper como servicio. Toda la inferencia es remota: en el VPS solo cuesta esperar la red.
- **Correo:** `nodemailer` con Gmail.
- **Límites salientes por plataforma** (`src/lib/rate-limit.ts`, en memoria del proceso): Meta 6 en paralelo con 120 ms entre arranques, TikTok 4 con 150 ms, Hotmart 3 y GA4 5.

### 2.3 Trabajos en segundo plano (CÓDIGO)

| Horario (Colombia) | Qué hace |
|---|---|
| Cada 15 s | Revisa la cola `sync_jobs`, con espera exponencial ante fallos de hasta 10 min |
| 05:00 y 14:00 | Plan diario: métricas, leads de Meta/TikTok/GHL, Sheets, GA4, conciliación de Hotmart y purgas |
| 02:00 | Renovación de tokens de Meta |
| Cada 2 h | Renovación de tokens de Hotmart |
| Domingo 03:00 | Conciliación del gasto de Meta |
| Día 7, 03:00 | Cierre de mes |

**Webhooks de entrada:** Meta Lead Ads, GHL (leads y ventas), Hotmart, S2S de WordPress y el píxel.

### 2.4 Endpoints con mayor coste (CÓDIGO + MEDIDO)

| Endpoint | Por qué es caro | Evidencia |
|---|---|---|
| `/api/report-utm/bi/query` y `/bi/public/[token]/query` | Un widget = una petición. `fetchAllRows` descarga leads, ventas y Hotmart en páginas secuenciales de 1.000 (tope de 200.000 filas) y filtra y agrega en Node | `src/lib/report-utm/bi-query.ts` (líneas 1253, 1454, 1608 y 2872). Sin caché de resultados |
| Dashboard (Server Components + `formula-engine`) | Lee `metricas_diarias` con columnas JSONB (desgloses por campaña) | MEDIDO: 11.196 llamadas, media 59,5 ms, máximo 4,3 s. `SELECT metricas_diarias.*`: media 78,6 ms, máximo 7,6 s |
| `/api/report-utm/leads/export` (CSV) | Recorre los leads filtrados del rango | CÓDIGO |
| `/api/agent/chat`, `/api/agent/whatsapp/inbound`, `/api/mcp` | Hasta 8 iteraciones con llamadas a herramientas que consultan la base | CÓDIGO. El coste local es de base de datos, no de CPU |
| `/api/worker` (métricas) | Paginación de Meta/TikTok y upserts JSONB | MEDIDO: media 37,9 s, p95 85,9 s, máximo 120,1 s |

### 2.5 Generación de informes y exportaciones

- **PDF:** `jspdf` + `html2canvas` se ejecutan **en el navegador** (CÓDIGO). No consumen CPU del servidor.
- **Resumen semanal de BI y de WhatsApp:** `/api/cron/bi-report-digest` y `/api/cron/whatsapp-digest`. Están definidos, pero **no aparecen en el planificador del worker** (CÓDIGO). INFERIDO: hoy no corren solos o los dispara otra cosa; hay que confirmarlo.
- **Compilación:** `next build` necesita ~2 GB de RAM (DOC) y usa todos los núcleos durante varios minutos (INFERIDO).

---

## 3. Consumo actual medido

Ventana de las estadísticas de Postgres: desde el 2026-09-22 13:26 UTC (último reinicio) hasta el 2026-10-25, **32,6 días**.

### 3.1 Base de datos (MEDIDO)

| Indicador | Valor |
|---|---|
| Tamaño | 613 MB (580 MB el 30-sep → +1,4 MB/día) |
| Transacciones | 3.953.354 confirmadas (**1,40/s de media**) y 28.052 revertidas (0,7 %) |
| Sentencias (`pg_stat_statements`) | 3.422.375 (**1,21/s**). Sin Realtime: **0,80/s** |
| Tiempo de ejecución total | 12.680 s = **0,45 % de un núcleo** de media |
| **Realtime** (sondeo del WAL para la campanita) | 1.178.726 llamadas y 6.299 s = **50 % de todo el tiempo de la base**. Máximo 14,8 s |
| Acierto de caché | 99,95 % |
| Archivos temporales | 332 archivos y 1,87 GB escritos a disco por `work_mem` = 3,5 MB. Lo principal es una RPC con `p_cliente_id` (1.248 llamadas, media 293 ms) |
| Bloqueos mutuos (deadlocks) | 0 |
| Conexiones (foto) | 20 abiertas (13 de PostgREST, todas inactivas), máximo 60. Otra foto del 24-oct: 34 |
| Ajustes | `shared_buffers` 256 MB, `work_mem` 3,5 MB, `effective_cache_size` 768 MB, `max_connections` 60, 2 workers paralelos |
| Límites por rol | `authenticator` y `authenticated`: 8 s; `anon`: 3 s; `lock_timeout` 8 s; `safeupdate` activo |
| Tablas más leídas por recorrido completo | `lead_events`: 579 recorridos completos y 7,7 M filas leídas así (frente a 31.416 por índice) |

### 3.2 Consultas más costosas (MEDIDO, texto parametrizado y recortado)

| Consulta (resumen) | Llamadas | Media | Máximo | Tiempo total |
|---|---|---|---|---|
| Realtime: sondeo del WAL | 1.178.726 | 5,3 ms | 14,8 s | 6.299 s |
| `metricas_diarias` con `meta_campaigns` (JSONB) | 11.196 | 59,5 ms | 4,3 s | 666 s |
| INSERT en `lead_events` (webhooks) | 23.860 | 19 ms | 3,1 s | 453 s |
| `metricas_diarias.*` | 5.468 | 78,6 ms | 7,6 s | 430 s |
| Página de `lead_events` (BI/listados) | 4.074 | 92 ms | 7,5 s | 375 s |
| RPC con `p_cliente_id` (escribe a disco temporal) | 1.248 | 293 ms | 7,2 s | 366 s |
| `lead_events` con `raw_fields` | 622 | 349 ms | 7,4 s | 217 s |
| `lead_events` por `utm_campaign` | 108 | 1.083 ms | 7,4 s | 117 s |
| `lead_events` (varias columnas, sin índice adecuado) | 19 | **4.459 ms** | 7,8 s | 85 s |

**Lectura:** las consultas lentas son casi todas sobre `lead_events`. Varias rozan el corte de 8 s.

### 3.3 Sincronizaciones (MEDIDO, últimos 30 días)

| Tipo | Ejecuciones | Media | p95 | Máximo |
|---|---|---|---|---|
| `metricas` (worker) | 711 (452 `ok`, 258 `partial` por corte de presupuesto con cursor, 1 `error`) | 37,9 s | 85,9 s | 120,1 s |
| `metricas` (app/respaldo) | 435 | 20,6 s | 42,6 s | 64,9 s |
| `meta_leads` | 79 (19 no `ok`) | 99,0 s | 120,7 s | 227,2 s |
| `sheets_conversiones` | 119 | 10,4 s | 15,5 s | 31,2 s |
| `ga4` | 51 | 4,2 s | 5,8 s | 14,9 s |
| Resto (GHL, TikTok, Hotmart, conciliación) | — | 0,2–5,5 s | ≤ 21 s | ≤ 22 s |

- **Cola:** 1.626 trabajos en 30 días, todos `done`. Ninguno quedó en error.
- **Tiempo ocupado del worker al día:** 10–31 minutos normalmente. **351,6 minutos el 2026-10-07** (cierre de mes, 326 ejecuciones).
- **Horas de más actividad (Colombia):** 05 h (456 ejecuciones y 184 min en 30 días), 08 h, 14 h y 03 h.

### 3.4 Tráfico de negocio (MEDIDO)

| Indicador | Valor |
|---|---|
| Leads en 30 días | 27.746 (de 5 clientes con leads; el mayor tiene 18.353) |
| Leads por hora | media 38,5 · p95 81 · p99 103 · **máximo 133** |
| Leads por minuto (7 días) | p99 5 · **máximo 8** |
| Leads por día | máximo 1.697 (2026-10-22) |
| Eventos del píxel en 30 días | 0. El píxel no está enviando eventos ahora |
| Informes BI | 19 · media ~11,2 widgets · máximo ~34. Aprox.: se contaron nodos con `type` en el layout |
| Usuarios | 7 (4 entraron en los últimos 30 días) |
| Notificaciones | 502 en 30 días |
| Storage | 3 archivos, 96 kB |

### 3.5 Lo que NO está disponible

- **CPU y RAM del VPS y por contenedor** (app, worker): sin acceso a Dokploy ni al servidor.
- **Latencias HTTP p50/p95/p99 y peticiones por segundo:** la app no tiene APM. La API de registros de Supabase devolvió «Too Many Requests» en todos los intentos.
- **CPU y RAM de la instancia de Supabase en series de 24 h, 7 d y 30 d:** solo están en el panel de Supabase.
- **Eventos OOM y reinicios de contenedores:** sin acceso a `dmesg` ni a Docker.
- **IOPS, transferencia de red y uso de disco del VPS.**

---

## 4. Máximo histórico observado

| Qué | Pico observado | Fecha | Fuente |
|---|---|---|---|
| Caída total de la base por memoria (cómputo Micro, 1 GB) | 503 en toda la API, entre 150 y 245 errores de `statement timeout` por hora y 5.045 respuestas 503 en 6 h | 2026-09-20/21 | DOC |
| Tiempo ocupado del worker en un día | 351,6 min | 2026-10-07 | MEDIDO |
| Duración de un trabajo | 227,2 s (`meta_leads`) | últimos 30 d | MEDIDO |
| Leads por hora / minuto / día | 133 / 8 / 1.697 | últimos 30 d / 7 d / 30 d | MEDIDO |
| Consulta de la app más lenta | 7,8 s (casi en el corte de 8 s) | desde el 22-sep | MEDIDO |
| Conexiones | 34 de 60 (en una foto). No hay serie histórica | 2026-10-24 | MEDIDO (foto) |

> Estos son máximos **observados**, no máximos posibles. Con 4 usuarios activos, la app no ha sido sometida nunca a concurrencia real.

---

## 5. Escenarios de demanda estimados

**Supuestos comunes** (todos INFERIDOS):

- **Un usuario concurrente** que navega dashboards genera 0,2–0,5 peticiones/s de media. Al abrir un informe BI, lanza tantas peticiones como widgets: unas 11 de media y hasta 34, casi a la vez.
- **Un widget del cliente mayor** con 30 días de rango lee unas 19 páginas de 1.000 leads en serie, a 90–350 ms por página. Eso da **1,7–6,6 s por widget**.
- **Memoria en Node:** 0,5–1,5 kB por fila de lead ya parseada. Un widget pesado retiene así 9–27 MB mientras se ejecuta.
- **Cifras de CPU y RAM:** cubren app + worker + la parte de Postgres de esta app. **No** incluyen el resto de Supabase, Dokploy ni las otras apps (ver sección 8).
- **Confianza:** A media; B media-baja; C, D y E baja. Hacen falta las pruebas de la sección 7 para confirmarlas.

| Escenario | Usuarios concurrentes | Peticiones/s (ráfaga) | SQL/s | Notas |
|---|---|---|---|---|
| **A. Normal** | 1–2 | 0,5–2 | 1–5 | Leads ~0,01/s. Worker activo 10–30 min al día |
| **B. Pico habitual** | 3–5 + 1–2 enlaces públicos abiertos | 10–40 durante 5–20 s al abrir informes | 20–80 | Coincide con el plan de las 05:00 o las 14:00 y leads p99 (103/h) |
| **C. Pico alto (3×)** | 10–15 | 30–100 | 60–250 | 3× clientes y leads: el cierre de mes pasaría a ~18 h en serie |
| **D. Estrés (5–10×)** | 20–50 | 50–300 | 100–600 | Punto de degradación previsto |
| **E. Peor coincidencia** | 5 abriendo informes grandes | 30–60 | 60–200 | + cierre de mes + leads máximos (133/h) + 2–3 turnos de agente + un `next build` de otra app en el mismo VPS |

**Riesgos por escenario:**

- **A:** ninguno relevante.
- **B:** con 3 o más informes grandes abiertos a la vez se acercan los cortes de 8 s y hay ráfagas de RAM de 0,5–1 GB en Node.
- **C:** el proceso de la app queda limitado a 1 núcleo y las peticiones se encolan. El pool de PostgREST (~10–20 conexiones) se satura, hay timeouts y widgets vacíos (errores silenciosos ya documentados). El worker no termina el cierre de mes.
- **D:** posible OOM del contenedor de la app si no tiene límite y `max-old-space-size`. Latencias p95 por encima de 8 s y fallos.
- **E:** el `next build` compite por CPU y RAM (2–3 GB y todos los núcleos durante minutos). En un KVM 4, es el escenario que con más probabilidad provoca un OOM en el host o deja a Postgres sin memoria.

---

## 6. Cuellos de botella (por orden de impacto)

1. **BI con agregación en Node** (CÓDIGO): coste proporcional a filas × widgets × usuarios. Consume RAM, CPU de un solo hilo y conexiones a la vez.
2. **Un solo proceso Node** (CÓDIGO): un VPS más grande no acelera la app si no hay más réplicas.
3. **Consultas sobre `lead_events` cerca del corte de 8 s** (MEDIDO): con concurrencia, el corte llega antes.
4. **Worker en serie** (CÓDIGO + MEDIDO): limita cuántos clientes caben en el cierre de mes, no la CPU.
5. **`work_mem` de 3,5 MB** (MEDIDO): 1,87 GB escritos a disco temporal. Se corrige con configuración al autoalojar.
6. **Realtime** (MEDIDO): la mitad del tiempo de la base para una campanita de notificaciones.
7. **Compilaciones en el mismo VPS** (DOC): el mayor pico de RAM previsible.

---

## 7. Plan de pruebas de carga (para aprobación: no se ha ejecutado nada)

### 7.1 Entorno aislado

1. **VPS de staging** (o el KVM candidato antes de mover producción) con Dokploy, Supabase autoalojado, la app y el worker con **los mismos límites Docker** que se usarán en producción.
2. **Datos:**
   - **Opción A (recomendada):** generador sintético que reproduzca los volúmenes medidos: 7 clientes, ~124.000 leads, un cliente con 18.000 leads/mes, 19 informes con 11–34 widgets y `metricas_diarias` con JSONB de tamaño parecido.
   - **Opción B:** `pg_dump` de producción y anonimización **antes** de salir del entorno seguro (nombres, correos, teléfonos, `raw_fields` e IP sustituidos por valores falsos). Exige tu aprobación y un lugar seguro para el volcado.
3. **Simular las integraciones sin llamar a Meta, TikTok, Hotmart, GA4, GHL ni OpenRouter.** Las URL están fijas en el código (~45 sitios), así que hay dos caminos:
   - **Sin cambiar código:** contenedor de simulación (WireMock o un Express pequeño) con respuestas grabadas de forma sintética. En los contenedores de staging, `extra_hosts` hace que `graph.facebook.com`, `business-api.tiktok.com`, `openrouter.ai`, etc. apunten a ese contenedor, y se usa un certificado propio con `NODE_EXTRA_CA_CERTS`. Las credenciales de staging son falsas, así que una fuga de configuración no llegaría a ninguna API real.
   - **Con un cambio de código (requiere aprobación):** centralizar las URL base en variables de entorno (`META_API_BASE`, `OPENROUTER_BASE`…). Es más limpio y sirve para siempre.
   - La simulación añade latencias realistas: 300–1.500 ms por página de Meta, 2–8 s por turno de LLM y errores 429 en un 2 %.
4. **Observabilidad:**
   - cAdvisor + Prometheus + Grafana, o Netdata, para CPU, RAM, OOM y E/S por contenedor.
   - `pg_stat_statements` y `pg_stat_activity` muestreados cada 10 s.
   - Resumen de k6 y logs de acceso de Traefik con tiempos de respuesta.

### 7.2 Herramienta: k6

Es scriptable en JS, permite escenarios por tasa de llegada y define umbrales en el propio script. Esqueleto (se lanza **solo contra staging**):

```js
// k6/escenarios.js — SOLO STAGING. BASE apunta al dominio de staging.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE; // p. ej. https://staging-reportes.example
const TOKEN = __ENV.TOKEN_PUBLICO; // enlace público de un informe sintético
const WIDGETS = JSON.parse(open('./widgets.json')); // parámetros de los 34 widgets

export const options = {
  scenarios: {
    referencia: { executor: 'constant-vus', vus: 1, duration: '5m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{tipo:interactivo}': ['p(95)<2000'],
    'http_req_duration{tipo:widget_bi}': ['p(95)<5000'],
  },
};

export default function () {
  // Abrir un informe = todos sus widgets a la vez (como el navegador)
  const reqs = WIDGETS.map((w) => ['GET', `${BASE}/api/report-utm/bi/public/${TOKEN}/query?${w}`, null, { tags: { tipo: 'widget_bi' } }]);
  const res = http.batch(reqs);
  res.forEach((r) => check(r, { '200': (x) => x.status === 200 }));
  sleep(20 + Math.random() * 40); // lectura del informe
}
```

**Tráfico de webhooks:** otro script envía leads sintéticos firmados con el secreto de staging a `/api/report-utm/pixel/s2s` y a `/api/report-utm/webhooks/meta`, a la tasa medida: 38/h de media, ráfagas de 8/min y, en estrés, 10× (80/min).

### 7.3 Pruebas

| # | Prueba | Perfil | Duración | Qué mide |
|---|---|---|---|---|
| 1 | Referencia | 1 usuario + webhooks a tasa media | 15 min | Latencias base, RAM en reposo de cada contenedor |
| 2 | Concurrencia creciente | 1 → 50 usuarios en escalones de 5 cada 3 min (mezcla 70 % dashboard / 30 % informe BI) | ~30 min | Punto en que p95 > 2 s, errores > 1 % o aparecen timeouts de 8 s |
| 3 | Carga sostenida | Escenario B (5 usuarios) y C (15 usuarios) | 60 min cada uno | Estabilidad, fugas de memoria, conexiones |
| 4 | Picos repentinos | De 2 a 30 usuarios en 10 s, 3 veces | 20 min | RAM pico de Node, cola de PostgREST, recuperación |
| 5 | Resistencia | Escenario A ×2 | 8–12 h, de noche | Fugas de memoria, crecimiento de disco y logs, autovacuum |
| 6 | Coincidencia de trabajos pesados | Escenario B + plan de cierre de mes encolado (APIs simuladas) + webhooks 10× + 3 turnos de agente simulados + un `docker build` de otra app | 90 min | Escenario E: OOM, CPU robada, retrasos de la cola |
| 7 | Recuperación | Tras la 4 y la 6: carga a 0 | 30 min | Vuelta a la RAM y latencia base; cola vaciada; ningún trabajo en `error` ni lease colgado |

### 7.4 Umbrales de aprobación (ajustados a la app)

- **Cero** eventos OOM (host y contenedores) y **cero** reinicios no planificados.
- **Cero** pérdida de datos: los leads enviados coinciden con las filas en `lead_events`, y los trabajos encolados terminan en `done`.
- Errores HTTP < 1 % y **cero** respuestas con widget vacío por timeout (ojo: hoy la app devuelve 200 con lista vacía en algunos fallos).
- **p95 < 2 s** en dashboard y navegación. **p95 < 5 s** en widgets BI del cliente mayor (SLA propio: hoy ya rondan 2–6 s). Webhooks **p95 < 1 s**.
- RAM del host ≥ 20 % libre sostenido; ningún contenedor por encima del 85 % de su límite durante más de 5 min.
- CPU del host < 80 % sostenido (ventanas de 5 min). CPU robada (`steal`) < 10 %.
- La cola `sync_jobs` vuelve a cero pendientes en < 30 min tras el pico (sin contar el cierre de mes).

### 7.5 Comandos que pediré aprobar antes de ejecutar (ejemplo)

```bash
# 1. En el VPS de STAGING (nunca en producción): monitor por contenedor
docker run -d --name cadvisor -p 8081:8080 -v /:/rootfs:ro -v /var/run:/var/run:ro \
  -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro gcr.io/cadvisor/cadvisor:v0.49.1

# 2. Reiniciar estadísticas SOLO en la base de staging
psql "$STAGING_DATABASE_URL" -c "select pg_stat_statements_reset();"

# 3. Pruebas (desde una máquina distinta al VPS)
k6 run -e BASE=https://staging.example -e TOKEN_PUBLICO=... k6/escenarios.js
k6 run -e BASE=https://staging.example k6/rampa.js
```

---

## 8. Capacidad en KVM 4 y KVM 8

### 8.1 Reparto de memoria en el VPS compartido (ESTIMADO)

| Componente | KVM 4 (16 GB) | KVM 8 (32 GB) |
|---|---|---|
| Sistema + Docker | 1 GB | 1 GB |
| Dokploy + Traefik | 0,5–1 GB | 0,5–1 GB |
| Supabase sin Postgres (Kong, Auth, PostgREST, Realtime, Storage, Studio, meta). `analytics` + `vector` **desactivados** | 1,5–2 GB | 2–3,5 GB (con `analytics`) |
| Postgres de Supabase (esta app; `shared_buffers` 1 GB en KVM 4 y 2 GB en KVM 8) | 2–3 GB | 3–4 GB |
| Esta app + worker (límites recomendados) | 1,5 + 0,4 GB | 2 + 0,4 GB |
| n8n (+ su base) | 0,5–1 GB | 0,5–1 GB |
| **Subtotal sin otras apps** | **7,5–9,5 GB** | **9,5–13 GB** |
| Pico de un `next build` en el VPS | +2–3 GB | +2–3 GB |
| **Libre para otras apps + agentes** | **3,5–6 GB** (≈2 GB si se compila dentro) | **16–20 GB** |

### 8.2 Límites estimados de esta app

| Límite | KVM 4 | KVM 8 | Qué lo fija |
|---|---|---|---|
| Usuarios concurrentes navegando dashboards | 10–15 | 15–20 | Un proceso Node; más RAM de Postgres en KVM 8 |
| Usuarios abriendo informes BI grandes a la vez (código actual) | 3–5 | 4–6 | Agregación en Node + corte de 8 s. **Apenas cambia con el tamaño del VPS** |
| Lo mismo tras optimizar el BI (sección 9, puntos 1–3) | 20–40 | 40+ | Postgres y caché |
| Sincronizaciones simultáneas | 1 (por diseño) | 1 (por diseño) | Worker en serie; se puede subir a 2 en clientes distintos en ambos |
| Clientes que caben en el cierre de mes (si debe terminar en < 12 h) | ~14 | ~14 | Duración en serie y APIs externas, no la CPU |
| Leads por minuto sin degradar | > 100 (INFERIDO) | > 200 | INSERT medio de 19 ms; hoy el máximo es 8/min |

### 8.3 Riesgos por recurso

- **CPU:**
  - KVM 4: 4 vCPU repartidos entre muchos servicios, y los `next build` las saturan.
  - Hostinger KVM puede tener CPU compartida («steal»). INFERIDO: hay que medirlo con `vmstat`/`mpstat`.
- **RAM:** riesgo principal en KVM 4 por la suma de servicios y las compilaciones. Sin límites, el OOM killer del kernel puede matar a Postgres, el proceso más grande, y tumbar todas las apps.
- **Disco:** bajo para esta app (613 MB, +1,4 MB/día). Vigilar logs de Docker, volcados locales y WAL. 200 GB NVMe sobra para esta app.
- **Base de datos:** una sola instancia de Postgres para varias apps crea un punto único de fallo, y que una app sature la base afecta a todas. Usar bases o roles separados con `statement_timeout` por rol.

### 8.4 Qué ejecutar en colas y qué aislar

- **Ya en cola:** sincronizaciones (`sync_jobs`).
- **Debería ir en cola:**
  - Turnos del agente por WhatsApp, con concurrencia de 2.
  - Exportaciones CSV grandes.
  - Resúmenes programados (`bi-report-digest`, `whatsapp-digest`).
- **Aislar:**
  - **Compilaciones fuera del VPS:** GitHub Actions → registro de imágenes → Dokploy solo descarga.
  - **Postgres con su propio límite y prioridad:** que el OOM killer no lo elija primero.
  - **Sistema de agentes:** contenedor propio con límite duro. Si ejecuta modelos locales, en otro servidor.

### 8.5 Límites Docker propuestos (punto de partida, a validar con las pruebas)

| Contenedor | KVM 4 | KVM 8 | Otros ajustes |
|---|---|---|---|
| app | `mem_limit: 1536m`, `cpus: 1.5` | `2g`, `cpus: 2` | `NODE_OPTIONS=--max-old-space-size=1024` (1.536 en KVM 8) |
| sync-worker | `384m`, `cpus: 0.5` | igual | — |
| supabase-db | `3g`, `cpus: 2` | `5g`, `cpus: 3` | `shared_buffers` 1 GB / 2 GB, `work_mem` 16 MB, `effective_cache_size` 2 GB / 4 GB, `max_connections` 100, `oom_score_adj: -500` |
| realtime | `512m` | `512m` | — |
| rest, auth, storage, kong | 256 MB c/u | 256 MB c/u | — |
| studio | `512m` (o apagado si no se usa) | `512m` | — |
| analytics + vector | **desactivados** | 1,5 GB si se activan | — |
| Todos | `logging.max-size: 10m`, `max-file: 3` | igual | — |

---

## 9. Recomendaciones de optimización (por impacto)

1. **Agregar el BI en Postgres** (RPC con `GROUP BY` por dimensión y periodo) en vez de `fetchAllRows` + agregación en Node. Reduce RAM, CPU y transferencia en un orden de magnitud para el cliente mayor. *Impacto: muy alto.* Requiere `verify-bi-golden.ts` y `verify-paridad-superficies.ts` en verde.
2. **Caché de resultados por widget** (clave: informe + filtros + rango; caducidad de 5–15 min; invalidar al terminar una sincronización del cliente). Los enlaces públicos los abren clientes finales y piden lo mismo una y otra vez. *Alto.*
3. **Limitar la concurrencia de widgets en el navegador** (4–6 a la vez, el resto en cola). Suaviza la ráfaga de 34 peticiones. *Alto, cambio pequeño.*
4. **Índices para las consultas de `lead_events` con media > 1 s** (MEDIDO, sección 3.2). Usar `CREATE INDEX CONCURRENTLY` según las reglas del repo, y antes revisar los planes con `EXPLAIN` en staging. *Alto.*
5. **Compilar fuera del VPS.** *Alto para la estabilidad del host compartido.*
6. **Ajustar Postgres al autoalojar:** `work_mem` 16 MB (elimina la mayor parte de los 1,87 GB escritos a disco temporal) y `shared_buffers` según la tabla 8.5. *Medio-alto, sin código.*
7. **Sustituir Realtime de la campanita** por un sondeo ligero cada 60 s o por Realtime Broadcast. Hoy es el 50 % del tiempo de la base. *Medio.*
8. **Dos réplicas de la app** detrás de Traefik, cuando la concurrencia lo pida. Antes hay que mover a la base o a Redis el límite de peticiones del enlace público y los límites por plataforma (hoy están en memoria del proceso; documentado). *Medio.*
9. **Permitir 2 trabajos de sincronización en paralelo en clientes distintos** (ya existe el bloqueo por cliente). Reduce a la mitad el cierre de mes. *Medio.*
10. **Instrumentación:** tiempo por petición y memoria del proceso en `/api/health`, o logs de acceso de Traefik. Sin esto no habrá p95 reales. *Medio, requisito para medir.*

---

## 10. Riesgos de consolidar varias aplicaciones en un solo VPS

- **Punto único de fallo:** una caída del host, del disco o de Docker deja sin servicio a todas las apps y a la base. Los webhooks de Meta y GHL reintentan durante un tiempo limitado: una parada larga **pierde leads**.
- **Vecino ruidoso:** el pico de una app (compilación, importación masiva, agentes) degrada a las demás. Sin límites Docker, el OOM killer elige al proceso más grande: Postgres.
- **Copias de seguridad:** al dejar Supabase en la nube se pierden sus copias diarias. Hacen falta `pg_dump` o `pgBackRest` hacia almacenamiento externo, con restauración probada.
- **Seguridad:** más servicios expuestos en un solo host. Postgres (5432) nunca debe estar abierto a internet; Studio debe ir detrás de autenticación.
- **Actualizaciones:** reiniciar el host para un parche del kernel para todas las apps a la vez.
- **Contención de E/S:** autovacuum, volcados y logs de varias apps en el mismo NVMe.
- **Hostinger:** posible CPU compartida (steal) y límites de transferencia. INFERIDO: confirmar las condiciones del plan.

---

## 11. Métricas pendientes y cómo obtenerlas

| Métrica | Cómo obtenerla (solo lectura) | Requiere |
|---|---|---|
| CPU y RAM de la app y del worker (24 h, 7 d, 30 d) | Dokploy → Monitoring, o `docker stats --no-stream` cada minuto durante 24 h | Acceso al VPS actual |
| OOM y reinicios | `dmesg -T \| grep -i oom`, `journalctl -k`, `docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}}'` | Acceso al VPS |
| Latencias p50/p95/p99 y peticiones/s | Logs de acceso de Traefik en Dokploy (agregados con `goaccess` o un script), o el informe de API de Supabase | Acceso a Dokploy o al panel de Supabase |
| CPU, RAM, E/S de la base (series) | Panel de Supabase → Reports → Database (Pro: 7 días), o el endpoint Prometheus `/customer/v1/privileged/metrics` | Panel de Supabase |
| Latencias de la pasarela de Supabase | API de registros (`/analytics/endpoints/logs`, ClickHouse SQL, `source = 'edge_logs'`). Reintentar cuando no esté limitada | Esperar a que se libere el límite |
| CPU robada en Hostinger | `vmstat 5` / `mpstat` durante la prueba 1 en el KVM candidato | VPS de prueba |
| Memoria por proceso de Node | Añadir `process.memoryUsage()` a `/api/health` | Cambio de código (aprobación) |
| Consumo de las otras apps, n8n y agentes | Mismo método por app | Inventario de las otras apps |

---

## 12. Veredicto provisional

**Viable con condiciones en KVM 4; holgado en KVM 8.**

- **Esta app sola cabe sin problema** en cualquiera de los dos. Su carga medida es mínima: 1,4 transacciones/s, 0,45 % de un núcleo en la base y 613 MB de datos.
- **La concurrencia alta en informes BI se degrada antes por el código que por el hardware.** Pasar a KVM 8 no la resuelve; las optimizaciones 1–3 sí.
- **Condiciones para KVM 4:**
  1. Compilar fuera del VPS.
  2. Límites Docker y `max-old-space-size` (tabla 8.5).
  3. Supabase sin `analytics` y con Postgres ajustado.
  4. Copias externas con restauración probada.
  5. Que las demás apps y el sistema de agentes quepan en **≈3,5–6 GB** (a confirmar con su inventario).
  6. Pruebas 1–7 superadas en staging.
- **Elegir KVM 8 si** alguna de estas es cierta: hay más de 2–3 apps del tamaño de esta, el sistema de agentes ejecuta tareas locales pesadas, se quiere compilar en el mismo VPS, o se quiere dejar `analytics` de Supabase activo.

---

## Tablas finales

### Métricas

| Métrica | Actual medido | Pico observado | Pico estimado | Fuente | Confianza |
|---|---|---|---|---|---|
| CPU de la app (contenedor) | NO DISPONIBLE | NO DISPONIBLE | ~1 vCPU (techo de un proceso Node) en B–E | Código | Baja |
| RAM de la app (contenedor) | NO DISPONIBLE | NO DISPONIBLE | 0,5–1,5 GB en ráfagas de BI (B–D) | Inferido del código | Baja |
| RAM del sync-worker | NO DISPONIBLE | NO DISPONIBLE | 150–250 MB | Inferido | Baja |
| RAM de `next build` | — | ~2 GB | 2–3 GB | Doc 15 | Media |
| RAM de la base | Instancia de 1 GB (Micro) | Caída por memoria el 2026-09-20 | Se recomiendan 2–5 GB autoalojado | Doc 00 | Alta (hecho) |
| Eventos OOM / reinicios de contenedores | NO DISPONIBLE | 1 caída de la base (20–21 sep) | — | Doc 00 | Alta (hecho) |
| Transacciones/s (Postgres) | 1,40 (media de 32,6 d) | NO DISPONIBLE (sin serie) | B: 5–20 · D: 50–150 | `pg_stat_database` | Alta (media) / Baja (picos) |
| Sentencias/s | 1,21 (0,80 sin Realtime) | NO DISPONIBLE | B: 20–80 · D: 100–600 | `pg_stat_statements` | Alta / Baja |
| Uso de CPU de la base | 0,45 % de 1 núcleo de media | NO DISPONIBLE | — | `pg_stat_statements` | Media |
| Consulta más lenta (app) | Medias de 1–4,5 s en `lead_events` | 7,8 s (corte de 8 s) | Timeouts en C–E | `pg_stat_statements` | Alta |
| Conexiones de PostgreSQL | 20 (foto) | 34 de 60 (foto del 24-oct) | C–D: saturación del pool | `pg_stat_activity` | Media |
| Acierto de caché | 99,95 % | — | Baja si `shared_buffers` es pequeño | `pg_stat_database` | Alta |
| Escritura a disco temporal | 1,87 GB en 32,6 d (332 archivos) | — | — | `pg_stat_database` | Alta |
| Bloqueos mutuos | 0 | 0 | — | `pg_stat_database` | Alta |
| Latencia HTTP p50/p95/p99 | NO DISPONIBLE | NO DISPONIBLE | Widgets BI pesados: 1,7–6,6 s | Inferido (páginas de 92–349 ms × 19) | Baja |
| Peticiones/s HTTP | NO DISPONIBLE | NO DISPONIBLE | B: 10–40 en ráfaga | Inferido | Baja |
| Leads/hora | 38,5 (media) | 133 | 3×: ~400 · 10×: ~1.300 | `lead_events` | Alta |
| Leads/minuto | p99 5 | 8 | 10×: ~80 | `lead_events` | Alta |
| Tiempo ocupado del worker al día | 10–31 min | 351,6 min (cierre de mes) | 3×: ~18 h el día de cierre | `sync_runs` | Alta / Media |
| Duración de un trabajo | `metricas` p95 85,9 s | 227,2 s (`meta_leads`) | — | `sync_runs` | Alta |
| Tamaño de la base | 613 MB | — | +~0,5 GB/año al ritmo actual | `pg_database_size` | Alta |
| Disco / IOPS / red del VPS | NO DISPONIBLE | NO DISPONIBLE | Red app↔base de hasta 10–30 MB por widget pesado | Inferido | Baja |

### Escenarios

CPU y RAM: app + worker + Postgres de esta app. No incluye el resto de Supabase ni otras apps.

| Escenario | CPU estimada | RAM estimada | Peticiones/s | Conexiones DB | Latencia p95 | Riesgo |
|---|---|---|---|---|---|---|
| A. Normal | 0,2–0,5 vCPU | 1–1,5 GB | 0,5–2 | 15–20 | < 1 s dashboard; 2–6 s widgets BI pesados | Bajo |
| B. Pico habitual | 1–2 vCPU en ráfagas | 1,5–2,5 GB | 10–40 en ráfaga | 20–35 | 1–2 s dashboard; 3–7 s BI | Medio |
| C. Pico alto (3×) | 2–3 vCPU (la app topa en 1) | 2,5–4 GB | 30–100 | 35–60 (pool lleno) | 3–8 s; timeouts en BI | Alto |
| D. Estrés (5–10×) | 3–4+ vCPU | 4–6 GB (OOM de Node si no tiene límite) | 50–300 | Saturadas | > 8 s, errores | Muy alto: punto de degradación |
| E. Peor coincidencia | 2–4 vCPU + compilación (todos los núcleos) | 3–5 GB + 2–3 GB de compilación | 20–60 | 30–60 | 5–10 s BI; dashboard > 2 s | Alto en KVM 4; medio en KVM 8 |

### KVM 4 frente a KVM 8

| KVM 4 | KVM 8 | Recomendación | Evidencia |
|---|---|---|---|
| 3,5–6 GB libres para otras apps y agentes tras Supabase, Dokploy, n8n y esta app | 16–20 GB libres | KVM 4 solo si el resto de apps cabe en ese margen | Reparto de la tabla 8.1 (estimado) |
| Las compilaciones en el VPS dejan ~2 GB libres y saturan las 4 vCPU | Las compilaciones caben | Compilar fuera del VPS en ambos casos; obligatorio en KVM 4 | Doc 15: `next build` ~2 GB |
| 3–5 usuarios con informes BI grandes a la vez | 4–6 | El tamaño no lo resuelve: optimizar el BI (puntos 1–3) | Código: `fetchAllRows` + Node de un solo hilo; consultas de 7,8 s medidas |
| Postgres con `shared_buffers` de 1 GB: la base actual (613 MB) cabe en caché | 2 GB: cabe con margen para otras bases | Suficiente en ambos para esta app | MEDIDO: 613 MB y 99,95 % de acierto de caché con 256 MB |
| Sincronización: igual (1 trabajo a la vez) | Igual | Paralelizar a 2 por cliente distinto; no depende del VPS | Código + cierre de mes de 5,9 h medido |
| Margen ante picos E: bajo | Alto | KVM 8 si habrá agentes pesados o más de 2–3 apps parecidas | Escenario E (estimado) |
| Disco de 200 GB: sobra para esta app | 400 GB | Indiferente para esta app | 613 MB, +1,4 MB/día |
| Coste menor | Coste mayor | Empezar en KVM 4 con límites y pruebas; subir si la prueba 6 falla | Umbrales de la sección 7.4 |

---

### Anexo: consultas de solo lectura ejecutadas

Todas fueron `SELECT` contra producción por la API de gestión de Supabase, el 2026-10-25:

- `pg_stat_database`, `pg_settings`, `pg_roles` (solo `rolconfig`), `pg_stat_activity` (agregado por usuario y aplicación), `pg_stat_statements` (texto parametrizado recortado a 110 caracteres) y `pg_stat_user_tables`.
- Agregados de `sync_runs`, `sync_jobs`, `lead_events` (conteos por hora, minuto, día y cliente; sin contenido), `pixel_events`, `bi_reports` (conteo de widgets) y `notifications`.
- Tres intentos fallidos contra la API de registros de Supabase (respuesta 410 y después 429). Ninguna escritura.
