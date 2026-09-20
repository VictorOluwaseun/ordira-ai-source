import type { ConfigType } from '@nestjs/config';
import { Types } from 'mongoose';
import { customerAiConfig } from '@config/customer-ai.config';
import { CustomerAiShadowService } from './customer-ai-shadow.service';

describe('CustomerAiShadowService causal snapshot', () => {
  it('stores deterministic pre/post state separately and queues the post-state run', async () => {
    const { service, repository, queue } = createService({
      postInputVersion: 4,
      postStateVersion: 9,
    });

    await expect(service.observeInbound(observation())).resolves.toBe(true);

    expect(repository.createRunIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        causalInputVersion: 4,
        observedConversationVersion: 7,
        deterministicPostConversationVersion: 9,
        expectedConversationVersion: 9,
        maxContextMessages: 4,
      }),
    );
    expect(queue.enqueueProcessJob).toHaveBeenCalledTimes(1);
  });

  it('does not attach a newer customer input to the older inbound event', async () => {
    const { service, repository, queue } = createService({
      postInputVersion: 5,
      postStateVersion: 9,
    });

    await expect(service.observeInbound(observation())).resolves.toBe(false);

    expect(repository.createRunIfAbsent).not.toHaveBeenCalled();
    expect(queue.enqueueProcessJob).not.toHaveBeenCalled();
  });
});

function createService(input: {
  postInputVersion: number;
  postStateVersion: number;
}) {
  const repository = {
    findConversationVersions: jest.fn().mockResolvedValue({
      inputVersion: input.postInputVersion,
      stateVersion: input.postStateVersion,
    }),
    createRunIfAbsent: jest.fn().mockResolvedValue({
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    }),
  };
  const queue = {
    enqueueProcessJob: jest.fn().mockResolvedValue(true),
  };
  const service = new CustomerAiShadowService(
    { isShadowEligible: jest.fn().mockReturnValue(true) } as never,
    repository as never,
    queue as never,
    { increment: jest.fn() } as never,
    {
      mode: 'shadow',
      provider: 'fake',
      model: null,
      reasoningEffort: null,
      promptVersion: 'prompt-v1',
      policyVersion: 'policy-v2',
      toolContractVersion: 'tools-v1',
      responseContractVersion: 'response-v1',
      maxProviderCalls: 2,
      maxToolCalls: 4,
      maxOutputTokens: 300,
      maxContextMessages: 4,
      turnDeadlineMs: 15000,
    } as ConfigType<typeof customerAiConfig>,
  );

  return { service, repository, queue };
}

function observation() {
  return {
    inboundEventId: '507f1f77bcf86cd799439012',
    customerMessage: 'Find me a burger',
    deterministicInput: false,
    conversation: {
      id: '507f1f77bcf86cd799439013',
      inputVersion: 4,
      stateVersion: 7,
    },
  } as never;
}
