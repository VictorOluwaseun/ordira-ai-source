import { BadRequestException } from '@nestjs/common';
import type { MenuModifiersService } from '@modules/menu-modifiers/menu-modifiers.service';
import type { MenuItemCustomizationService } from '@modules/menu-modifiers/menu-item-customization.service';
import type { MenuItemModifierPricedSnapshot } from '@modules/menu-modifiers/types/menu-item-modifier-selection.type';
import type { PublicMenuItemCustomizationResponse } from '@modules/menu-modifiers/types/menu-item-customization-response.type';
import type { WhatsappBudgetQuote } from './whatsapp-budget-quote.service';
import { WhatsappBudgetSuggestionsService } from './whatsapp-budget-suggestions.service';
import { renderWhatsappBudgetCombinations } from './whatsapp-budget-combinations.util';
import {
  createBudgetMenuItem as item,
  modifierGroup,
} from './testing/budget-menu-item.fixture';

function harness() {
  const foods = [item('Rice', 300000)];
  foods[0].customization = {
    hasModifiers: true,
    modifierGroupCount: 1,
    required: true,
    orderable: true,
  };
  const drinks = [item('Juice', 50000, true)];
  const details = new Map<string, PublicMenuItemCustomizationResponse>(
    [...foods, ...drinks].map((food) => [
      food.menuItemId,
      {
        item: {
          id: food.menuItemId,
          name: food.name,
          slug: food.slug,
          imageUrls: [],
          basePriceMinorUnit: food.basePriceMinorUnit,
          currency: 'NGN',
          availabilityStatus: 'available',
          effectiveAvailabilityStatus: 'available',
          orderable: true,
        },
        modifierGroups:
          food.name === 'Rice'
            ? [modifierGroup({ required: true, minSelections: 1 })]
            : [],
      },
    ]),
  );
  const modifiers = {
    getPublicMenuItemCustomization: jest
      .fn<
        Promise<PublicMenuItemCustomizationResponse>,
        Parameters<MenuModifiersService['getPublicMenuItemCustomization']>
      >()
      .mockImplementation((_w, _r, id) => Promise.resolve(details.get(id)!)),
  };
  const pricing = {
    quoteOrderItems: jest
      .fn<
        ReturnType<MenuItemCustomizationService['quoteOrderItems']>,
        Parameters<MenuItemCustomizationService['quoteOrderItems']>
      >()
      .mockImplementation((input) =>
        Promise.resolve({
          items: input.items.map((selection) => {
            const detail = details.get(selection.menuItemId)!;
            const modifierSelections = (selection.modifierSelections ?? []).map(
              (group) => {
                const definition = detail.modifierGroups.find(
                  (g) => g.id === group.modifierGroupId,
                )!;
                return {
                  modifierGroupId: definition.id,
                  groupName: definition.name,
                  selectionMode: definition.selectionMode,
                  quantityBehavior: definition.quantityBehavior,
                  options: group.options.map((option) => {
                    const value = definition.options.find(
                      (o) => o.id === option.modifierOptionId,
                    )!;
                    return {
                      modifierOptionId: value.id,
                      optionName: value.name,
                      quantity: option.quantity,
                      unitPriceDeltaMinorUnit: value.priceDeltaMinorUnit,
                      totalPriceDeltaMinorUnit:
                        value.priceDeltaMinorUnit * option.quantity,
                      availabilityStatus: 'available',
                      branchAvailabilityStatus: null,
                    };
                  }),
                };
              },
            );
            return {
              menuItemId: detail.item.id,
              name: detail.item.name,
              currency: 'NGN',
              lineTotalMinorUnit:
                detail.item.basePriceMinorUnit +
                modifierSelections
                  .flatMap((g) => g.options)
                  .reduce((sum, o) => sum + o.totalPriceDeltaMinorUnit, 0),
              modifierSelections,
            } as MenuItemModifierPricedSnapshot;
          }),
        }),
      ),
  };
  return {
    details,
    modifiers,
    pricing,
    service: new WhatsappBudgetSuggestionsService(
      modifiers as unknown as MenuModifiersService,
      pricing as unknown as MenuItemCustomizationService,
    ),
    input: {
      foods,
      drinks,
      budget: {
        currency: 'NGN' as const,
        maxPriceMinorUnit: 500000,
        includesDelivery: false,
      },
      quote: {
        settings: { currency: 'NGN' },
        minPriceMinorUnit: 0,
        maxPriceMinorUnit: 500000,
        deliveryFeeMinorUnit: 0,
      } as WhatsappBudgetQuote,
      scope: {
        workspaceId: 'w',
        restaurantId: 'r',
        branchId: 'b',
        workspaceSlug: 'workspace',
        restaurantSlug: 'love',
        branchSlug: 'majek',
      },
    },
  };
}

