-- ════════════════════════════════════════════════════════════════════════════
-- Base reconstruida del historial (SOLO para reproducir la auditoría, docs/30)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Las tablas que existen en la base de AdsHouse pero NUNCA tuvieron un CREATE
-- en `migrations/` (clientes, metricas_diarias, cliente_tabs, layouts_reporte,
-- user_profiles…), con las columnas que el historial da por existentes antes
-- de alterarlas. Sin este archivo, las 108 migraciones del historial aplicadas
-- en orden sobre una base vacía fallan en 95; con él aplican todas
-- (`historial-sobre-base-vacia.ts`). NO es la base del esquema limpio: esa es
-- `supabase/migrations/`.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('superadmin', 'admin', 'trafficker', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.user_role NOT NULL DEFAULT 'viewer',
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE IF NOT EXISTS public.layouts_reporte (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  descripcion text,
  columnas jsonb NOT NULL DEFAULT '[]'::jsonb,
  tarjetas jsonb NOT NULL DEFAULT '[]'::jsonb,
  graficos jsonb,
  text_blocks jsonb DEFAULT '[]'::jsonb,
  custom_metrics jsonb DEFAULT '[]'::jsonb,
  blocks_order jsonb DEFAULT '[]'::jsonb,
  source_mapping jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.layouts_reporte ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.clientes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  config_api jsonb DEFAULT '{}'::jsonb NOT NULL,
  layout_id uuid REFERENCES public.layouts_reporte(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.metricas_diarias (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id uuid REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  fecha date NOT NULL,
  meta_spend numeric DEFAULT 0,
  meta_impressions integer DEFAULT 0,
  meta_clicks integer DEFAULT 0,
  meta_campaigns jsonb DEFAULT '[]'::jsonb,
  ga_sessions integer DEFAULT 0,
  hotmart_pagos_iniciados integer DEFAULT 0,
  ventas_principal numeric DEFAULT 0,
  ventas_bump numeric DEFAULT 0,
  ventas_upsell numeric DEFAULT 0,
  metricas_manuales jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE (cliente_id, fecha)
);
ALTER TABLE public.metricas_diarias ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.estrategia_tipos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria TEXT NOT NULL,
  subcategoria TEXT NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  alcance TEXT NOT NULL DEFAULT 'hasta_lead' CHECK (alcance IN ('hasta_lead', 'hasta_venta')),
  temporal BOOLEAN NOT NULL DEFAULT false,
  metricas_clave TEXT[] NOT NULL DEFAULT '{}',
  metricas_na TEXT[] NOT NULL DEFAULT '{}',
  guia TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (categoria, subcategoria)
);

CREATE TABLE IF NOT EXISTS public.cliente_tabs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  keyword_meta TEXT NOT NULL,
  plantilla_id UUID,
  columnas JSONB,
  tarjetas JSONB,
  orden INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  fecha_finalizacion DATE,
  presupuesto_objetivo NUMERIC,
  fecha_inicio DATE,
  graficos JSONB,
  CONSTRAINT cliente_tabs_pkey PRIMARY KEY (id),
  CONSTRAINT cliente_tabs_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT cliente_tabs_plantilla_id_fkey FOREIGN KEY (plantilla_id) REFERENCES public.layouts_reporte(id) ON DELETE SET NULL
);
ALTER TABLE public.cliente_tabs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.clientes_layouts (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL,
  base_layout_id UUID,
  nombre TEXT NOT NULL,
  columnas JSONB NOT NULL DEFAULT '[]'::jsonb,
  tarjetas JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  graficos JSONB,
  text_blocks JSONB DEFAULT '[]'::jsonb,
  blocks_order JSONB DEFAULT '[]'::jsonb,
  custom_metrics JSONB DEFAULT '[]'::jsonb,
  tablas JSONB DEFAULT '[]'::jsonb,
  CONSTRAINT clientes_layouts_pkey PRIMARY KEY (id),
  CONSTRAINT cliente_layout_unique UNIQUE (cliente_id),
  CONSTRAINT clientes_layouts_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT clientes_layouts_base_layout_id_fkey FOREIGN KEY (base_layout_id) REFERENCES public.layouts_reporte(id) ON DELETE SET NULL
);
ALTER TABLE public.clientes_layouts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.user_client_assignments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  client_id UUID NOT NULL,
  assigned_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_client_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT user_client_assignments_user_id_client_id_key UNIQUE (user_id, client_id),
  CONSTRAINT user_client_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_client_assignments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT user_client_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.user_client_assignments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.campaign_groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  color TEXT DEFAULT 'blue',
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(cliente_id, nombre)
);
ALTER TABLE public.campaign_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_tabs ADD COLUMN IF NOT EXISTS alert_email TEXT, ADD COLUMN IF NOT EXISTS alert_sent_at_90 TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS alert_sent_at_100 TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS public.meta_data_streams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cliente_id uuid REFERENCES public.clientes(id) ON DELETE CASCADE);
ALTER TABLE public.meta_data_streams ENABLE ROW LEVEL SECURITY;
