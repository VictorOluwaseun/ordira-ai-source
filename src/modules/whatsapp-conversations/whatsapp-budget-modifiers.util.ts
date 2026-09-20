import type { PublicMenuItemCustomizationGroupResponse as Group } from '@modules/menu-modifiers/types/menu-item-customization-response.type';
import type { MenuModifierGroupSelectionInput } from '@modules/menu-modifiers/types/menu-item-modifier-selection.type';

export type BudgetModifierChoice = {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  quantity: number;
  priceMinorUnit: number;
};
export type BudgetItemVariant = {
  priceMinorUnit: number;
  modifiers: BudgetModifierChoice[];
};

/** Bound the search while retaining both affordable and richer configurations.
 * This is a suggestion search, not an exhaustive optimizer. Never truncate a
 * completed configuration's required choices to make its price fit. */
function shortlist<T extends { priceMinorUnit: number }>(
  values: T[],
  limit: number,
): T[] {
  const sorted = values.sort((a, b) => a.priceMinorUnit - b.priceMinorUnit);
  return sorted.length <= limit
    ? sorted
    : [...sorted.slice(0, limit / 2), ...sorted.slice(-limit / 2)];
}

export function buildBudgetItemVariants(
  basePrice: number,
  groups: Group[],
): BudgetItemVariant[] {
  if (!Number.isSafeInteger(basePrice) || basePrice < 0 || groups.length > 20)
    return [];
  let variants: BudgetItemVariant[] = [
    { priceMinorUnit: basePrice, modifiers: [] },
  ];
  for (const group of groups) {
    const min = Math.max(group.required ? 1 : 0, group.minSelections);
    const max =
      group.selectionMode === 'single'
        ? Math.min(1, group.maxSelections)
        : group.maxSelections;
    // Large catering quantities are left to the menu. Every emitted suggestion
    // still obeys the actual minimum/maximum and per-option quantity limits.
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < min ||
      min > 8
    )
      return [];
    const countCap = Math.min(max, 8);
    let states = new Map<number, BudgetItemVariant[]>([
      [0, [{ priceMinorUnit: 0, modifiers: [] }]],
    ]);
    const options = group.options
      .filter(
        (option) =>
          option.orderable &&
          Number.isSafeInteger(option.priceDeltaMinorUnit) &&
          Number.isInteger(option.maxQuantityPerItem) &&
          option.maxQuantityPerItem > 0,
      )
      .sort((a, b) => a.priceDeltaMinorUnit - b.priceDeltaMinorUnit)
      .slice(0, 30);
    for (const option of options) {
      const next = new Map<number, BudgetItemVariant[]>();
      for (const [count, choices] of states) {
        for (
          let quantity = 0;
          quantity <= Math.min(option.maxQuantityPerItem, countCap - count);
          quantity++
        ) {
          const totalCount = count + quantity;
          const bucket = next.get(totalCount) ?? [];
          for (const choice of choices)
            bucket.push({
              priceMinorUnit:
                choice.priceMinorUnit + quantity * option.priceDeltaMinorUnit,
              modifiers: [
                ...choice.modifiers,
                ...(quantity
                  ? [
                      {
                        groupId: group.id,
                        groupName: group.name,
                        optionId: option.id,
                        name: option.name,
                        quantity,
                        priceMinorUnit: quantity * option.priceDeltaMinorUnit,
                      },
                    ]
                  : []),
              ],
            });
          next.set(totalCount, bucket);
        }
      }
      states = new Map(
        [...next].map(([count, choices]) => [count, shortlist(choices, 8)]),
      );
    }
    const groupVariants = shortlist(
      [...states]
        .filter(([count]) => count >= min)
        .flatMap(([, choices]) => choices),
      24,
    );
    variants = shortlist(
      variants.flatMap((item) =>
        groupVariants.map((choice) => ({
          priceMinorUnit: item.priceMinorUnit + choice.priceMinorUnit,
          modifiers: [...item.modifiers, ...choice.modifiers],
        })),
      ),
      24,
    );
    if (!variants.length) return [];
  }
  // With quantity one, per-line and per-unit modifiers each apply exactly once.
  // Checkout's authoritative quote validates this again before a reply is sent.
  return variants.filter(
    (variant) =>
      Number.isSafeInteger(variant.priceMinorUnit) &&
      variant.priceMinorUnit >= 0,
  );
}

export function toBudgetModifierSelections(
  modifiers: BudgetModifierChoice[],
): MenuModifierGroupSelectionInput[] {
  return [...new Set(modifiers.map((choice) => choice.groupId))].map(
    (groupId) => ({
      modifierGroupId: groupId,
      options: modifiers
        .filter((choice) => choice.groupId === groupId)
        .map((choice) => ({
          modifierOptionId: choice.optionId,
          quantity: choice.quantity,
        })),
    }),
  );
}
