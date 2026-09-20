import { toNullableRecord as readRecord } from '@common/utils/object.util';

export type WhatsappMenuBudget = {
  maxPriceMinorUnit: number;
  currency: 'NGN';
  includesDelivery: boolean;
};

// A discovery cap, not an amount to charge. Keep arithmetic bounded and reject
// ambiguous currencies/ranges rather than silently converting or rounding them.
export const MAX_MENU_BUDGET_MINOR_UNIT = 100_000_000;
export function readWhatsappMenuBudget(
  value: unknown,
): WhatsappMenuBudget | null {
  const budget = readRecord(value);
  return budget &&
    budget.currency === 'NGN' &&
    Number.isSafeInteger(budget.maxPriceMinorUnit) &&
    Number(budget.maxPriceMinorUnit) > 0 &&
    Number(budget.maxPriceMinorUnit) <= MAX_MENU_BUDGET_MINOR_UNIT &&
    typeof budget.includesDelivery === 'boolean'
    ? {
        maxPriceMinorUnit: Number(budget.maxPriceMinorUnit),
        currency: 'NGN',
        includesDelivery: budget.includesDelivery,
      }
    : null;
}

/** Strict, familiar budget phrases run locally; other wording can reach AI. */
export function extractWhatsappBudgetSearch(text: string): {
  budget: WhatsappMenuBudget;
  q?: string;
  itemQuery?: string;
} | null {
  if (
    /\b(?:not|don't|dont|cancel|change|modify|refund|instead|between|or|each|people|persons)\b/.test(
      text,
    )
  )
    return null;
  const match =
    /^(?:what (?:(?:food|meals?) )?can i (?:get|buy|order)|(?:find|show)(?: me)? (?:food|meals?)|(?:get|buy|order) (.+?)) (?:for|under|within|up to|with) (?:a budget of )?(?:₦|ngn\s*|n\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(k)?(?:\s*naira)?(.*)$/.exec(
      text,
    );
  if (!match) {
    const short = /^(?:something|food|a meal) (?:for|under|within) (.+)$/.exec(
      text,
    );
    return short
      ? extractWhatsappBudgetSearch(`get food for ${short[1]}`)
      : null;
  }
  const amount = Number(match[2].replace(/,/g, '')) * (match[3] ? 1000 : 1);
  let tail = match[4].trim();
  const includesDelivery = /(?:including|with) delivery$/.test(tail);
  tail = tail.replace(/(?:including|with) delivery$/, '').trim();
  let q: string | undefined;
  if (tail) {
    const restaurant = /^(?:from|at) (.+)$/.exec(tail);
    if (!restaurant) return null;
    q = restaurant[1].replace(/ restaurants?$/, '').trim();
    if (!q || q.length > 120 || /[₦$€£]|\b(?:ngn|usd|and)\b/.test(q))
      return null;
  }
  const budget = readWhatsappMenuBudget({
    maxPriceMinorUnit: Math.round(amount * 100),
    currency: 'NGN',
    includesDelivery,
  });
  const dish = match[1]?.trim();
  if (
    !budget ||
    (dish?.length ?? 0) > 120 ||
    (dish && /\b(?:order|receipt|payment|same|again|and)\b/.test(dish))
  )
    return null;
  return {
    budget,
    ...(q ? { q } : {}),
    ...(dish && !/^(?:food|meals?)$/.test(dish) ? { itemQuery: dish } : {}),
  };
}
