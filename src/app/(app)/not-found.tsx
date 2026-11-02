import Link from 'next/link';
import { EmptyState } from '@/components/ui/States';

export default function NotFound() {
  return (
    <EmptyState
      title="Такой страницы нет"
      action={
        <Link href="/today" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-[15px] font-medium text-accent-fg">
          На «Сегодня»
        </Link>
      }
    >
      Возможно, ссылка устарела.
    </EmptyState>
  );
}
