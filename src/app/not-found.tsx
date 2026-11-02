import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <h1 className="text-xl font-semibold">Такой страницы нет</h1>
        <p className="mt-1 text-sm text-muted">Возможно, ссылка устарела.</p>
        <Link href="/today" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-[15px] font-medium text-accent-fg">
          На «Сегодня»
        </Link>
      </div>
    </div>
  );
}
