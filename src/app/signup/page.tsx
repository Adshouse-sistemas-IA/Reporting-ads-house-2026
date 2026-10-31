import { redirect } from 'next/navigation';

/**
 * No hay registro público. Las cuentas las crea un administrador desde
 * Ajustes → Usuarios (`createUser`); el registro también hay que cerrarlo en
 * Supabase Auth (Authentication → Sign In / Providers → «Allow new users to
 * sign up» apagado). La ruta solo existe para que los enlaces antiguos lleven
 * al login.
 */
export default function SignupPage() {
  redirect('/login');
}
