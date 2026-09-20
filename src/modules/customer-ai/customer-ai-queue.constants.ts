export const CUSTOMER_AI_QUEUE_NAME = 'customer-ai-turn';
export const CUSTOMER_AI_PROCESS_JOB = 'process-customer-ai-run';
export const CUSTOMER_AI_SWEEP_JOB = 'sweep-customer-ai-runs';

export type CustomerAiProcessJobData = {
  customerAiRunId: string;
};

export type CustomerAiSweepJobData = Record<string, never>;
export type CustomerAiJobData =
  | CustomerAiProcessJobData
  | CustomerAiSweepJobData;

export const CUSTOMER_AI_SWEEP_JOB_ID = 'customer-ai-sweep';

/**
 * BullMQ job IDs provide queue-level deduplication. Recovery jobs include a
 * time-bucket discriminator so a stale run can be retried in a later sweep,
 * while duplicate enqueue attempts within the same sweep collapse to one job.
 */
export function customerAiProcessJobId(
  runId: string,
  discriminator = 'initial',
): string {
  return `customer-ai-run-${runId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${discriminator}`;
}
