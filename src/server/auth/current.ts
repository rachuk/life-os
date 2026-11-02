import { redirect } from 'next/navigation';
import { cache } from 'react';
import { sessionUserFromCookies } from '../http';
import type { SessionUser } from './session';

export const currentUser = cache(async (): Promise<SessionUser | null> => sessionUserFromCookies());

export async function requirePageUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect('/login');
  return u;
}
