-- 103_notifications_fuera_de_realtime.sql
-- ════════════════════════════════════════════════════════════════
-- La campanita ya no escucha `postgres_changes` sobre `public.notifications`:
-- consulta cada 5 minutos (src/components/notifications/NotificationBell.tsx).
-- El sondeo del WAL de Realtime era la mitad de todo el tiempo de la base
-- (docs/28-auditoria-capacidad-vps.md). Sin la tabla en la publication, cada
-- INSERT deja de emitirse aunque quede abierta una pestaña con el código viejo.
--
-- Aplicar DESPUÉS de desplegar el código nuevo: con el viejo en marcha, la
-- campanita se quedaría sin contador en vivo hasta recargar.
--
-- Idempotente: solo quita la tabla si es miembro.
--
-- Revertir:
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
-- ════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'notifications'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE public.notifications;
    END IF;
END $$;
