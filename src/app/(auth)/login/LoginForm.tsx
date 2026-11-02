'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';

export function LoginForm({ signupOpen }: { signupOpen: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', { body: { email, password } });
      router.replace('/today');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-3xl border border-border bg-surface p-6 shadow-card">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input
        label="Пароль"
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        required
        minLength={mode === 'signup' ? 10 : 1}
        hint={mode === 'signup' ? 'Минимум 10 символов' : undefined}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button type="submit" variant="primary" block loading={busy}>
        {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
      </Button>
      <div className="flex items-center justify-between text-sm">
        <Link href="/recover" className="text-muted hover:text-text">
          Забыл пароль
        </Link>
        {signupOpen ? (
          <button type="button" className="text-accent" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Создать аккаунт' : 'У меня есть аккаунт'}
          </button>
        ) : null}
      </div>
    </form>
  );
}
