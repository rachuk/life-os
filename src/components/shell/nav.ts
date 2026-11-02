import { CalendarDays, Dumbbell, Gift, GraduationCap, HeartPulse, LayoutGrid, ListChecks, Moon, ScrollText, Settings, ShoppingBasket, Sprout, Sun } from 'lucide-react';

export const PRIMARY_NAV = [
  { href: '/today', label: 'Сегодня', icon: Sun },
  { href: '/plan', label: 'План', icon: CalendarDays },
  { href: '/tasks', label: 'Дела', icon: ListChecks },
  { href: '/health', label: 'Здоровье', icon: HeartPulse },
  { href: '/more', label: 'Ещё', icon: LayoutGrid },
] as const;

export const SECONDARY_NAV = [
  { href: '/shopping', label: 'Покупки', icon: ShoppingBasket },
  { href: '/workouts', label: 'Тренировки', icon: Dumbbell },
  { href: '/habits', label: 'Привычки', icon: Sprout },
  { href: '/skills', label: 'Навыки', icon: GraduationCap },
  { href: '/review/evening', label: 'Вечерний обзор', icon: Moon },
  { href: '/review/week', label: 'Обзор недели', icon: ScrollText },
  { href: '/rewards', label: 'Награды', icon: Gift },
  { href: '/settings', label: 'Настройки', icon: Settings },
] as const;

/** Routes reachable from "Ещё" that should keep that tab highlighted on mobile. */
export const MORE_PREFIXES = ['/more', '/shopping', '/workouts', '/habits', '/skills', '/review', '/rewards', '/settings', '/notifications'];
