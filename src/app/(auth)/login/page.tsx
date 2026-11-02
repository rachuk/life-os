import { redirect } from 'next/navigation';
import { currentUser } from '@/server/auth/current';
import { env } from '@/server/env';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Вход' };

export default async function LoginPage() {
  if (await currentUser()) redirect('/today');
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg">L</div>
          <h1 className="text-2xl font-semibold">Life OS</h1>
          <p className="mt-1 text-sm text-muted">Личный планировщик. Вход только для владельца.</p>
        </div>
        <LoginForm signupOpen={env().SIGNUP_MODE === 'open'} />
      </div>
    </div>
  );
}
