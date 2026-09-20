import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import type { RedisService } from '@database/redis.service';
import { CustomerAiSpendGuardService } from './customer-ai-spend-guard.service';

describe('CustomerAiSpendGuardService', () => {
  const config = {
    dailySpendLimitMinorUnit: 500,
    monthlySpendLimitMinorUnit: 5000,
    spendReservationTtlSeconds: 120,
    spendKeyNamespace: null,
  } as ConfigType<typeof customerAiConfig>;
  let evaluateScript: jest.Mock;
  let service: CustomerAiSpendGuardService;

  beforeEach(() => {
    evaluateScript = jest.fn().mockResolvedValue(1);
    service = new CustomerAiSpendGuardService(
      { evaluateScript } as unknown as RedisService,
      config,
    );
  });

  it('atomically reserves both daily and monthly budget buckets', async () => {
    const reservation = await service.reserve({
      reservationId: 'run-1:7:1',
      amountMinorUnit: 12,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(reservation.reservedMinorUnit).toBe(12);
    expect(reservation.dailyKey).toContain(':daily:');
    expect(reservation.dailyKey.endsWith(':2026-09-01')).toBe(true);
    expect(reservation.monthlyKey.endsWith(':2026-09')).toBe(true);
    expect(evaluateScript).toHaveBeenCalledWith(
      expect.stringContaining('daily + amount > daily_limit'),
      [
        reservation.dailyKey,
        reservation.monthlyKey,
        reservation.reservationKey,
      ],
      ['12', '500', '5000', '259200', '3456000', '120'],
    );
  });

  it.each([-1, -2])(
    'fails closed when a spend bucket rejects (%s)',
    async (code) => {
      evaluateScript.mockResolvedValueOnce(code);

      await expect(
        service.reserve({
          reservationId: 'run-1:7:1',
          amountMinorUnit: 12,
        }),
      ).rejects.toThrow('CUSTOMER_AI_SPEND_LIMIT');
    },
  );

  it('isolates counters when a dedicated namespace is configured', async () => {
    service = new CustomerAiSpendGuardService(
      { evaluateScript } as unknown as RedisService,
      { ...config, spendKeyNamespace: 'runtime-evidence-123' },
    );

    const reservation = await service.reserve({
      reservationId: 'run-1:7:1',
      amountMinorUnit: 12,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(reservation.dailyKey).toContain(
      ':{customer-ai-spend:runtime-evidence-123}:daily:',
    );
  });

  it('sanitizes Redis failures and fails closed', async () => {
    evaluateScript.mockRejectedValueOnce(new Error('redis host secret'));

    await expect(
      service.reserve({
        reservationId: 'run-1:7:1',
        amountMinorUnit: 12,
      }),
    ).rejects.toThrow('CUSTOMER_AI_SPEND_GUARD_UNAVAILABLE');
  });

  it('settles actual cost against the exact reservation keys', async () => {
    const reservation = await service.reserve({
      reservationId: 'run-1:7:1',
      amountMinorUnit: 12,
    });
    evaluateScript.mockClear();

    await service.settle(reservation, 8);

    expect(evaluateScript).toHaveBeenCalledWith(
      expect.stringContaining('DECRBY'),
      [
        reservation.dailyKey,
        reservation.monthlyKey,
        reservation.reservationKey,
      ],
      ['8'],
    );
  });

  it('rejects a missing or expired reservation during settlement', async () => {
    const reservation = await service.reserve({
      reservationId: 'run-1:7:1',
      amountMinorUnit: 12,
    });
    evaluateScript.mockResolvedValueOnce(0);

    await expect(service.settle(reservation, 8)).rejects.toThrow(
      'CUSTOMER_AI_SPEND_RESERVATION_STALE',
    );
  });
});
