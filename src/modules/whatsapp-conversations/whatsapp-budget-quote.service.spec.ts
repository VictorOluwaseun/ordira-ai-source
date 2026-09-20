import type { BranchOperationsService } from '@modules/branch-operations/branch-operations.service';
import type { RestaurantsService } from '@modules/restaurants/restaurants.service';
import {
  WhatsappBudgetQuoteService,
  estimateDeliveredTotal,
} from './whatsapp-budget-quote.service';

function harness() {
  const restaurants = {
    findActiveById: jest.fn().mockResolvedValue({
      settings: {
        currency: 'NGN',
        serviceChargeEnabled: true,
        serviceChargePercent: 10,
        taxPercent: 5,
      },
    }),
  };
  const operations = {
    evaluateOrderAvailability: jest.fn().mockResolvedValue({
      available: true,
      deliveryFeeMinorUnit: 100000,
      deliveryZone: { currency: 'NGN', minimumOrderMinorUnit: 100000 },
    }),
  };
  return {
    restaurants,
    operations,
    service: new WhatsappBudgetQuoteService(
      restaurants as unknown as RestaurantsService,
      operations as unknown as BranchOperationsService,
    ),
  };
}
const input = {
  workspaceId: 'w',
  restaurantId: 'r',
  branchId: 'b',
  latitude: 6.4,
  longitude: 3.4,
  budget: {
    currency: 'NGN' as const,
    maxPriceMinorUnit: 500000,
    includesDelivery: true,
  },
};
describe('delivered food budget estimate', () => {
  it('includes restaurant charges without requiring location for a food budget', async () => {
    const h = harness();
    const quote = await h.service.resolve({
      ...input,
      latitude: undefined,
      longitude: undefined,
      budget: { ...input.budget, includesDelivery: false },
    });
    expect(quote).not.toBeNull();
    expect(quote!.deliveryFeeMinorUnit).toBe(0);
    expect(estimateDeliveredTotal(400000, quote!)).toBe(460000);
    expect(h.operations.evaluateOrderAvailability).not.toHaveBeenCalled();
  });
  it('calculates the exact food cap using delivery, service charge and tax rounding', async () => {
    const h = harness();
    const quote = await h.service.resolve(input);
    expect(quote).not.toBeNull();
    expect(
      estimateDeliveredTotal(quote!.maxPriceMinorUnit, quote!),
    ).toBeLessThanOrEqual(500000);
    expect(
      estimateDeliveredTotal(quote!.maxPriceMinorUnit + 1, quote!),
    ).toBeGreaterThan(500000);
    expect(quote!.minPriceMinorUnit).toBe(100000);
    expect(h.operations.evaluateOrderAvailability).toHaveBeenCalledTimes(1);
    expect(h.operations.evaluateOrderAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: 6.4,
        longitude: 3.4,
        orderValueMinorUnit: 500000,
        fulfillmentType: 'delivery',
      }),
    );
  });
  it.each(['unavailable', 'fee', 'minimum', 'currency'])(
    'does not offer a delivered estimate for %s',
    async (reason) => {
      const h = harness();
      h.operations.evaluateOrderAvailability.mockResolvedValue({
        available: reason !== 'unavailable',
        deliveryFeeMinorUnit: reason === 'fee' ? 600000 : 100000,
        deliveryZone: {
          currency: reason === 'currency' ? 'USD' : 'NGN',
          minimumOrderMinorUnit: reason === 'minimum' ? 450000 : 0,
        },
      });
      expect(await h.service.resolve(input)).toBeNull();
    },
  );
  it('rejects a foreign-currency restaurant before a zone lookup', async () => {
    const h = harness();
    h.restaurants.findActiveById.mockResolvedValue({
      settings: { currency: 'USD' },
    });
    expect(await h.service.resolve(input)).toBeNull();
    expect(h.operations.evaluateOrderAvailability).not.toHaveBeenCalled();
  });
});
