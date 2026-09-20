import { Injectable } from '@nestjs/common';
import type {
  CustomerAiResponsePlan,
  CustomerAiRunScopedFact,
} from './customer-ai.types';

export type CustomerAiCompiledResponse =
  | {
      status: 'compiled';
      text: string;
      authoritativeFactCount: number;
    }
  | {
      status: 'rejected';
      reasonCode: string;
    };

/**
 * Turns a model-selected plan into text using facts Ordira owns.
 *
 * This is the runtime enforcement behind "the model selects; Ordira prints the
 * money." Prices, availability, and fulfillment are rendered only from facts
 * produced by read tools in the same run. Unknown or wrong-kind refs fail
 * closed instead of being shown to a customer.
 */
@Injectable()
export class CustomerAiResponseCompilerService {
  compile(
    plan: CustomerAiResponsePlan,
    factsByRef: ReadonlyMap<string, CustomerAiRunScopedFact>,
  ): CustomerAiCompiledResponse {
    if (plan.responseType === 'low_risk_text') {
      // Free-form copy is permitted only when it contains no transactional
      // claim. It is suitable for clarification and general discovery wording.
      const text = plan.text.trim();
      if (!text || containsTransactionalClaim(text)) {
        return {
          status: 'rejected',
          reasonCode: 'uncompiled_transactional_claim',
        };
      }

      return { status: 'compiled', text, authoritativeFactCount: 0 };
    }
    if (plan.responseType === 'handoff') {
      // Use fixed Ordira copy rather than exposing a model-authored reason code.
      return {
        status: 'compiled',
        text: 'I need a team member to help with this request.',
        authoritativeFactCount: 0,
      };
    }
    if (plan.responseType === 'menu_recommendation') {
      // Every ref must resolve to a menu fact collected during this run.
      const items = plan.itemRefs.map((ref) => factsByRef.get(ref));
      if (
        items.length === 0 ||
        items.some((item) => !item || item.kind !== 'menu_item')
      ) {
        return { status: 'rejected', reasonCode: 'invalid_menu_item_ref' };
      }
      const lines = items.map((item) => {
        const menuItem = item as Extract<
          CustomerAiRunScopedFact,
          { kind: 'menu_item' }
        >;
        // Money and availability come from the authoritative fact, never from
        // the model's introduction or free-form text.
        const availability = menuItem.orderable ? 'Available' : 'Unavailable';

        return `${menuItem.name} — ${formatMoney(
          menuItem.priceMinorUnit,
          menuItem.currency,
        )} — ${availability}`;
      });

      return {
        status: 'compiled',
        text: [safeIntroduction(plan.introduction), ...lines]
          .filter(Boolean)
          .join('\n'),
        authoritativeFactCount: items.length * 2,
      };
    }

    // The remaining union member is restaurant_recommendation.
    const restaurants = plan.restaurantRefs.map((ref) => factsByRef.get(ref));
    if (
      restaurants.length === 0 ||
      restaurants.some((item) => !item || item.kind !== 'restaurant')
    ) {
      return { status: 'rejected', reasonCode: 'invalid_restaurant_ref' };
    }
    const lines = restaurants.map((item) => {
      const restaurant = item as Extract<
        CustomerAiRunScopedFact,
        { kind: 'restaurant' }
      >;
      const fulfillment = [
        restaurant.pickupEnabled ? 'pickup' : null,
        restaurant.deliveryEnabled ? 'delivery' : null,
      ]
        .filter(Boolean)
        .join(' and ');

      return `${restaurant.name}${fulfillment ? ` — ${fulfillment}` : ''}`;
    });

    return {
      status: 'compiled',
      text: [safeIntroduction(plan.introduction), ...lines]
        .filter(Boolean)
        .join('\n'),
      authoritativeFactCount: restaurants.length,
    };
  }
}

function formatMoney(minorUnit: number, currency: string): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(minorUnit / 100);
}

function safeIntroduction(value?: string): string {
  const introduction = value?.trim() ?? '';

  // Introductions are optional flavor text. Dropping an unsafe introduction
  // preserves the authoritative recommendation lines without trusting prose.
  return containsTransactionalClaim(introduction) ? '' : introduction;
}

function containsTransactionalClaim(value: string): boolean {
  // This deliberately errs on the side of rejecting harmless numbers. Exact
  // transactional facts should always travel through typed refs and rendering.
  return (
    /[₦$€£¥]|\b(?:ngn|usd|eur|gbp)\b|\d/i.test(value) ||
    /\b(?:available|unavailable|in stock|out of stock|total|subtotal|delivery fee|paid|payment|refunded|cancelled|confirmed|order status)\b/i.test(
      value,
    )
  );
}
