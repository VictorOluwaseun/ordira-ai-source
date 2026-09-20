import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { CustomerAiShadowVariantIdentity } from './customer-ai-shadow-promotion-gate.service';
import { CustomerAiEvaluationEvidence } from './schemas/customer-ai-evaluation-evidence.schema';

export type CustomerAiEvaluationEvidenceRecord = Omit<
  CustomerAiEvaluationEvidence,
  'createdAt' | 'updatedAt'
>;

/** Persistence boundary for the global, privacy-safe evaluation ledger. */
@Injectable()
export class CustomerAiEvaluationEvidenceRepository {
  constructor(
    @InjectModel(CustomerAiEvaluationEvidence.name)
    private readonly evidenceModel: Model<CustomerAiEvaluationEvidence>,
  ) {}

  async recordComparison(
    records: CustomerAiEvaluationEvidenceRecord[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    // $setOnInsert makes an evaluator retry idempotent. Including the evidence
    // hash in the filter is deliberate: changed content under a reused
    // comparison/variant ID reaches the unique index and fails instead of
    // replacing an immutable audit record.
    await this.evidenceModel.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: {
            comparisonId: record.comparisonId,
            variantId: record.variantId,
            evidenceSha256: record.evidenceSha256,
          },
          update: { $setOnInsert: record },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }

  async findLatestBehavioralVariants(
    variants: CustomerAiShadowVariantIdentity[],
  ): Promise<CustomerAiEvaluationEvidence[]> {
    const baseFilters = uniqueBaseFilters(variants);
    if (baseFilters.length === 0) {
      return [];
    }

    // Reduce all historical comparison runs to the newest row for each exact
    // behavioral identity. Keeping other contract identities in the result is
    // necessary so readiness can distinguish "missing" from "mismatched".
    return this.evidenceModel
      .aggregate<CustomerAiEvaluationEvidence>([
        { $match: { $or: baseFilters } },
        { $sort: { evaluatedAt: -1, createdAt: -1, _id: -1 } },
        {
          $group: {
            _id: {
              provider: '$provider',
              model: '$model',
              reasoningEffort: '$reasoningEffort',
              maxOutputTokens: '$maxOutputTokens',
              maxContextMessages: '$maxContextMessages',
              promptVersion: '$promptVersion',
              policyVersion: '$policyVersion',
              toolContractVersion: '$toolContractVersion',
              responseContractVersion: '$responseContractVersion',
            },
            evidence: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$evidence' } },
        { $sort: { evaluatedAt: -1, createdAt: -1, _id: -1 } },
      ])
      .exec();
  }
}

function uniqueBaseFilters(
  variants: CustomerAiShadowVariantIdentity[],
): Array<Record<string, unknown>> {
  const filters = new Map<string, Record<string, unknown>>();

  for (const variant of variants) {
    // Evidence requires a concrete model/reasoning pair. Fake or incomplete
    // shadow identities remain safely unmatched instead of broadening a query.
    if (!variant.model || !variant.reasoningEffort) {
      continue;
    }
    const key = [variant.provider, variant.model, variant.reasoningEffort].join(
      '\u0000',
    );
    filters.set(key, {
      provider: variant.provider,
      model: variant.model,
      reasoningEffort: variant.reasoningEffort,
    });
  }

  return [...filters.values()];
}
