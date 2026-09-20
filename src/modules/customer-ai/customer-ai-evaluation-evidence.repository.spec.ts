import { CustomerAiEvaluationEvidenceRepository } from './customer-ai-evaluation-evidence.repository';

describe('CustomerAiEvaluationEvidenceRepository', () => {
  it('uses comparison identity plus content hash as immutable idempotency', async () => {
    const model = createModel();
    const repository = new CustomerAiEvaluationEvidenceRepository(
      model as never,
    );
    const record = {
      comparisonId: 'comparison-1',
      variantId: 'candidate-1',
      evidenceSha256: 'a'.repeat(64),
    };

    await repository.recordComparison([record as never]);

    expect(model.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: record,
            update: { $setOnInsert: record },
            upsert: true,
          },
        },
      ],
      { ordered: true },
    );
  });

  it('loads the newest row for each exact contract identity in one query', async () => {
    const model = createModel();
    const repository = new CustomerAiEvaluationEvidenceRepository(
      model as never,
    );

    await repository.findLatestBehavioralVariants([
      {
        provider: 'openai',
        model: 'quality-model',
        reasoningEffort: 'high',
        maxOutputTokens: 2048,
        maxContextMessages: 4,
        promptVersion: 'prompt-v1',
        policyVersion: 'policy-v1',
        toolContractVersion: 'tools-v1',
        responseContractVersion: 'response-v1',
      },
    ]);

    const pipeline = model.aggregate.mock.calls[0]?.[0];
    expect(pipeline?.[0]).toEqual({
      $match: {
        $or: [
          {
            provider: 'openai',
            model: 'quality-model',
            reasoningEffort: 'high',
          },
        ],
      },
    });
    expect(JSON.stringify(pipeline)).toContain('maxOutputTokens');
    expect(JSON.stringify(pipeline)).toContain('maxContextMessages');
    expect(JSON.stringify(pipeline)).toContain('responseContractVersion');
    expect(JSON.stringify(pipeline)).toContain('$$ROOT');
    expect(model.aggregate).toHaveBeenCalledTimes(1);
  });

  it('does not issue a broad evidence query for incomplete variants', async () => {
    const model = createModel();
    const repository = new CustomerAiEvaluationEvidenceRepository(
      model as never,
    );

    await expect(
      repository.findLatestBehavioralVariants([
        {
          provider: 'fake',
          model: null,
          reasoningEffort: null,
          maxOutputTokens: 2048,
          maxContextMessages: 4,
          promptVersion: 'prompt-v1',
          policyVersion: 'policy-v1',
          toolContractVersion: 'tools-v1',
          responseContractVersion: 'response-v1',
        },
      ]),
    ).resolves.toEqual([]);
    expect(model.aggregate).not.toHaveBeenCalled();
  });
});

function createModel() {
  const aggregate = jest.fn<
    { exec: jest.Mock<Promise<unknown[]>, []> },
    [Array<Record<string, unknown>>]
  >();
  aggregate.mockReturnValue({
    exec: jest.fn<Promise<unknown[]>, []>().mockResolvedValue([]),
  });

  return {
    bulkWrite: jest.fn().mockResolvedValue({}),
    aggregate,
  };
}
