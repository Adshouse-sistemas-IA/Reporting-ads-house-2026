import { NextResponse } from 'next/server';
import { clientesUtmVisibles, respuestaAccesoDenegado } from '@/lib/acceso/clientes';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Solo los clientes visibles del usuario (admin: todos; resto: asignados).
  let visibles: string[];
  try {
    visibles = (await clientesUtmVisibles()).ids;
  } catch (e) {
    return respuestaAccesoDenegado(e);
  }
  if (visibles.length === 0) return NextResponse.json({ data: [] });

  const db = await reportUtmAdminClient();
  // Los archivados no se ofrecen en selectores: archivar es justamente dejar de
  // verlos sin perder su historia.
  const { data, error } = await db
    .from('clientes')
    .select('id,nombre,slug')
    .in('id', visibles)
    .neq('status', 'archived')
    .order('nombre')
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
