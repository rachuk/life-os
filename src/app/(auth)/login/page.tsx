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
        <LoginForm signupOpen={env().SIGNUP_MODE === 'open'} />
      </div>
    </div>
  );
}
