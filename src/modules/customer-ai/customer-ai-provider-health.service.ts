import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { RedisService } from '@database/redis.service';

export type CustomerAiProviderHealthState =
  | 'healthy'
  | 'degraded'
  | 'open'
  | 'half_open';

/**
 * Identifies the breaker generation that admitted one provider request.
 * Results from an older generation are ignored, so a late probe cannot close
 * or poison a breaker that has already reopened or recovered.
 */
export type CustomerAiProviderCallPermit = {
  key: string;
  requestId: string;
  generation: number;
  halfOpenProbe: boolean;
};

const ADMIT_SCRIPT = `
  local state = redis.call("HGET", KEYS[1], "state") or "healthy"
  local generation = tonumber(redis.call("HGET", KEYS[1], "generation") or "0")
  local now = tonumber(ARGV[1])
  local open_ms = tonumber(ARGV[2])
  local max_probes = tonumber(ARGV[3])
  local ttl_seconds = tonumber(ARGV[4])

  if state == "open" then
    local opened_at = tonumber(redis.call("HGET", KEYS[1], "opened_at") or "0")
    if now - opened_at < open_ms then
      return {0, generation, 0}
    end
    redis.call("HSET", KEYS[1],
      "state", "half_open",
      "half_open_admitted", 1,
      "half_open_succeeded", 0)
    redis.call("EXPIRE", KEYS[1], ttl_seconds)
    return {1, generation, 1}
  end

  if state == "half_open" then
    local admitted = tonumber(redis.call("HGET", KEYS[1], "half_open_admitted") or "0")
    if admitted >= max_probes then
      return {0, generation, 0}
    end
    redis.call("HINCRBY", KEYS[1], "half_open_admitted", 1)
    redis.call("EXPIRE", KEYS[1], ttl_seconds)
    return {1, generation, 1}
  end

  redis.call("HSETNX", KEYS[1], "state", "healthy")
  redis.call("HSETNX", KEYS[1], "generation", generation)
  redis.call("EXPIRE", KEYS[1], ttl_seconds)
  return {1, generation, 0}
`;

const RECORD_NORMAL_SCRIPT = `
  local generation = tonumber(redis.call("HGET", KEYS[1], "generation") or "0")
  if generation ~= tonumber(ARGV[1]) then
    return -1
  end
  local state = redis.call("HGET", KEYS[1], "state") or "healthy"
  if state == "open" or state == "half_open" then
    return -1
  end

  local now = tonumber(ARGV[2])
  local cutoff = now - tonumber(ARGV[3])
  local outcome = ARGV[4]
  local member = ARGV[5]
  local minimum = tonumber(ARGV[6])
  local threshold = tonumber(ARGV[7])
  local ttl_seconds = tonumber(ARGV[8])

  redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", cutoff)
  redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", cutoff)
  redis.call("ZADD", KEYS[2], now, member)
  if outcome == "failure" then
    redis.call("ZADD", KEYS[3], now, member)
  end

  local requests = tonumber(redis.call("ZCARD", KEYS[2]))
  local failures = tonumber(redis.call("ZCARD", KEYS[3]))
  local next_state = failures > 0 and "degraded" or "healthy"
  if requests >= minimum and failures * 100 >= requests * threshold then
    generation = generation + 1
    next_state = "open"
    redis.call("HSET", KEYS[1],
      "generation", generation,
      "opened_at", now,
      "half_open_admitted", 0,
      "half_open_succeeded", 0)
  end
  redis.call("HSET", KEYS[1], "state", next_state)
  redis.call("EXPIRE", KEYS[1], ttl_seconds)
  redis.call("EXPIRE", KEYS[2], ttl_seconds)
  redis.call("EXPIRE", KEYS[3], ttl_seconds)
  return generation
`;

const RECORD_PROBE_SCRIPT = `
  local generation = tonumber(redis.call("HGET", KEYS[1], "generation") or "0")
  local state = redis.call("HGET", KEYS[1], "state") or "healthy"
  if generation ~= tonumber(ARGV[1]) or state ~= "half_open" then
    return -1
  end

  local outcome = ARGV[2]
  local now = tonumber(ARGV[3])
  local required_successes = tonumber(ARGV[4])
  local ttl_seconds = tonumber(ARGV[5])
  if outcome == "failure" then
    generation = generation + 1
    redis.call("HSET", KEYS[1],
      "state", "open",
      "generation", generation,
      "opened_at", now,
      "half_open_admitted", 0,
      "half_open_succeeded", 0)
    redis.call("EXPIRE", KEYS[1], ttl_seconds)
    return generation
  end

  local succeeded = tonumber(redis.call("HINCRBY", KEYS[1], "half_open_succeeded", 1))
  if succeeded >= required_successes then
    generation = generation + 1
    redis.call("HSET", KEYS[1],
      "state", "healthy",
      "generation", generation,
      "opened_at", 0,
      "half_open_admitted", 0,
      "half_open_succeeded", 0)
    redis.call("DEL", KEYS[2], KEYS[3])
  end
  redis.call("EXPIRE", KEYS[1], ttl_seconds)
  return generation
`;

