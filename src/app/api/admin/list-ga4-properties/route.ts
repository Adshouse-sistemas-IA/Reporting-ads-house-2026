import { NextResponse } from 'next/server';
import { hasAgencyGoogleConnection } from '@/lib/integrations/google-auth';
import { listGA4Properties } from '@/lib/integrations/google-analytics';
import { exigirAjustePlataforma, guardaRuta } from '@/lib/acceso/clientes';

/**
 * GET /api/admin/list-ga4-properties
 * Lista las propiedades GA4 accesibles para la cuenta OAuth de la agencia.
 * Usa el scope analytics.readonly ya incluido en el OAuth de agencia.
 */
export async function GET() {
  // Usa la cuenta de Google de la PLATAFORMA (ve las hojas y propiedades de
  // todos los clientes): ajuste de plataforma (admin).
  const denied = await guardaRuta(() => exigirAjustePlataforma('admin'));
  if (denied) return denied;

  try {
    const hasConnection = await hasAgencyGoogleConnection();
    if (!hasConnection) {
      return NextResponse.json(
        {
          error:
            'No hay conexión OAuth de Google activa. Conecta la cuenta de la agencia primero en Ajustes → Conexión Google.',
        },
        { status: 400 }
      );
    }

    const properties = await listGA4Properties();
    return NextResponse.json({ properties });
  } catch (err: any) {
    console.error('list-ga4-properties error:', err);
    return NextResponse.json(
      { error: err.message || 'Error al listar propiedades de GA4' },
      { status: 500 }
    );
  }
}
