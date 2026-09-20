import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue, type JobsOptions } from 'bullmq';
import { customerAiConfig } from '@config/customer-ai.config';
import { redisConfig } from '@config/redis.config';
import {
  CUSTOMER_AI_PROCESS_JOB,
  CUSTOMER_AI_QUEUE_NAME,
  CUSTOMER_AI_SWEEP_JOB,
  CUSTOMER_AI_SWEEP_JOB_ID,
  customerAiProcessJobId,
  type CustomerAiJobData,
} from './customer-ai-queue.constants';

/**
 * Owns the producer side of the dedicated customer-AI BullMQ queue.
 * Queue connectivity is lazy and failure is reported as `false`, allowing the
 * live WhatsApp path to continue when the experimental queue is unavailable.
 */
@Injectable()
export class CustomerAiQueueService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CustomerAiQueueService.name);
  private queue?: Queue<CustomerAiJobData, void, string>;
  private queueInitPromise?: Promise<Queue<CustomerAiJobData, void, string>>;
  private sweepScheduleRetry?: NodeJS.Timeout;
  private destroyed = false;

  constructor(
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigType<typeof redisConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.mode === 'shadow' && this.config.queueEnabled) {
      // Scheduling also warms the lazy connection. A startup Redis outage is
      // retried until the shared repeat job exists, so durable Mongo runs do not
      // remain stranded after Redis recovers.
      void this.ensureSweepScheduled();
    }
  }

  async enqueueProcessJob(runId: string, recovery = false): Promise<boolean> {
    if (this.config.mode !== 'shadow' || !this.config.queueEnabled) {
      return false;
    }
    const discriminator = recovery
      ? `recovery-${Math.floor(Date.now() / this.config.sweepIntervalMs)}`
      : 'initial';
    try {
      // Job IDs make initial delivery and each recovery sweep idempotent.
      await (
        await this.getQueue()
      ).add(
        CUSTOMER_AI_PROCESS_JOB,
        { customerAiRunId: runId },
        this.processJobOptions(runId, discriminator),
      );
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'customer_ai_enqueue_failed',
        customerAiRunId: runId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return false;
    }
  }

  async scheduleSweepJob(): Promise<boolean> {
    if (this.config.mode !== 'shadow' || !this.config.queueEnabled) {
      return false;
    }
    try {
      // A fixed job ID ensures all API/worker instances converge on one repeat
      // schedule instead of registering a timer per process.
      await (
        await this.getQueue()
      ).add(
        CUSTOMER_AI_SWEEP_JOB,
        {},
        {
          jobId: CUSTOMER_AI_SWEEP_JOB_ID,
          repeat: { every: this.config.sweepIntervalMs },
          priority: 100,
          removeOnComplete: { count: this.config.removeOnCompleteCount },
          removeOnFail: { count: this.config.removeOnFailCount },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'customer_ai_sweep_schedule_failed',
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.sweepScheduleRetry) {
      clearTimeout(this.sweepScheduleRetry);
      this.sweepScheduleRetry = undefined;
    }
    await this.queue?.close();
  }

  private async ensureSweepScheduled(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (await this.scheduleSweepJob()) {
      return;
    }
    if (this.sweepScheduleRetry || this.destroyed) {
      return;
    }

    this.sweepScheduleRetry = setTimeout(() => {
      this.sweepScheduleRetry = undefined;
      void this.ensureSweepScheduled();
    }, this.config.queueUnavailableRetryDelayMs);
  }

  private processJobOptions(runId: string, discriminator: string): JobsOptions {
    return {
      jobId: customerAiProcessJobId(runId, discriminator),
      attempts: 1,
      removeOnComplete: { count: this.config.removeOnCompleteCount },
      removeOnFail: { count: this.config.removeOnFailCount },
    };
  }

  private async getQueue(): Promise<Queue<CustomerAiJobData, void, string>> {
    if (this.queue) {
      return this.queue;
    }
    // Share one initialization promise among concurrent first callers.
    this.queueInitPromise ??= this.createReadyQueue();
    try {
      return await this.queueInitPromise;
    } finally {
      this.queueInitPromise = undefined;
    }
  }

  private async createReadyQueue(): Promise<
    Queue<CustomerAiJobData, void, string>
  > {
    const queue = new Queue<CustomerAiJobData, void, string>(
      CUSTOMER_AI_QUEUE_NAME,
      {
        connection: {
          url: this.redis.url,
          connectTimeout: this.config.queueReadyTimeoutMs,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          // This service owns the retry cadence. Prevent ioredis from keeping a
          // failed startup connection and its reconnect timer alive after the
          // Queue has been closed; the next application retry gets a new Queue.
          retryStrategy: () => null,
        },
        prefix: this.config.queuePrefix,
      },
    );
    // BullMQ prints an unhandled EventEmitter error directly to stderr when a
    // first connection fails. The surrounding catch already records one
    // sanitized operational warning, so consume the duplicate low-level event.
    queue.on('error', () => undefined);
    try {
      // BullMQ can otherwise buffer commands while Redis is offline. Shadow
      // enqueueing instead fails quickly and leaves recovery to the sweep.
      await withTimeout(
        queue.waitUntilReady(),
        this.config.queueReadyTimeoutMs,
        'Customer AI queue readiness timeout',
      );
      this.queue = queue;

      return queue;
    } catch (error) {
      await queue.close().catch(() => undefined);
      await queue.disconnect().catch(() => undefined);
      throw error;
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  // The timer is always cleared so a successful queue connection does not keep
  // the Node.js process alive.
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
