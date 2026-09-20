import { CustomerAiReadToolsService } from './customer-ai-read-tools.service';
import type { CustomerAiRunScopedFact } from './customer-ai.types';

describe('CustomerAiReadToolsService', () => {
  it('returns bounded opaque references and public menu facts', async () => {
    const directorySearchService = { search: jest.fn() };
    const menuItemSearchService = {
      search: jest.fn().mockResolvedValue({
        data: [
          {
            menuItemId: 'internal-menu-id',
            name: 'Chicken Burger',
            description: 'Grilled chicken',
            basePriceMinorUnit: 850000,
            currency: 'NGN',
            availability: { orderable: true },
            customization: { orderable: true },
            restaurant: { id: 'internal-restaurant-id', name: 'Kitchen' },
            branch: {
              id: 'internal-branch-id',
              name: 'Lekki',
              pickupEnabled: true,
              deliveryEnabled: true,
            },
          },
        ],
        meta: { total: 1 },
      }),
    };
    const service = new CustomerAiReadToolsService(
      directorySearchService as never,
      menuItemSearchService as never,
    );
    const factsByRef = new Map<string, CustomerAiRunScopedFact>();

    const result = await service.execute(
      {
        callId: 'call-1',
        toolName: 'search_menu_items',
        arguments: { q: 'burger', limit: 50 },
      },
      { runId: 'run-1', sequence: 1, factsByRef },
    );

    expect(menuItemSearchService.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4, includeUnavailable: false }),
    );
    expect(result.returnedRefs[0]).toMatch(/^ref_[a-f0-9]{20}$/);
    expect(JSON.stringify(result.providerResult.output)).not.toContain(
      'internal-menu-id',
    );
    expect(factsByRef.get(result.returnedRefs[0])).toEqual(
      expect.objectContaining({
        kind: 'menu_item',
        priceMinorUnit: 850000,
        orderable: true,
      }),
    );
  });

  it('rejects partial coordinates', async () => {
    const service = new CustomerAiReadToolsService(
      { search: jest.fn() } as never,
      { search: jest.fn() } as never,
    );

    await expect(
      service.execute(
        {
          callId: 'call-1',
          toolName: 'search_restaurants',
          arguments: { lat: 6.45 },
        },
        { runId: 'run-1', sequence: 1, factsByRef: new Map() },
      ),
    ).rejects.toThrow('lat and lng must be provided together');
  });

  it('rejects model-supplied tenant scope and unknown properties', async () => {
    const service = new CustomerAiReadToolsService(
      { search: jest.fn() } as never,
      { search: jest.fn() } as never,
    );

    await expect(
      service.execute(
        {
          callId: 'call-1',
          toolName: 'search_menu_items',
          arguments: { q: 'burger', workspaceId: 'another-tenant' },
        },
        { runId: 'run-1', sequence: 1, factsByRef: new Map() },
      ),
    ).rejects.toThrow('unexpected search argument: workspaceId');
  });
});
