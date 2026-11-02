/**
 * Example catalog (PRD §8.3). Examples, not a medical prescription: no calories, flexible
 * substitutions; the user edits or disables any of them.
 */
export interface Ingredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface MealTemplateSeed {
  title: string;
  category: 'breakfast' | 'snack' | 'drink' | 'post_workout';
  ingredients: Ingredient[];
  prepMinutes: number;
  notes: string;
}

const NOTE = 'Пример для каталога, не медицинское предписание. Можно заменить продукты.';

export const EXAMPLE_MEAL_TEMPLATES: MealTemplateSeed[] = [
  {
    title: 'Овсянка на молоке с бананом и орехами',
    category: 'breakfast',
    prepMinutes: 10,
    notes: NOTE,
    ingredients: [
      { name: 'Овсяные хлопья', quantity: 60, unit: 'г' },
      { name: 'Молоко', quantity: 250, unit: 'мл' },
      { name: 'Бананы', quantity: 1, unit: 'шт' },
      { name: 'Орехи', quantity: 20, unit: 'г' },
    ],
  },
  {
    title: 'Яйца, тосты и овощи',
    category: 'breakfast',
    prepMinutes: 12,
    notes: NOTE,
    ingredients: [
      { name: 'Яйца', quantity: 3, unit: 'шт' },
      { name: 'Хлеб для тостов', quantity: 2, unit: 'шт' },
      { name: 'Помидоры', quantity: 1, unit: 'шт' },
      { name: 'Огурцы', quantity: 1, unit: 'шт' },
    ],
  },
  {
    title: 'Йогурт с гранолой и фруктом',
    category: 'breakfast',
    prepMinutes: 3,
    notes: NOTE,
    ingredients: [
      { name: 'Йогурт', quantity: 200, unit: 'г' },
      { name: 'Гранола', quantity: 50, unit: 'г' },
      { name: 'Фрукты', quantity: 1, unit: 'шт' },
    ],
  },
  {
    title: 'Бутерброды с сыром и чай',
    category: 'breakfast',
    prepMinutes: 5,
    notes: NOTE,
    ingredients: [
      { name: 'Хлеб', quantity: 3, unit: 'шт' },
      { name: 'Сыр', quantity: 60, unit: 'г' },
    ],
  },
  {
    title: 'Омлет с сыром',
    category: 'breakfast',
    prepMinutes: 10,
    notes: NOTE,
    ingredients: [
      { name: 'Яйца', quantity: 3, unit: 'шт' },
      { name: 'Сыр', quantity: 30, unit: 'г' },
      { name: 'Молоко', quantity: 50, unit: 'мл' },
    ],
  },
  { title: 'Горсть орехов', category: 'snack', prepMinutes: 0, notes: NOTE, ingredients: [{ name: 'Орехи', quantity: 30, unit: 'г' }] },
  {
    title: 'Бутерброд с сыром',
    category: 'snack',
    prepMinutes: 3,
    notes: NOTE,
    ingredients: [
      { name: 'Хлеб', quantity: 1, unit: 'шт' },
      { name: 'Сыр', quantity: 30, unit: 'г' },
    ],
  },
  { title: 'Йогурт', category: 'snack', prepMinutes: 0, notes: NOTE, ingredients: [{ name: 'Йогурт', quantity: 150, unit: 'г' }] },
  { title: 'Банан', category: 'snack', prepMinutes: 0, notes: NOTE, ingredients: [{ name: 'Бананы', quantity: 1, unit: 'шт' }] },
  {
    title: 'Домашний молочный коктейль',
    category: 'snack',
    prepMinutes: 5,
    notes: NOTE,
    ingredients: [
      { name: 'Молоко', quantity: 300, unit: 'мл' },
      { name: 'Бананы', quantity: 1, unit: 'шт' },
      { name: 'Овсяные хлопья', quantity: 30, unit: 'г' },
    ],
  },
];
