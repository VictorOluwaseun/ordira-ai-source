import { HttpException, Injectable } from '@nestjs/common';
import { MenuModifiersService } from '@modules/menu-modifiers/menu-modifiers.service';
import { MenuItemCustomizationService } from '@modules/menu-modifiers/menu-item-customization.service';
import type { MenuItemModifierPricedSnapshot } from '@modules/menu-modifiers/types/menu-item-modifier-selection.type';
import type { StorefrontMenuItemSearchResult } from '@modules/storefront-search/types/storefront-menu-item-search-response.type';
import {
  buildBudgetItemVariants,
  toBudgetModifierSelections,
  type BudgetItemVariant,
  type BudgetModifierChoice,
} from './whatsapp-budget-modifiers.util';
import {
  buildWhatsappBudgetCombinations,
  type WhatsappBudgetCombination,
} from './whatsapp-budget-combinations.util';
import {
  estimateDeliveredTotal,
  type WhatsappBudgetQuote,
} from './whatsapp-budget-quote.service';
import type { WhatsappMenuBudget } from './whatsapp-budget.util';

/** Uses branch-specific customization data and the actual checkout quote. These
 * are read-only suggestions: no basket edits, stock reservations or payments. */
@Injectable()
export class WhatsappBudgetSuggestionsService {
  constructor(
    private readonly modifiers: MenuModifiersService,
    private readonly pricing: MenuItemCustomizationService,
  ) {}

  /** Preferences are offered as menu choices, never auto-applied or treated as
   * allergy guarantees. Use exact catalog options, scoped to the chosen branch. */
  async findPreferenceChoices(
    scope: {
      workspaceSlug: string;
      restaurantSlug: string;
      branchSlug: string;
    },
    itemId: string,
    preference: string,
  ): Promise<string[]> {
    const aliases: Record<string, string[]> = {
      'not spicy': ['not spicy', 'non spicy', 'mild', 'no pepper', 'no spice'],
      'less spicy': ['less spicy', 'mild'],
      'make it mild': ['mild'],
      'no onions': ['no onions', 'without onions'],
      'without onions': ['no onions', 'without onions'],
      'no pepper': ['no pepper', 'without pepper'],
      'without pepper': ['no pepper', 'without pepper'],
    };
    const expected = aliases[preference] ?? [];
    if (!expected.length) return [];
    const detail = await this.modifiers.getPublicMenuItemCustomization(
      scope.workspaceSlug,
      scope.restaurantSlug,
      itemId,
      { includeUnavailable: false },
      scope.branchSlug,
    );
    if (!detail.item.orderable) return [];
    return detail.modifierGroups
      .flatMap((group) =>
        group.options
          .filter(
            (option) =>
              option.orderable &&
              expected.includes(
                option.name.toLowerCase().replace(/[-_]/g, ' ').trim(),
              ),
          )
          .map((option) => `${group.name}: ${option.name}`),
      )
      .slice(0, 5);
  }

