import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import type { RedisService } from '@database/redis.service';
import { CustomerAiProviderHealthService } from './customer-ai-provider-health.service';

type EvaluateScriptMock = jest.Mock<
  Promise<unknown>,
  [string, readonly string[], readonly string[]]
>;

describe('CustomerAiProviderHealthService', () => {
  const config = {
    breakerMinRequests: 2,
    breakerFailurePercent: 50,
    breakerOpenMs: 1000,
    breakerWindowMs: 5000,
    breakerHalfOpenProbes: 2,
  } as ConfigType<typeof customerAiConfig>;

  it('uses shared Redis state to admit or reject a provider call', async () => {
    const evaluateScript = jest
      .fn<Promise<unknown>, [string, readonly string[], readonly string[]]>()
      .mockResolvedValueOnce([1, 4, 0])
      .mockResolvedValueOnce([0, 5, 0]);
    const service = createService(evaluateScript);

    const permit = await service.acquirePermit('openai:model', 1000);

    expect(permit).toEqual(
      expect.objectContaining({
        key: 'openai:model',
        generation: 4,
        halfOpenProbe: false,
      }),
    );
    expect(permit?.requestId).toEqual(expect.any(String));
    await expect(
      service.acquirePermit('openai:model', 1001),
    ).resolves.toBeNull();
    expect(evaluateScript.mock.calls[0]?.[1]).toHaveLength(1);
    expect(evaluateScript.mock.calls[0]?.[2]).toEqual([
      '1000',
      '1000',
      '2',
      '60',
    ]);
  });

  it('records rolling outcomes against the generation that admitted them', async () => {
    const evaluateScript = jest
      .fn<Promise<unknown>, [string, readonly string[], readonly string[]]>()
      .mockResolvedValueOnce([1, 7, 0])
      .mockResolvedValueOnce(7);
    const service = createService(evaluateScript);
    const permit = await service.acquirePermit('openai:model', 1000);
    if (!permit) throw new Error('Expected provider permit');

    await service.recordFailure(permit, 1200);

    const recordCall = evaluateScript.mock.calls[1];
    expect(recordCall?.[1]).toHaveLength(3);
    expect(recordCall?.[2]).toEqual([
      '7',
      '1200',
      '5000',
      'failure',
      permit.requestId,
      '2',
      '50',
      '60',
    ]);
  });

  it('requires all current-generation half-open probes to succeed', async () => {
    const evaluateScript = jest
      .fn<Promise<unknown>, [string, readonly string[], readonly string[]]>()
      .mockResolvedValueOnce([1, 9, 1])
      .mockResolvedValueOnce([1, 9, 1])
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(10);
    const service = createService(evaluateScript);
    const first = await service.acquirePermit('openai:model', 2000);
    const second = await service.acquirePermit('openai:model', 2001);
    if (!first || !second) throw new Error('Expected half-open permits');

    await service.recordSuccess(first, 2100);
    await service.recordSuccess(second, 2200);

    expect(first.halfOpenProbe).toBe(true);
    expect(second.generation).toBe(first.generation);
    expect(evaluateScript.mock.calls[2]?.[2]).toEqual([
      '9',
      'success',
      '2100',
      '2',
      '60',
    ]);
    expect(evaluateScript.mock.calls[3]?.[2]).toEqual([
      '9',
      'success',
      '2200',
      '2',
      '60',
    ]);
  });

  it('fails closed when shared breaker state is unavailable', async () => {
    const service = createService(
      jest
        .fn<Promise<unknown>, [string, readonly string[], readonly string[]]>()
        .mockRejectedValue(new Error('redis secret host')),
    );

    await expect(service.acquirePermit('openai:model')).rejects.toThrow(
      'CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE',
    );
  });

  it('reads only known shared health states', async () => {
    const evaluateScript = jest
      .fn<Promise<unknown>, [string, readonly string[], readonly string[]]>()
      .mockResolvedValueOnce('half_open')
      .mockResolvedValueOnce('unexpected');
    const service = createService(evaluateScript);

    await expect(service.getState('openai:model')).resolves.toBe('half_open');
    await expect(service.getState('openai:model')).resolves.toBe('healthy');
  });

  function createService(evaluateScript: EvaluateScriptMock) {
    return new CustomerAiProviderHealthService(
      { evaluateScript } as unknown as RedisService,
      config,
    );
  }
});
