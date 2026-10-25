# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

AdsHouse Reporting: multi-client reporting platform for an ad agency. It consolidates Meta Ads, TikTok Ads, GA4, Hotmart, GoHighLevel and Google Sheets into dashboards, BI reports, public share links, an MCP server and an internal agent (WhatsApp). Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage). Node ≥ 22.12.

Code identifiers, comments, docs and commit messages are in **Spanish**; keep that convention. The `docs/` folder is extensive and current: start from [docs/README.md](docs/README.md) and [docs/00-informe-de-entrega.md](docs/00-informe-de-entrega.md) (handoff report, with the database incident log and rules).

## Commands

```bash
npm run dev            # http://localhost:3000 (webpack)
npm run build
npm run validate       # type-check + lint (0 warnings) + format:check — the only thing CI runs
npm run lint:fix
npm run format
npm run test:puro      # pure checks, no DB/network
npm run test:datos     # READ-ONLY checks against the PRODUCTION database (needs .env.local)
npm test               # both
```

There is no Jest/Vitest. Tests are standalone `scripts/verify-*.ts` files using a local `check()` helper and `salir(fallos)` from `scripts/_salida.ts`. Run a single one with:

```bash
npx tsx --conditions=react-server scripts/verify-bi-expr.ts
```

`--conditions=react-server` is required — without it `server-only` imports throw. A new verify script must be appended to the `test:puro` or `test:datos` chain in `package.json`.

Notes on `test:datos`:

- It hits production. Don't run the whole suite repeatedly back to back (it saturates the instance); run the failing script alone.
- If the line before a failure says `statement timeout`, `[paginate]` or `INCOMPLETO`, the number isn't real — rerun that script alone.
- `verify-bi-golden.ts` compares the BI engine against `scripts/golden/bi-baseline.json`. Never recapture (`--capturar`) the golden without reviewing the log.

Other scripts: `scripts/sql-remoto.ts` runs SQL/migrations through the Supabase Management API (`--staging` targets `.env.staging.local`); `npm run diagnostico`, `npm run detectar:huecos`, `npm run skill:informes`.

## Architecture

**Two schemas, two client ids.** `public.clientes` is the source of truth for a client; a mirror row in `report_utm.clientes` is created/archived/deleted with it through `src/lib/clientes/ciclo-de-vida.ts`. Metrics (`metricas_diarias`, `ads_daily`, …) use the `public` id; `lead_events`, `sales_events` and BI reports use the `report_utm` id. Deleting a client cascades all its data and must go through `eliminarClienteCompleto`.

**Sync pipeline.** Work is queued in `public.sync_jobs` (`src/lib/sync/` — `planner.ts` builds the daily plan and runs purges, `queue.ts`, `runner.ts`). The `sync-worker/` service (separate Dokploy app) drains the queue and schedules crons; it imports `src/lib/sync/runner.ts`, which calls the app's existing `/api/worker/*` endpoints — integration logic lives only in the app. `/api/worker/run-jobs` is the fallback executor. Each run is recorded in `sync_runs` (`ejecutor` = `vps` | `app`). Upserts are idempotent; routes cut cleanly on budget and persist a cursor. See docs/14.

**Data stores.** `metricas_diarias` has one row per client/day with JSONB breakdowns (`meta_campaigns`, `tiktok_campaigns`, …); `ads_daily` is the normalized ad-level table (may have gaps — check `adsDailySinHuecos`). Leads land in `report_utm.lead_events`; sales in `sales_events` / Hotmart tables.

**Two metric engines.**

- Dashboard tabs: layouts + `src/lib/formula-engine.ts` over `metricas_diarias` (docs/09, docs/10).
- BI reports: `src/lib/report-utm/bi/`. Each data source is declared in `bi/sources/*.ts`; `bi/registry.ts` derives everything else (additive metrics, breakdowns, glossary) from those declarations — add fields there, not in hand-maintained lists. `bi/expr.ts` is the pure expression parser.

Gasto and leads are computed by several surfaces (BI, dashboard, API v1/MCP, alerts, CSV) that must agree; `scripts/verify-paridad-superficies.ts` and `verify-mcp-paridad.ts` enforce parity. If you change how a number is computed in one surface, check the others.

**Rendering conventions.** Server Components fetch from Supabase directly; mutations are Server Actions in `_actions.ts`; `*Client.tsx` is the client counterpart of a page. Auth + RBAC middleware is `src/proxy.ts`. Route groups: `(app)` authenticated; `/report/*` and `/p/[token]` are public (BI public links are guarded by `bi/public-allowlist.ts`). External APIs: `/api/v1/*` and `/api/mcp` (token auth via `src/lib/api-token-auth.ts`), `/api/cron/*` (`cron-auth.ts`).

**Generated files.** `.claude/skills/informes-bi/` and `skills/informes-bi-mcp/` are generated from `src/lib/agent/guias/informes.ts` via `npm run skill:informes`; don't edit them by hand (`verify-skill-informes.ts` fails on drift).

## Database rules (from incidents — see docs/00 §4)

- **Ask before applying any migration to production**, even if told to "apply the whole plan". Test with `sql-remoto.ts --staging` first. Write SQL files with the editor, never via shell heredocs.
- Migrations live in `migrations/` (numbers repeat; no applied-registry). `schema.sql` is NOT the truth — production is. Make migrations idempotent and document the revert in the header.
- Additive migration ships before the code that uses it; removals ship after the code stops using them.
- New tables: RLS on with `public.puede_ver_cliente(cliente_id)` (never `USING (true)`), FK `cliente_id … ON DELETE CASCADE`, FKs to `auth.users` with an explicit `ON DELETE`. `SECURITY DEFINER` functions use `SET search_path = ''`.
- Indexes on `lead_events`/`pixel_events`: `CREATE INDEX CONCURRENTLY` as a standalone statement (a lock drops leads). Adding a function parameter creates an overload: `DROP FUNCTION` exact signature, recreate, re-`GRANT`, `NOTIFY pgrst, 'reload schema'`.
- New `sync_jobs` type needs `sync_jobs_tipo_check` widened.
- Server code uses the service role (bypasses RLS): **always filter by `cliente_id`**, and bound `lead_events` queries by client and date.
- supabase-js does not throw: always check `error` (a 300 `PGRST201` or a timeout otherwise becomes a silent 0/empty list). No `res.data || []` without logging.
- More than 1,000 rows → `fetchAllRows` (`src/lib/supabase-paginate.ts`, select must include `id`); pass `{ estricto: true }` when the result replaces data.
- Updates/deletes in batches, never open-ended. Avoid `count: 'exact'` on unindexed filters. Don't select `metricas_diarias` JSONB columns unless needed. Name the FK in `cliente_tabs → clientes` embeds.
- Empty values in `lead_events` are `NULL`, not `''`. Cut days in the client's time zone (`conZonaDeCliente`, `p_zona` in RPCs).
- Never rotate `RUTM_ENCRYPTION_KEY` without migrating the encrypted secrets first.

## Deployment

Docker on a VPS via Dokploy: the app (`Dockerfile`, standalone output) and `sync-worker/`. `whatsapp-gateway/` and `wordpress-plugin/` are separate pieces. See docs/15.