  async suggest(input: {
    foods: StorefrontMenuItemSearchResult[];
    drinks: StorefrontMenuItemSearchResult[];
    scope: {
      workspaceId: string;
      restaurantId: string;
      branchId: string;
      workspaceSlug: string;
      restaurantSlug: string;
      branchSlug: string;
    };
    budget: WhatsappMenuBudget;
    quote: WhatsappBudgetQuote;
  }): Promise<WhatsappBudgetCombination[]> {
    // Keep work bounded, including a cold cache. Four concurrent lookups avoid
    // overwhelming Mongo for restaurants with large menus. Public customization
    // reads already share the menu's cache and invalidation rules.
    const foods = input.foods.slice(0, 12);
    const drinks = input.drinks.slice(0, 8);
    const items = [...foods, ...drinks];
    const variants = new Map<string, BudgetItemVariant[]>();
    const refreshed = new Map<string, StorefrontMenuItemSearchResult>();
    for (let offset = 0; offset < items.length; offset += 4) {
      await Promise.all(
        items.slice(offset, offset + 4).map(async (item) => {
          try {
            const detail = await this.modifiers.getPublicMenuItemCustomization(
              input.scope.workspaceSlug,
              input.scope.restaurantSlug,
              item.menuItemId,
              { includeUnavailable: false },
              input.scope.branchSlug,
            );
            if (
              !detail.item.orderable ||
              detail.item.currency !== input.budget.currency ||
              detail.item.id !== item.menuItemId
            )
              return;
            variants.set(
              item.menuItemId,
              buildBudgetItemVariants(
                detail.item.basePriceMinorUnit,
                detail.modifierGroups,
              ),
            );
            refreshed.set(item.menuItemId, {
              ...item,
              name: detail.item.name,
              basePriceMinorUnit: detail.item.basePriceMinorUnit,
            });
          } catch (error) {
            // A removed item can disappear between discovery and customization.
            // Infrastructure failures must propagate instead of claiming no food.
            if (
              !(error instanceof HttpException) ||
              ![400, 404].includes(error.getStatus())
            )
              throw error;
          }
        }),
      );
    }
    const current = (list: StorefrontMenuItemSearchResult[]) =>
      list.flatMap((item) =>
        refreshed.has(item.menuItemId) ? [refreshed.get(item.menuItemId)!] : [],
      );
    const candidates = buildWhatsappBudgetCombinations(
      current(foods),
      current(drinks),
      input.budget,
      input.quote,
      variants,
      12,
    );
    const suggestions: WhatsappBudgetCombination[] = [];
    // Validate current branch price overrides, quantities, stock and modifier
    // rules using the same quote operation checkout uses. Never trust cached
    // menu availability or a computed suggestion as purchase authorization.
    for (const candidate of candidates) {
      try {
        const { items: quoted } = await this.pricing.quoteOrderItems({
          workspaceId: input.scope.workspaceId,
          restaurantId: input.scope.restaurantId,
          branchId: input.scope.branchId,
          items: [
            {
              menuItemId: candidate.food.menuItemId,
              quantity: 1,
              modifierSelections: toBudgetModifierSelections(
                candidate.foodModifiers ?? [],
              ),
            },
            ...(candidate.drink
              ? [
                  {
                    menuItemId: candidate.drink.menuItemId,
                    quantity: 1,
                    modifierSelections: toBudgetModifierSelections(
                      candidate.drinkModifiers ?? [],
                    ),
                  },
                ]
              : []),
          ],
        });
        if (
          quoted.length !== (candidate.drink ? 2 : 1) ||
          quoted.some((item) => item.currency !== input.budget.currency)
        )
          continue;
        const subtotal = quoted.reduce(
          (sum, item) => sum + item.lineTotalMinorUnit,
          0,
        );
        const totalMinorUnit = estimateDeliveredTotal(subtotal, input.quote);
        if (
          !Number.isSafeInteger(totalMinorUnit) ||
          totalMinorUnit < 0 ||
          subtotal < input.quote.minPriceMinorUnit ||
          totalMinorUnit > input.budget.maxPriceMinorUnit
        )
          continue;
        suggestions.push({
          ...candidate,
          food: { ...candidate.food, name: quoted[0].name },
          foodModifiers: snapshotModifiers(quoted[0]),
          ...(candidate.drink
            ? {
                drink: { ...candidate.drink, name: quoted[1].name },
                drinkModifiers: snapshotModifiers(quoted[1]),
              }
            : {}),
          totalMinorUnit,
        });
        if (suggestions.length === 3) break;
      } catch (error) {
        if (
          !(error instanceof HttpException) ||
          ![400, 404].includes(error.getStatus())
        )
          throw error;
      }
    }
    return suggestions;
  }
}

function snapshotModifiers(
  item: MenuItemModifierPricedSnapshot,
): BudgetModifierChoice[] {
  return item.modifierSelections.flatMap((group) =>
    group.options.map((option) => ({
      groupId: group.modifierGroupId,
      groupName: group.groupName,
      optionId: option.modifierOptionId,
      name: option.optionName,
      quantity: option.quantity,
      priceMinorUnit: option.totalPriceDeltaMinorUnit,
    })),
  );
}
