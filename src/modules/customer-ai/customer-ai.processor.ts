import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { type Job, Worker } from 'bullmq';
import { customerAiConfig } from '@config/customer-ai.config';
import { redisConfig } from '@config/redis.config';
import { CustomerAiOrchestratorService } from './customer-ai-orchestrator.service';
import {
  CUSTOMER_AI_PROCESS_JOB,
  CUSTOMER_AI_QUEUE_NAME,
  CUSTOMER_AI_SWEEP_JOB,
  type CustomerAiJobData,
} from './customer-ai-queue.constants';
import { CustomerAiQueueService } from './customer-ai-queue.service';
import { CustomerAiRepository } from './customer-ai.repository';

/**
 * Worker-side queue consumer. It handles two job types:
 * 1. process one durable AI run through the orchestrator;
 * 2. periodically find queued/stale runs and enqueue recovery attempts.
 */
@Injectable()
export class CustomerAiProcessor
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CustomerAiProcessor.name);
  private worker?: Worker<CustomerAiJobData, void, string>;

  constructor(
    private readonly orchestrator: CustomerAiOrchestratorService,
    private readonly repository: CustomerAiRepository,
    private readonly queueService: CustomerAiQueueService,
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigType<typeof redisConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.mode !== 'shadow' || !this.config.queueEnabled) {
      return;
    }
    this.worker = new Worker<CustomerAiJobData, void, string>(
      CUSTOMER_AI_QUEUE_NAME,
      (job) => this.process(job),
      {
        // autorun=false lets listeners be installed before the worker starts
        // accepting jobs. The queue service independently retries installation
        // of the shared recovery schedule until Redis is available.
        autorun: false,
        concurrency: this.config.queueConcurrency,
        connection: { url: this.redis.url },
        prefix: this.config.queuePrefix,
      },
    );
    this.worker.on('error', (error) => {
      this.logger.error({
        event: 'customer_ai_worker_error',
        error: error.message,
      });
    });
    void this.worker.run().catch((error: unknown) => {
      this.logger.error({
        event: 'customer_ai_worker_run_failed',
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async process(job: Job<CustomerAiJobData, void, string>): Promise<void> {
    if (job.name === CUSTOMER_AI_SWEEP_JOB) {
      // Recovery is bounded and oldest-first in the repository. Claim filters
      // still decide ownership, so duplicate sweep observations are harmless.
      const runIds = await this.repository.findRecoverableRunIds({
        staleBefore: new Date(Date.now() - this.config.recoveryStaleAfterMs),
        limit: this.config.sweepBatchSize,
      });
      await Promise.all(
        runIds.map((runId) => this.queueService.enqueueProcessJob(runId, true)),
      );
      return;
    }
    if (job.name !== CUSTOMER_AI_PROCESS_JOB || !hasRunId(job.data)) {
      throw new Error(`Invalid customer AI job: ${job.id ?? 'unknown'}`);
    }

    // The owner string is unique per process, BullMQ job, and execution. It is
    // stored with the fencing token and required by every terminal run update.
    await this.orchestrator.processRun(
      job.data.customerAiRunId,
      `${process.pid}:${job.id ?? 'job'}:${randomUUID()}`,
    );
  }
}

function hasRunId(
  data: CustomerAiJobData,
): data is { customerAiRunId: string } {
  return (
    'customerAiRunId' in data &&
    typeof data.customerAiRunId === 'string' &&
    data.customerAiRunId.length > 0
  );
}
