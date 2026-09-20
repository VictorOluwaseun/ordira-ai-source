import type { CustomerAiProviderRequest } from '../customer-ai.types';
import {
  buildOpenAiRequest,
  estimateRequestReservationMinorUnit,
} from '../providers/openai-customer-ai.provider';

/**
 * Command-local ceiling layered above the global Redis spend guard.
 *
 * Each admission permanently consumes the same conservative reservation used
 * by the OpenAI adapter. We intentionally do not refund the estimate to actual
 * cost: this guarantees a concurrent evaluation cannot exceed the operator's
 * declared command budget, even while several calls are in flight.
 */
export class CustomerAiEvalBudget {
  private admittedMinorUnit = 0;

  constructor(
    private readonly maximumMinorUnit: number,
    private readonly inputCostPerMillionMinorUnit: number,
    private readonly outputCostPerMillionMinorUnit: number,
  ) {
    for (const value of [
      maximumMinorUnit,
      inputCostPerMillionMinorUnit,
      outputCostPerMillionMinorUnit,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
          'Customer AI evaluation budget configuration is invalid',
        );
      }
    }
  }

  admit(request: CustomerAiProviderRequest): void {
    if (!request.model || !request.reasoningEffort) {
      throw new Error('Customer AI evaluation variant identity is incomplete');
    }
    const body = buildOpenAiRequest(
      request,
      request.model,
      request.reasoningEffort,
    );
    const reservation = estimateRequestReservationMinorUnit(
      body,
      request.maxOutputTokens,
      this.inputCostPerMillionMinorUnit,
      this.outputCostPerMillionMinorUnit,
    );
    if (this.admittedMinorUnit + reservation > this.maximumMinorUnit) {
      throw new Error('CUSTOMER_AI_EVAL_MAX_COST');
    }
    this.admittedMinorUnit += reservation;
  }

  snapshot(): { maximumMinorUnit: number; admittedMinorUnit: number } {
    return {
      maximumMinorUnit: this.maximumMinorUnit,
      admittedMinorUnit: this.admittedMinorUnit,
    };
  }
}
