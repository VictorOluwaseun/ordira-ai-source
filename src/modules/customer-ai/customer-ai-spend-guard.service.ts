import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { RedisService } from '@database/redis.service';

/**
 * Atomically reserves against the daily counter, monthly counter, and a unique
 * reservation record. All keys share a Redis hash tag so the script also works
 * when Redis Cluster is introduced.
 *
 * Return codes: 1 = created, 2 = already reserved (idempotent), -1/-2 = limit.
 */
const RESERVE_SCRIPT = `
  local existing = redis.call("GET", KEYS[3])
  if existing then
    return 2
  end

  local daily = tonumber(redis.call("GET", KEYS[1]) or "0")
  local monthly = tonumber(redis.call("GET", KEYS[2]) or "0")
  local amount = tonumber(ARGV[1])
  local daily_limit = tonumber(ARGV[2])
  local monthly_limit = tonumber(ARGV[3])

  if daily + amount > daily_limit then
    return -1
  end
  if monthly + amount > monthly_limit then
    return -2
  end

  redis.call("INCRBY", KEYS[1], amount)
  redis.call("EXPIRE", KEYS[1], ARGV[4])
  redis.call("INCRBY", KEYS[2], amount)
  redis.call("EXPIRE", KEYS[2], ARGV[5])
  redis.call("SET", KEYS[3], amount, "EX", ARGV[6])
  return 1
`;

/**
 * Reconciles conservative reserved cost with actual provider usage, then
 * deletes the reservation so settlement cannot be applied twice.
 */
const SETTLE_SCRIPT = `
  local reserved = redis.call("GET", KEYS[3])
  if not reserved then
    return 0
  end

  local delta = tonumber(reserved) - tonumber(ARGV[1])
  if delta > 0 then
    redis.call("DECRBY", KEYS[1], delta)
    redis.call("DECRBY", KEYS[2], delta)
  elseif delta < 0 then
    redis.call("INCRBY", KEYS[1], -delta)
    redis.call("INCRBY", KEYS[2], -delta)
  end
  redis.call("DEL", KEYS[3])
  return 1
`;

export type CustomerAiSpendReservation = {
  reservationId: string;
  reservedMinorUnit: number;
  dailyKey: string;
  monthlyKey: string;
  reservationKey: string;
};

/**
 * Global fail-closed spend control for paid AI calls.
 *
 * Budget is reserved before the network request, preventing concurrent workers
 * from each observing spare budget and collectively exceeding the limit. The
 * reservation is later reconciled to actual token cost. Redis errors deny the
 * provider call rather than allowing unmetered spend.
 */
@Injectable()
export class CustomerAiSpendGuardService {
  constructor(
    private readonly redisService: RedisService,
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
  ) {}

  async reserve(input: {
    reservationId: string;
    amountMinorUnit: number;
    now?: Date;
  }): Promise<CustomerAiSpendReservation> {
    assertMinorUnit(input.amountMinorUnit);
    const now = input.now ?? new Date();
    const reservationHash = createHash('sha256')
      .update(input.reservationId)
      .digest('hex');
    // UTC periods make all workers agree on rollover regardless of host locale.
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const slot = this.getSpendKeySlot();
    const reservation: CustomerAiSpendReservation = {
      reservationId: input.reservationId,
      reservedMinorUnit: input.amountMinorUnit,
      dailyKey: `ordira:${slot}:daily:${day}`,
      monthlyKey: `ordira:${slot}:monthly:${month}`,
      reservationKey: `ordira:${slot}:reservation:${reservationHash}`,
    };
    let rawResult: unknown;
    try {
      // Daily/monthly counters outlive their period slightly to aid operational
      // inspection; Redis expiry is cleanup, not the definition of the period.
      rawResult = await this.redisService.evaluateScript(
        RESERVE_SCRIPT,
        [
          reservation.dailyKey,
          reservation.monthlyKey,
          reservation.reservationKey,
        ],
        [
          String(input.amountMinorUnit),
          String(this.config.dailySpendLimitMinorUnit),
          String(this.config.monthlySpendLimitMinorUnit),
          String(3 * 24 * 60 * 60),
          String(40 * 24 * 60 * 60),
          String(this.config.spendReservationTtlSeconds),
        ],
      );
    } catch {
      throw new Error('CUSTOMER_AI_SPEND_GUARD_UNAVAILABLE');
    }
    const result = Number(rawResult);
    if (result === -1 || result === -2) {
      throw new Error('CUSTOMER_AI_SPEND_LIMIT');
    }
    if (result !== 1 && result !== 2) {
      throw new Error('CUSTOMER_AI_SPEND_GUARD_UNAVAILABLE');
    }

    return reservation;
  }

  async settle(
    reservation: CustomerAiSpendReservation,
    actualMinorUnit: number,
  ): Promise<void> {
    assertMinorUnit(actualMinorUnit, true);
    let rawResult: unknown;
    try {
      rawResult = await this.redisService.evaluateScript(
        SETTLE_SCRIPT,
        [
          reservation.dailyKey,
          reservation.monthlyKey,
          reservation.reservationKey,
        ],
        [String(actualMinorUnit)],
      );
    } catch {
      throw new Error('CUSTOMER_AI_SPEND_GUARD_UNAVAILABLE');
    }
    const result = Number(rawResult);
    // A missing reservation means it expired or was already settled. Continuing
    // would make accounting ambiguous, so the caller fails closed.
    if (result !== 1) {
      throw new Error('CUSTOMER_AI_SPEND_RESERVATION_STALE');
    }
  }

  /**
   * Keeps every production worker in one Redis Cluster hash slot. Integration
   * evidence overrides only this seam so safety checks cannot consume or
   * inherit the application's real daily and monthly counters.
   */
  protected getSpendKeySlot(): string {
    return this.config.spendKeyNamespace
      ? `{customer-ai-spend:${this.config.spendKeyNamespace}}`
      : '{customer-ai-spend}';
  }
}

function assertMinorUnit(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error('CUSTOMER_AI_SPEND_AMOUNT_INVALID');
  }
}