const READ_STATE_SCRIPT = `
  return redis.call("HGET", KEYS[1], "state") or "healthy"
`;

/**
 * Distributed rolling-window circuit breaker keyed by provider and model.
 *
 * Redis is the single state owner, so every API/worker process sees the same
 * health decision. Half-open probes belong to a monotonically increasing
 * generation and the breaker closes only after every configured probe from the
 * current generation succeeds. Late outcomes from an obsolete generation are
 * ignored atomically by Lua.
 */
@Injectable()
export class CustomerAiProviderHealthService {
  constructor(
    private readonly redisService: RedisService,
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
  ) {}

  async acquirePermit(
    key: string,
    now = Date.now(),
  ): Promise<CustomerAiProviderCallPermit | null> {
    const keys = breakerKeys(key);
    let raw: unknown;
    try {
      raw = await this.redisService.evaluateScript(
        ADMIT_SCRIPT,
        [keys.state],
        [
          String(now),
          String(this.config.breakerOpenMs),
          String(this.config.breakerHalfOpenProbes),
          String(this.keyTtlSeconds()),
        ],
      );
    } catch {
      throw new Error('CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE');
    }
    const response = numericTuple(raw);
    if (response[0] !== 1) {
      return null;
    }

    return {
      key,
      requestId: randomUUID(),
      generation: response[1],
      halfOpenProbe: response[2] === 1,
    };
  }

  async recordSuccess(
    permit: CustomerAiProviderCallPermit,
    now = Date.now(),
  ): Promise<void> {
    await this.recordOutcome(permit, 'success', now);
  }

  async recordFailure(
    permit: CustomerAiProviderCallPermit,
    now = Date.now(),
  ): Promise<void> {
    await this.recordOutcome(permit, 'failure', now);
  }

  async getState(key: string): Promise<CustomerAiProviderHealthState> {
    try {
      const raw = await this.redisService.evaluateScript(
        READ_STATE_SCRIPT,
        [breakerKeys(key).state],
        [],
      );
      return isHealthState(raw) ? raw : 'healthy';
    } catch {
      throw new Error('CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE');
    }
  }

  private async recordOutcome(
    permit: CustomerAiProviderCallPermit,
    outcome: 'success' | 'failure',
    now: number,
  ): Promise<void> {
    const keys = breakerKeys(permit.key);
    try {
      if (permit.halfOpenProbe) {
        await this.redisService.evaluateScript(
          RECORD_PROBE_SCRIPT,
          [keys.state, keys.requests, keys.failures],
          [
            String(permit.generation),
            outcome,
            String(now),
            String(this.config.breakerHalfOpenProbes),
            String(this.keyTtlSeconds()),
          ],
        );
        return;
      }

      await this.redisService.evaluateScript(
        RECORD_NORMAL_SCRIPT,
        [keys.state, keys.requests, keys.failures],
        [
          String(permit.generation),
          String(now),
          String(this.config.breakerWindowMs),
          outcome,
          permit.requestId,
          String(this.config.breakerMinRequests),
          String(this.config.breakerFailurePercent),
          String(this.keyTtlSeconds()),
        ],
      );
    } catch {
      throw new Error('CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE');
    }
  }

  private keyTtlSeconds(): number {
    return Math.max(
      60,
      Math.ceil(
        (this.config.breakerWindowMs + this.config.breakerOpenMs * 2) / 1000,
      ),
    );
  }
}

function breakerKeys(key: string): {
  state: string;
  requests: string;
  failures: string;
} {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const slot = `{customer-ai-breaker:${digest}}`;
  return {
    state: `ordira:${slot}:state`,
    requests: `ordira:${slot}:requests`,
    failures: `ordira:${slot}:failures`,
  };
}

function numericTuple(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE');
  }
  const tuple = value.slice(0, 3).map(Number);
  if (tuple.some((item) => !Number.isSafeInteger(item))) {
    throw new Error('CUSTOMER_AI_PROVIDER_HEALTH_UNAVAILABLE');
  }

  return tuple as [number, number, number];
}

function isHealthState(value: unknown): value is CustomerAiProviderHealthState {
  return ['healthy', 'degraded', 'open', 'half_open'].includes(String(value));
}
