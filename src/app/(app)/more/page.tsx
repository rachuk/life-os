import { Bell, ChevronRight, Dumbbell, Gift, GraduationCap, Moon, ScrollText, Settings, ShoppingBasket, Sprout } from 'lucide-react';
import Link from 'next/link';
import { requirePageUser } from '@/server/auth/current';
import { Card } from '@/components/ui/Card';
import { DataRights, InstallHint, LogoutButton } from '@/components/more/MoreClient';

export const metadata = { title: 'Ещё' };

const LINKS = [
  { href: '/shopping', label: 'Покупки', hint: 'Список на неделю и запасы', icon: ShoppingBasket },
  { href: '/workouts', label: 'Тренировки', hint: 'Программа и занятия', icon: Dumbbell },
  { href: '/habits', label: 'Изменение привычек', hint: 'Например, IQOS: наблюдение и мягкое снижение', icon: Sprout },
  { href: '/skills', label: 'Навыки', hint: 'Языки, речь, управление людьми', icon: GraduationCap },
  { href: '/review/week', label: 'Обзор недели', hint: 'Факты, закономерности, предложения', icon: ScrollText },
  { href: '/review/evening', label: 'Вечерний обзор', hint: 'Завершить день и план на завтра', icon: Moon },
  { href: '/rewards', label: 'Награды', hint: 'Фонд желаний и достижения', icon: Gift },
  { href: '/notifications', label: 'Уведомления', hint: 'Напоминания и доставка', icon: Bell },
  { href: '/settings', label: 'Настройки', hint: 'Распорядок, каналы, приватность', icon: Settings },
] as const;

export default async function MorePage() {
  const user = await requirePageUser();
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold leading-tight">Ещё</h1>
        <p className="text-sm text-muted">{user.email}</p>
      </header>
      <Card className="p-1.5">
        <nav aria-label="Разделы">
          <ul>
            {LINKS.map(({ href, label, hint, icon: Icon }) => (
              <li key={href}>
                <Link href={href} className="flex min-h-14 items-center gap-3 rounded-xl px-3 hover:bg-surface-2">
                  <Icon className="size-5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px]">{label}</span>
                    <span className="block truncate text-xs text-muted">{hint}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-faint" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Card>
      <InstallHint />
      <DataRights />
      <LogoutButton />
    </div>
  );
}
