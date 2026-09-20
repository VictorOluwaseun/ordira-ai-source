import { Injectable } from '@nestjs/common';
import { BranchOperationsService } from '@modules/branch-operations/branch-operations.service';
import { RestaurantsService } from '@modules/restaurants/restaurants.service';
import { calculateOrderTotals } from '@modules/orders/order-totals.util';
import { OrderFulfillmentType } from '@modules/orders/schemas/order.schema';
import type { RestaurantSettings } from '@modules/restaurants/schemas/restaurant.schema';
import type { WhatsappMenuBudget } from './whatsapp-budget.util';

export type WhatsappBudgetQuote = {
  maxPriceMinorUnit: number;
  minPriceMinorUnit: number;
  settings: RestaurantSettings;
  deliveryFeeMinorUnit: number;
};

/** Read-only meal estimates using the same zone and charge rules as checkout.
 * No item, modifier, order or payment is selected/created by this service. */
@Injectable()
export class WhatsappBudgetQuoteService {
  constructor(
    private readonly restaurants: RestaurantsService,
    private readonly operations: BranchOperationsService,
  ) {}

  async resolve(input: {
    workspaceId: string;
    restaurantId: string;
    branchId: string;
    latitude?: number;
    longitude?: number;
    budget: WhatsappMenuBudget;
  }): Promise<WhatsappBudgetQuote | null> {
    const restaurant = await this.restaurants.findActiveById(
      input.workspaceId,
      input.restaurantId,
    );
    if (!restaurant || restaurant.settings.currency !== input.budget.currency)
      return null;
    // Evaluate once at the maximum possible subtotal to resolve the zone, fees,
    // hours, pauses and coverage. The zone's actual minimum is applied below.
    if (
      input.budget.includesDelivery &&
      (input.latitude === undefined || input.longitude === undefined)
    )
      return null;
    const availability = input.budget.includesDelivery
      ? await this.operations.evaluateOrderAvailability({
          workspaceId: input.workspaceId,
          restaurantId: input.restaurantId,
          branchId: input.branchId,
          fulfillmentType: OrderFulfillmentType.Delivery,
          latitude: input.latitude,
          longitude: input.longitude,
          orderValueMinorUnit: input.budget.maxPriceMinorUnit,
        })
      : { available: true, deliveryFeeMinorUnit: 0, deliveryZone: null };
    if (
      !availability.available ||
      (availability.deliveryZone &&
        availability.deliveryZone.currency !== input.budget.currency)
    )
      return null;
    const quote: WhatsappBudgetQuote = {
      settings: restaurant.settings,
      deliveryFeeMinorUnit: availability.deliveryFeeMinorUnit,
      minPriceMinorUnit: availability.deliveryZone?.minimumOrderMinorUnit ?? 0,
      maxPriceMinorUnit: input.budget.maxPriceMinorUnit,
    };
    // Charges are monotonic percentages plus a zone fee. Binary search finds
    // the exact inclusive food-price cap, including checkout's rounding rules.
    let low = 0;
    let high = input.budget.maxPriceMinorUnit;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateDeliveredTotal(mid, quote) <= input.budget.maxPriceMinorUnit)
        low = mid;
      else high = mid - 1;
    }
    quote.maxPriceMinorUnit = low;
    return low >= quote.minPriceMinorUnit &&
      estimateDeliveredTotal(low, quote) <= input.budget.maxPriceMinorUnit
      ? quote
      : null;
  }
}

export function estimateDeliveredTotal(
  price: number,
  quote: WhatsappBudgetQuote,
): number {
  return calculateOrderTotals(
    [{ currency: 'NGN', lineTotalMinorUnit: price }],
    quote.settings,
    {
      deliveryFeeMinorUnit: quote.deliveryFeeMinorUnit,
      currencyMismatchError: () => new Error('Budget quote currency mismatch'),
    },
  ).totalMinorUnit;
}
