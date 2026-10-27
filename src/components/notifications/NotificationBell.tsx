'use client';

// Campanita de notificaciones: contador de no leídas + popover con las
// últimas 10. Se monta una sola vez, en el topbar responsive del layout
// autenticado.
//
// Se actualiza por sondeo cada 5 minutos, no con Supabase Realtime: el
// sondeo del WAL de Realtime era la mitad de todo el tiempo de la base
// (docs/28-auditoria-capacidad-vps.md) para pintar un contador.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { toast } from 'sonner';
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  getNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from '@/app/(app)/notificaciones/_actions';
import type { InAppNotification, NotificationSeverity } from '@/lib/notifications/types';

const SEVERITY_ICON: Record<NotificationSeverity, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-indigo-500 shrink-0" />,
  success: <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  error: <XCircle className="h-4 w-4 text-rose-500 shrink-0" />,
};

const INTERVALO_SONDEO_MS = 5 * 60_000;

// Más nuevas que esto de golpe (p. ej. al volver tras horas con la pestaña
// oculta) se resumen en un solo toast en vez de una lluvia.
const MAX_TOASTS_POR_SONDEO = 3;

const EVENTO_ACTUALIZAR = 'notificaciones:actualizar';

/** Pide a la campanita que consulte ya, sin esperar al próximo sondeo. */
export function actualizarCampanita() {
  window.dispatchEvent(new Event(EVENTO_ACTUALIZAR));
}

export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  // null hasta la primera carga: lo que ya existía al abrir la app no avisa.
  const vistas = useRef<Set<string> | null>(null);
  const ultimaCarga = useRef(0);

  const avisar = useCallback(
    (notif: InAppNotification) => {
      const show =
        notif.severity === 'error'
          ? toast.error
          : notif.severity === 'warning'
            ? toast.warning
            : notif.severity === 'success'
              ? toast.success
              : toast.info;
      show(notif.title, {
        description: notif.message ?? undefined,
        action: notif.link ? { label: 'Ver', onClick: () => router.push(notif.link!) } : undefined,
      });
    },
    [router]
  );

  const refresh = useCallback(async () => {
    ultimaCarga.current = Date.now();
    try {
      const [{ items: latest }, count] = await Promise.all([
        getNotifications({ limit: 10 }),
        getUnreadCount(),
      ]);

      const previas = vistas.current;
      if (previas) {
        const nuevas = latest.filter((n) => !n.read_at && !previas.has(n.id));
        if (nuevas.length > MAX_TOASTS_POR_SONDEO) {
          toast.info(`Tienes ${nuevas.length} notificaciones nuevas`);
        } else {
          [...nuevas].reverse().forEach(avisar);
        }
      }
      vistas.current = new Set([...(previas ?? []), ...latest.map((n) => n.id)]);

      setItems(latest);
      setUnread(count);
    } catch (err) {
      console.warn('[NotificationBell] no se pudo actualizar:', err);
    }
  }, [avisar]);

  useEffect(() => {
    refresh();

    // Con la pestaña oculta no se consulta; al volver, solo si ya tocaba.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, INTERVALO_SONDEO_MS);
    const alVolver = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - ultimaCarga.current >= INTERVALO_SONDEO_MS
      ) {
        refresh();
      }
    };
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener(EVENTO_ACTUALIZAR, refresh);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
      window.removeEventListener(EVENTO_ACTUALIZAR, refresh);
    };
  }, [refresh]);

  const handleClick = async (notif: InAppNotification) => {
    setOpen(false);
    if (!notif.read_at) {
      setItems((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n))
      );
      setUnread((n) => Math.max(0, n - 1));
      markAsRead(notif.id);
    }
    if (notif.link) router.push(notif.link);
  };

  const handleMarkAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnread(0);
    await markAllAsRead();
  };

  // Al abrir, re-sincroniza lista y contador: cubre lecturas hechas desde
  // /notificaciones y lo llegado desde el último sondeo.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) refresh();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notificaciones">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-red text-white text-xs font-bold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 sm:w-96 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold">Notificaciones</span>
          {unread > 0 && (
            <button
              onClick={handleMarkAll}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Marcar todas
            </button>
          )}
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No tienes notificaciones
            </div>
          ) : (
            items.map((notif) => (
              <button
                key={notif.id}
                onClick={() => handleClick(notif)}
                className={`w-full text-left px-4 py-3 flex gap-3 border-b border-border last:border-0 hover:bg-accent transition-colors ${
                  !notif.read_at ? 'bg-brand-blue/5' : ''
                }`}
              >
                <span className="mt-0.5">
                  {SEVERITY_ICON[notif.severity] ?? SEVERITY_ICON.info}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-foreground truncate">
                    {notif.title}
                  </span>
                  {notif.message && (
                    <span className="block text-xs text-muted-foreground line-clamp-2">
                      {notif.message}
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {formatDistanceToNow(new Date(notif.created_at), {
                      addSuffix: true,
                      locale: es,
                    })}
                  </span>
                </span>
                {!notif.read_at && (
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-brand-blue shrink-0" />
                )}
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-border">
          <button
            onClick={() => {
              setOpen(false);
              router.push('/notificaciones');
            }}
            className="text-xs font-medium text-brand-blue dark:text-brand-blue-light hover:underline"
          >
            Ver todas las notificaciones
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
