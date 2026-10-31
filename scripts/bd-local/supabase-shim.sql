-- ════════════════════════════════════════════════════════════════════════════
-- Shim mínimo de Supabase para una base Postgres vacía (PGlite o Postgres local)
-- ════════════════════════════════════════════════════════════════════════════
--
-- SOLO PARA PRUEBAS LOCALES. Nunca se aplica a un proyecto de Supabase: allí
-- estos objetos ya existen y los gestiona la plataforma.
--
-- Reproduce lo que las migraciones dan por hecho en Supabase:
--   · roles `anon`, `authenticated`, `service_role` (este con BYPASSRLS, como en
--     Supabase) y `authenticator`;
--   · esquemas `auth` y `extensions`;
--   · `auth.users` con las columnas que usa la app;
--   · `auth.uid()`, `auth.jwt()`, `auth.role()` leyendo `request.jwt.claims`,
--     igual que PostgREST;
--   · privilegios por defecto del esquema `public` hacia los tres roles de la API
--     (en Supabase toda tabla nueva de `public` es accesible por la API y la
--     protege SOLO el RLS; por eso las pruebas de aislamiento son significativas);
--   · la publicación `supabase_realtime`.
--
-- Para simular una petición de un usuario:
--   SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
--   SET LOCAL ROLE authenticated;
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
  END IF;
END $$;

GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud varchar(255) DEFAULT 'authenticated',
  role varchar(255) DEFAULT 'authenticated',
  email varchar(255) UNIQUE,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  is_super_admin boolean,
  phone text,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')::text
$$;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;

-- Privilegios por defecto equivalentes a los de Supabase en `public`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