describe('budget suggestions with extras', () => {
  it('offers only exact available menu preference options', async () => {
    const h = harness();
    const group = h.details.get('Rice')!.modifierGroups[0];
    group.name = 'Spice level';
    group.options[0].name = 'Mild';
    group.options[1].name = 'No pepper';
    group.options[1].orderable = false;
    expect(
      await h.service.findPreferenceChoices(h.input.scope, 'Rice', 'not spicy'),
    ).toEqual(['Spice level: Mild']);
    expect(
      await h.service.findPreferenceChoices(h.input.scope, 'Rice', 'no onions'),
    ).toEqual([]);
    expect(
      await h.service.findPreferenceChoices(
        h.input.scope,
        'Rice',
        'peanut allergy',
      ),
    ).toEqual([]);
  });
  it('suggests food with required protein and a drink, priced by checkout', async () => {
    const h = harness();
    const result = await h.service.suggest(h.input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      totalMinorUnit: 450000,
      foodModifiers: [{ name: 'Chicken', quantity: 1 }],
      drink: { name: 'Juice' },
    });
    expect(h.modifiers.getPublicMenuItemCustomization).toHaveBeenCalledWith(
      'workspace',
      'love',
      'Rice',
      { includeUnavailable: false },
      'majek',
    );
    expect(h.pricing.quoteOrderItems).toHaveBeenCalledWith({
      workspaceId: 'w',
      restaurantId: 'r',
      branchId: 'b',
      items: [
        {
          menuItemId: 'Rice',
          quantity: 1,
          modifierSelections: [
            {
              modifierGroupId: 'protein',
              options: [{ modifierOptionId: 'chicken', quantity: 1 }],
            },
          ],
        },
        { menuItemId: 'Juice', quantity: 1, modifierSelections: [] },
      ],
    });
    const body = renderWhatsappBudgetCombinations({
      restaurantName: 'Love',
      branchName: 'Majek',
      budget: h.input.budget,
      combinations: result,
    });
    expect(body).toContain('Protein: 1 × Chicken');
    expect(body).toContain('₦4,500.00 total');
    expect(body).toContain('Shown extras are included');
  });
  it('suggests optional extras without requiring a standalone drink', async () => {
    const h = harness();
    h.input.drinks = [];
    const group = h.details.get('Rice')!.modifierGroups[0];
    group.required = false;
    group.minSelections = 0;
    const result = await h.service.suggest(h.input);
    expect(result[0]).toMatchObject({
      totalMinorUnit: 400000,
      foodModifiers: [{ name: 'Chicken' }],
    });
    expect(result[0].drink).toBeUndefined();
  });

  it('includes modifiers on a drink and multiple food groups in the combined total', async () => {
    const h = harness();
    const sauce = modifierGroup({ id: 'sauce', name: 'Sauce' });
    sauce.options = [
      {
        ...sauce.options[0],
        id: 'pepper',
        name: 'Pepper sauce',
        priceDeltaMinorUnit: 20000,
      },
    ];
    h.details.get('Rice')!.modifierGroups.push(sauce);
    const size = modifierGroup({
      id: 'size',
      name: 'Size',
      required: true,
      minSelections: 1,
    });
    size.options = [
      {
        ...size.options[0],
        id: 'large',
        name: 'Large',
        priceDeltaMinorUnit: 20000,
      },
    ];
    h.details.get('Juice')!.modifierGroups.push(size);
    const result = await h.service.suggest(h.input);
    expect(result[0]).toMatchObject({
      totalMinorUnit: 490000,
      foodModifiers: [{ name: 'Chicken' }, { name: 'Pepper sauce' }],
      drinkModifiers: [{ name: 'Large' }],
    });
    const body = renderWhatsappBudgetCombinations({
      restaurantName: 'Love',
      branchName: 'Majek',
      budget: h.input.budget,
      combinations: result,
    });
    expect(body).toContain('Sauce: 1 × Pepper sauce');
    expect(body).toContain('Size: 1 × Large');
    expect(body.length).toBeLessThanOrEqual(1024);
  });
  it('uses an available alternative and rejects an unsatisfied required group', async () => {
    const h = harness();
    const group = h.details.get('Rice')!.modifierGroups[0];
    group.options[0].orderable = false;
    expect((await h.service.suggest(h.input))[0].foodModifiers?.[0].name).toBe(
      'Fish',
    );
    group.options[1].orderable = false;
    expect(await h.service.suggest(h.input)).toEqual([]);
  });
  it('omits choices that become unavailable during authoritative pricing', async () => {
    const h = harness();
    h.pricing.quoteOrderItems.mockRejectedValue(
      new BadRequestException('Out of stock'),
    );
    expect(await h.service.suggest(h.input)).toEqual([]);
  });
  it('does not emit a stale price when the final quote exceeds budget', async () => {
    const h = harness();
    h.pricing.quoteOrderItems.mockResolvedValue({
      items: [
        {
          name: 'Rice',
          currency: 'NGN',
          lineTotalMinorUnit: 500000,
          modifierSelections: [],
        },
        {
          name: 'Juice',
          currency: 'NGN',
          lineTotalMinorUnit: 100000,
          modifierSelections: [],
        },
      ] as MenuItemModifierPricedSnapshot[],
    });
    expect(await h.service.suggest(h.input)).toEqual([]);
  });
  it('propagates infrastructure failures rather than reporting no meals', async () => {
    const h = harness();
    h.modifiers.getPublicMenuItemCustomization.mockRejectedValue(
      new Error('Database unavailable'),
    );
    await expect(h.service.suggest(h.input)).rejects.toThrow(
      'Database unavailable',
    );
  });
});
