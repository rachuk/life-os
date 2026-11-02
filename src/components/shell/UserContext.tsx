'use client';
import { createContext, useContext, type ReactNode } from 'react';

export interface ClientUser {
  tz: string;
  today: string;
  workEnd: string;
  workStart: string;
  workDays: number[];
  gymStart: string;
}

const Ctx = createContext<ClientUser>({ tz: 'Europe/Lisbon', today: '', workEnd: '18:00', workStart: '09:00', workDays: [1, 2, 3, 4, 5], gymStart: '21:00' });

export function UserProvider({ value, children }: { value: ClientUser; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useClientUser() {
  return useContext(Ctx);
}
