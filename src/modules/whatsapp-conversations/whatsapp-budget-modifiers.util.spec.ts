import { modifierGroup } from './testing/budget-menu-item.fixture';
import {
  buildBudgetItemVariants,
  toBudgetModifierSelections,
} from './whatsapp-budget-modifiers.util';

describe('budget modifier configurations', () => {
  it('includes optional extras and retains the plain item', () => {
    const variants = buildBudgetItemVariants(300000, [modifierGroup()]);
    expect(variants.map((v) => v.priceMinorUnit)).toEqual([
      300000, 380000, 400000,
    ]);
    expect(variants.every((v) => v.modifiers.length <= 1)).toBe(true);
  });
  it('includes every required group and excludes unavailable options', () => {
    const group = modifierGroup({ required: true, minSelections: 1 });
    group.options[0].orderable = false;
    const sauce = modifierGroup({
      id: 'sauce',
      name: 'Sauce',
      required: true,
      minSelections: 1,
      quantityBehavior: 'per_line',
    });
    const variants = buildBudgetItemVariants(300000, [group, sauce]);
    expect(variants).toHaveLength(2);
    expect(
      variants.every(
        (v) => v.modifiers.length === 2 && v.modifiers[0].optionId === 'fish',
      ),
    ).toBe(true);
    expect(variants[0].priceMinorUnit).toBe(460000);
    expect(toBudgetModifierSelections(variants[0].modifiers)).toEqual([
      {
        modifierGroupId: 'protein',
        options: [{ modifierOptionId: 'fish', quantity: 1 }],
      },
      {
        modifierGroupId: 'sauce',
        options: [{ modifierOptionId: 'fish', quantity: 1 }],
      },
    ]);
  });
  it('respects multi-select totals and per-option maximum quantities', () => {
    const group = modifierGroup({
      selectionMode: 'multiple',
      minSelections: 2,
      maxSelections: 3,
      required: true,
    });
    group.options[0].maxQuantityPerItem = 2;
    const variants = buildBudgetItemVariants(100000, [group]);
    expect(
      variants.some((v) =>
        v.modifiers.some((m) => m.optionId === 'chicken' && m.quantity === 2),
      ),
    ).toBe(true);
    for (const variant of variants) {
      const total = variant.modifiers.reduce((sum, m) => sum + m.quantity, 0);
      expect(total).toBeGreaterThanOrEqual(2);
      expect(total).toBeLessThanOrEqual(3);
      expect(
        variant.modifiers.find((m) => m.optionId === 'fish')?.quantity ?? 0,
      ).toBeLessThanOrEqual(1);
    }
  });
  it('does not suggest an item when required selections cannot be met', () => {
    expect(
      buildBudgetItemVariants(300000, [
        modifierGroup({ required: true, minSelections: 1, options: [] }),
      ]),
    ).toEqual([]);
    expect(
      buildBudgetItemVariants(300000, [
        modifierGroup({ required: true, minSelections: 2, maxSelections: 1 }),
      ]),
    ).toEqual([]);
  });
  it('keeps configuration search bounded across many groups', () => {
    const variants = buildBudgetItemVariants(
      300000,
      Array.from({ length: 10 }, (_, i) => modifierGroup({ id: `group-${i}` })),
    );
    expect(variants.length).toBeLessThanOrEqual(24);
    expect(variants.some((v) => v.modifiers.length === 0)).toBe(true);
  });
});
