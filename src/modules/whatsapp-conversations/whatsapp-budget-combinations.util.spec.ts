import {
  buildWhatsappBudgetCombinations as build,
  renderWhatsappBudgetCombinations as render,
} from './whatsapp-budget-combinations.util';
import type { WhatsappBudgetQuote } from './whatsapp-budget-quote.service';
import { createBudgetMenuItem as item } from './testing/budget-menu-item.fixture';

const budget = {
  maxPriceMinorUnit: 500000,
  currency: 'NGN' as const,
  includesDelivery: false,
};
const quote = {
  maxPriceMinorUnit: 500000,
  minPriceMinorUnit: 0,
  deliveryFeeMinorUnit: 0,
  settings: { currency: 'NGN' },
} as WhatsappBudgetQuote;

describe('WhatsApp meal combinations', () => {
  it('pairs real food and drinks, never exceeds budget, and offers distinct meals', () => {
    const result = build(
      [
        item('Rice', 350000),
        item('Yam', 200000),
        item('Beans', 300000),
        item('Pasta', 250000),
      ],
      [
        item('Juice', 150000, true),
        item('Water', 50000, true),
        item('Smoothie', 400000, true),
      ],
      budget,
      quote,
    );
    expect(result).toHaveLength(3);
    expect(new Set(result.map((option) => option.food.menuItemId)).size).toBe(
      3,
    );
    expect(result[0]).toMatchObject({
      food: { name: 'Rice' },
      drink: { name: 'Juice' },
      totalMinorUnit: 500000,
    });
    expect(
      result.every((option) => option.drink && option.totalMinorUnit <= 500000),
    ).toBe(true);
  });
  it('offers food-only choices when no drink fits, and explains this honestly', () => {
    const combinations = build(
      [item('Rice', 450000)],
      [item('Juice', 100000, true)],
      budget,
      quote,
    );
    expect(combinations).toEqual([
      { food: item('Rice', 450000), totalMinorUnit: 450000 },
    ]);
    const body = render({
      restaurantName: 'Love',
      branchName: 'Majek',
      budget,
      combinations,
    });
    expect(body).toContain('food-only');
    expect(body).toContain('₦4,500.00 total');
    expect(body).not.toContain('Juice');
  });
  it('excludes unavailable, foreign-currency and required-customization items', () => {
    const unavailable = item('Rice', 100000);
    unavailable.availability.orderable = false;
    const foreign = item('Yam', 100000);
    foreign.currency = 'USD';
    const required = item('Beans', 100000);
    required.customization.required = true;
    const negative = item('Pasta', -1);
    expect(
      build(
        [unavailable, foreign, required, negative],
        [item('Juice', 50000, true)],
        budget,
        quote,
      ),
    ).toEqual([]);
  });
  it('applies delivery minimum to the combination and charges delivery only once', () => {
    const deliveryQuote = {
      ...quote,
      minPriceMinorUnit: 300000,
      maxPriceMinorUnit: 350000,
      deliveryFeeMinorUnit: 100000,
      settings: {
        ...quote.settings,
        serviceChargeEnabled: true,
        serviceChargePercent: 10,
      },
    };
    const combinations = build(
      [item('Rice', 250000)],
      [item('Juice', 100000, true)],
      { ...budget, includesDelivery: true },
      deliveryQuote,
    );
    expect(combinations).toHaveLength(1);
    expect(combinations[0].totalMinorUnit).toBe(485000);
  });
  it('rounds percentage charges on the combined subtotal', () => {
    const combinations = build(
      [item('Rice', 101)],
      [item('Juice', 101, true)],
      budget,
      {
        ...quote,
        settings: {
          ...quote.settings,
          serviceChargeEnabled: true,
          serviceChargePercent: 0.5,
        },
      },
    );
    expect(combinations[0].totalMinorUnit).toBe(203);
  });
  it('returns an honest empty response when nothing fits', () => {
    const combinations = build([item('Rice', 600000)], [], budget, quote);
    expect(
      render({
        restaurantName: 'Love',
        branchName: 'Majek',
        budget,
        combinations,
      }),
    ).toContain("couldn't build a meal");
  });
  it('keeps the three-option reply within the WhatsApp CTA body limit', () => {
    const combinations = build(
      [
        item('A'.repeat(200), 350000),
        item('B'.repeat(200), 300000),
        item('C'.repeat(200), 250000),
      ],
      [item('Juice'.repeat(50), 100000, true)],
      budget,
      quote,
    );
    const body = render({
      restaurantName: 'R'.repeat(200),
      branchName: 'B'.repeat(200),
      budget: { ...budget, includesDelivery: true },
      combinations,
    });
    expect(body.length).toBeLessThanOrEqual(1024);
  });
});
