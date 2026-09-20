import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { customerAiConfig } from '@config/customer-ai.config';
import { redisConfig } from '@config/redis.config';
import { CUSTOMER_AI_SWEEP_JOB } from './customer-ai-queue.constants';
import { CustomerAiQueueService } from './customer-ai-queue.service';

jest.mock('bullmq', () => ({ Queue: jest.fn() }));

describe('CustomerAiQueueService recovery scheduling', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('retries the shared sweep schedule after Redis is down at startup', async () => {
    jest.useFakeTimers();
    const unavailable = createQueueMock();
    unavailable.waitUntilReady.mockRejectedValueOnce(new Error('redis down'));
    const recovered = createQueueMock();
    jest
      .mocked(Queue)
      .mockImplementationOnce(() => unavailable as never)
      .mockImplementationOnce(() => recovered as never);
    const service = createService();

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    expect(unavailable.close).toHaveBeenCalledTimes(1);
    expect(recovered.add).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(50);

    expect(recovered.add).toHaveBeenCalledWith(
      CUSTOMER_AI_SWEEP_JOB,
      {},
      expect.objectContaining({
        repeat: { every: 1000 },
      }),
    );
    await service.onModuleDestroy();
  });

  it('cancels an outstanding retry during shutdown', async () => {
    jest.useFakeTimers();
    const unavailable = createQueueMock();
    unavailable.waitUntilReady.mockRejectedValue(new Error('redis down'));
    jest.mocked(Queue).mockImplementation(() => unavailable as never);
    const service = createService();

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(100);

    expect(Queue).toHaveBeenCalledTimes(1);
  });
});

function createService(): CustomerAiQueueService {
  return new CustomerAiQueueService(
    {
      mode: 'shadow',
      queueEnabled: true,
      sweepIntervalMs: 1000,
      removeOnCompleteCount: 100,
      removeOnFailCount: 100,
      queuePrefix: 'ordira-test',
      queueReadyTimeoutMs: 10,
      queueUnavailableRetryDelayMs: 50,
    } as ConfigType<typeof customerAiConfig>,
    { url: 'redis://localhost:6379' } as ConfigType<typeof redisConfig>,
  );
}

function createQueueMock() {
  return {
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
}
