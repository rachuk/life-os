import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { addDays, isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import { listMealTemplates, mealPlanForRange } from '@/server/services/meals';
import { weekShopping } from '@/server/services/shopping';
import { ShoppingClient, type MenuTemplate } from '@/components/shopping/ShoppingClient';

export const metadata = { title: 'Покупки' };

export default async function ShoppingPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requirePageUser();
  const { week } = await searchParams;
  const data = await inUser(user.id, async (tx, ctx) => {
    const currentWeek = weekStartOf(localDateOf(now(), ctx.tz));
    const weekStart = weekStartOf(week && isLocalDate(week) ? week : currentWeek);
    const shopping = await weekShopping(tx, ctx.userId, weekStart);
    const plan = await mealPlanForRange(tx, ctx.userId, weekStart, addDays(weekStart, 6));
    const templates: MenuTemplate[] = (await listMealTemplates(tx, ctx.userId))
      .filter((t) => t.enabled && t.ingredientsJson.length)
      .map((t) => ({ id: t.id, title: t.title, category: t.category, planned: plan.filter((p) => p.templateId === t.id).length }));
    return { currentWeek, shopping, templates };
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Покупки</h1>
        <p className="text-sm text-muted">Личная и общая домашняя корзины на неделю.</p>
      </header>
      <ShoppingClient weekStart={data.shopping.weekStart} lists={data.shopping.lists} templates={data.templates} currentWeek={data.currentWeek} />
    </div>
  );
}
