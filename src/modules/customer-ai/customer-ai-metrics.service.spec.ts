import { CustomerAiMetricsService } from './customer-ai-metrics.service';

describe('CustomerAiMetricsService', () => {
  it('exposes counters without messages, arguments, or provider output', () => {
    const metrics = new CustomerAiMetricsService();
    metrics.increment('shadow_runs_queued');
    metrics.increment('stale_responses_suppressed');

    expect(metrics.snapshot()).toEqual({
      shadow_runs_queued: 1,
      shadow_runs_completed: 0,
      shadow_runs_failed: 0,
      provider_failures: 0,
      provider_rate_limits: 0,
      provider_refusals: 0,
      provider_schema_failures: 0,
      spend_limit_denials: 0,
      tool_failures: 0,
      stale_responses_suppressed: 1,
    });
  });
});
