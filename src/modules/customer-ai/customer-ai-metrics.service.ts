import { Injectable } from '@nestjs/common';

export type CustomerAiMetricName =
  | 'shadow_runs_queued'
  | 'shadow_runs_completed'
  | 'shadow_runs_failed'
  | 'provider_failures'
  | 'provider_rate_limits'
  | 'provider_refusals'
  | 'provider_schema_failures'
  | 'spend_limit_denials'
  | 'tool_failures'
  | 'stale_responses_suppressed';

/**
 * Lightweight process-local counters for the shadow foundation.
 *
 * These counters are intentionally simple and reset on process restart. They
 * provide immediate instrumentation now and define stable metric names that a
 * durable metrics backend can implement later without changing callers.
 */
@Injectable()
export class CustomerAiMetricsService {
  private readonly counters = new Map<CustomerAiMetricName, number>();

  increment(name: CustomerAiMetricName): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<CustomerAiMetricName, number>> {
    return {
      shadow_runs_queued: this.counters.get('shadow_runs_queued') ?? 0,
      shadow_runs_completed: this.counters.get('shadow_runs_completed') ?? 0,
      shadow_runs_failed: this.counters.get('shadow_runs_failed') ?? 0,
      provider_failures: this.counters.get('provider_failures') ?? 0,
      provider_rate_limits: this.counters.get('provider_rate_limits') ?? 0,
      provider_refusals: this.counters.get('provider_refusals') ?? 0,
      provider_schema_failures:
        this.counters.get('provider_schema_failures') ?? 0,
      spend_limit_denials: this.counters.get('spend_limit_denials') ?? 0,
      tool_failures: this.counters.get('tool_failures') ?? 0,
      stale_responses_suppressed:
        this.counters.get('stale_responses_suppressed') ?? 0,
    };
  }
}
