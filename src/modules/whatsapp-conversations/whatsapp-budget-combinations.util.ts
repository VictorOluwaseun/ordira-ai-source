import type {
  BudgetItemVariant,
  BudgetModifierChoice,
} from './whatsapp-budget-modifiers.util';
import type { StorefrontMenuItemSearchResult } from '@modules/storefront-search/types/storefront-menu-item-search-response.type';
import { isStorefrontDrink } from '@modules/storefront-search/storefront-menu-item-kind.util';
import {
  estimateDeliveredTotal,
  type WhatsappBudgetQuote,
} from './whatsapp-budget-quote.service';
import type { WhatsappMenuBudget } from './whatsapp-budget.util';

export type WhatsappBudgetCombination = {
  food: StorefrontMenuItemSearchResult;
  drink?: StorefrontMenuItemSearchResult;
  totalMinorUnit: number;
  foodModifiers?: BudgetModifierChoice[];
  drinkModifiers?: BudgetModifierChoice[];
};

/** Price a small, bounded set of one-food + one-drink suggestions. All amounts
 * come from the catalog; fees are calculated once on the combined subtotal.
 * Suggested modifier selections are explicit; nothing is added to a basket. */
export function buildWhatsappBudgetCombinations(
  foods: StorefrontMenuItemSearchResult[],
  drinks: StorefrontMenuItemSearchResult[],
  budget: WhatsappMenuBudget,
  quote: WhatsappBudgetQuote,
  variantsByItem?: Map<string, BudgetItemVariant[]>,
  limit = 3,
): WhatsappBudgetCombination[] {
  const eligible = (item: StorefrontMenuItemSearchResult) =>
    item.currency === budget.currency &&
    item.availability.orderable &&
    item.customization.orderable &&
    (variantsByItem?.has(item.menuItemId) || !item.customization.required) &&
    Number.isSafeInteger(item.basePriceMinorUnit) &&
    item.basePriceMinorUnit >= 0;
  const mains = foods
    .slice(0, 50)
    .filter((item) => eligible(item) && !isStorefrontDrink(item));
  const beverages = drinks
    .slice(0, 50)
    .filter((item) => eligible(item) && isStorefrontDrink(item));
  const pairs: WhatsappBudgetCombination[] = [];
  const singles: WhatsappBudgetCombination[] = [];
  const variants = (item: StorefrontMenuItemSearchResult) =>
    variantsByItem?.get(item.menuItemId) ?? [
      { priceMinorUnit: item.basePriceMinorUnit, modifiers: [] },
    ];
  for (const food of mains) {
    for (const drink of [undefined, ...beverages]) {
      if (drink && drink.menuItemId === food.menuItemId) continue;
      for (const foodVariant of variants(food)) {
        for (const drinkVariant of drink
          ? variants(drink)
          : [{ priceMinorUnit: 0, modifiers: [] }]) {
          const subtotal =
            foodVariant.priceMinorUnit + drinkVariant.priceMinorUnit;
          if (
            subtotal < quote.minPriceMinorUnit ||
            subtotal > quote.maxPriceMinorUnit
          )
            continue;
          const totalMinorUnit = estimateDeliveredTotal(subtotal, quote);
          if (
            !Number.isSafeInteger(totalMinorUnit) ||
            totalMinorUnit > budget.maxPriceMinorUnit
          )
            continue;
          (drink || foodVariant.modifiers.length ? pairs : singles).push({
            food,
            ...(drink ? { drink } : {}),
            totalMinorUnit,
            ...(foodVariant.modifiers.length
              ? { foodModifiers: foodVariant.modifiers }
              : {}),
            ...(drinkVariant.modifiers.length
              ? { drinkModifiers: drinkVariant.modifiers }
              : {}),
          });
        }
      }
    }
  }
  // Prefer a meal with extras and/or a drink, then totals within the budget.
  // Show different food choices first instead of three drinks beside one dish.
  const byPrice = (
    a: WhatsappBudgetCombination,
    b: WhatsappBudgetCombination,
  ) =>
    b.totalMinorUnit - a.totalMinorUnit ||
    a.food.name.localeCompare(b.food.name);
  pairs.sort(byPrice);
  singles.sort(byPrice);
  const options = [...pairs, ...singles];
  const chosen: WhatsappBudgetCombination[] = [];
  const seenFoods = new Set<string>();
  for (const option of options) {
    if (seenFoods.has(option.food.menuItemId)) continue;
    chosen.push(option);
    seenFoods.add(option.food.menuItemId);
    if (chosen.length === limit) break;
  }
  return chosen;
}

export function renderWhatsappBudgetCombinations(input: {
  restaurantName: string;
  branchName: string;
  budget: WhatsappMenuBudget;
  combinations: WhatsappBudgetCombination[];
}): string {
  const money = (amount: number) =>
    `₦${(amount / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const label = (value: string) =>
    value.length > 65 ? value.slice(0, 62) + '…' : value;
  const heading = `🍽️ *${label(input.restaurantName)} — ${label(input.branchName)}*`;
  if (!input.combinations.length)
    return `${heading}\n\nI couldn't build a meal within *${money(input.budget.maxPriceMinorUnit)}* from the available menu items I checked. Open the menu to browse other choices or try a different budget.`;
  const describeModifiers = (choices?: BudgetModifierChoice[]) =>
    choices?.length
      ? `\n   ${choices.map((choice) => `${label(choice.groupName)}: ${choice.quantity} × ${label(choice.name)}`).join('; ')}`
      : '';
  const options = input.combinations.map(
    (option, index) =>
      `${index + 1}. *${money(option.totalMinorUnit)} total*\n1 × ${label(option.food.name)}${describeModifiers(option.foodModifiers)}${option.drink ? `\n1 × ${label(option.drink.name)}${describeModifiers(option.drinkModifiers)}` : ''}`,
  );
  const compose = (shown: string[]) =>
    [
      heading,
      `With *${money(input.budget.maxPriceMinorUnit)}*, you could get:`,
      ...shown,
      input.combinations.some(
        (option) => option.drink || option.foodModifiers?.length,
      )
        ? ''
        : 'These food-only choices fit your budget.',
      `Totals include restaurant charges${input.budget.includesDelivery ? ' and delivery to your shared location' : '; delivery is extra'}. Shown extras are included; other choices may cost more.`,
      'Open the menu below to choose. Prices and availability are confirmed at checkout.',
    ]
      .filter(Boolean)
      .join('\n\n');
  // Keep each configuration intact: remove whole suggestions, never hide a
  // required modifier while still displaying its price.
  while (options.length && compose(options).length > 1024) options.pop();
  return options.length
    ? compose(options)
    : `${heading}\n\nThis meal has too many choices to show here. Open the menu to customize within your budget.`;
}
