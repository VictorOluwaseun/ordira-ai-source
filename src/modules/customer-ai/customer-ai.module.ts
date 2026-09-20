import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import OpenAI from 'openai';
import { customerAiConfig } from '@config/customer-ai.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { StorefrontSearchModule } from '@modules/storefront-search/storefront-search.module';
import {
  WhatsappConversation,
  WhatsappConversationSchema,
} from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import {
  WhatsappInboundEvent,
  WhatsappInboundEventSchema,
} from '@modules/whatsapp-conversations/schemas/whatsapp-inbound-event.schema';
import { CustomerAiOrchestratorService } from './customer-ai-orchestrator.service';
import { CustomerAiEvaluationEvidenceRepository } from './customer-ai-evaluation-evidence.repository';
import { CustomerAiEvaluationEvidenceService } from './customer-ai-evaluation-evidence.service';
import { CustomerAiMetricsService } from './customer-ai-metrics.service';
import { CustomerAiPolicyEvidenceService } from './customer-ai-policy-evidence.service';
import { CustomerAiPolicyService } from './customer-ai-policy.service';
import { CustomerAiProviderHealthService } from './customer-ai-provider-health.service';
import { CustomerAiQueueService } from './customer-ai-queue.service';
import { CustomerAiReadToolsService } from './customer-ai-read-tools.service';
import { CustomerAiRepository } from './customer-ai.repository';
import { CustomerAiResponseCompilerService } from './customer-ai-response-compiler.service';
import { CustomerAiRoutingService } from './customer-ai-routing.service';
import { CustomerAiShadowService } from './customer-ai-shadow.service';
import { CustomerAiIntentService } from './customer-ai-intent.service';
import { CUSTOMER_AI_PROVIDER } from './customer-ai.types';
import { FakeCustomerAiProvider } from './providers/fake-customer-ai.provider';
import {
  OPENAI_CUSTOMER_AI_CLIENT,
  OpenAiCustomerAiProvider,
} from './providers/openai-customer-ai.provider';
import { CustomerAiSpendGuardService } from './customer-ai-spend-guard.service';
import {
  CustomerAiEvaluationEvidence,
  CustomerAiEvaluationEvidenceSchema,
} from './schemas/customer-ai-evaluation-evidence.schema';
import {
  CustomerAiRun,
  CustomerAiRunSchema,
} from './schemas/customer-ai-run.schema';
import {
  CustomerAiSession,
  CustomerAiSessionSchema,
} from './schemas/customer-ai-session.schema';
import {
  CustomerAiToolExecution,
  CustomerAiToolExecutionSchema,
} from './schemas/customer-ai-tool-execution.schema';

/**
 * Composition root for the customer-AI subsystem.
 *
 * The module deliberately exposes orchestration/observation services but not
 * provider clients. Calling code depends on the provider-neutral contract and
 * the configured provider is selected once during dependency injection.
 * The live intent service shares cost/health infrastructure with shadow work,
 * but returns validated action proposals for WhatsApp's domain handlers rather
 * than dispatching shadow-generated responses or exposing the OpenAI client.
 */
@Module({
  imports: [
    ConfigModule.forFeature(customerAiConfig),
    ConfigModule.forFeature(redisConfig),
    DatabaseModule,
    MongooseModule.forFeature([
      {
        name: CustomerAiEvaluationEvidence.name,
        schema: CustomerAiEvaluationEvidenceSchema,
      },
      { name: CustomerAiRun.name, schema: CustomerAiRunSchema },
      { name: CustomerAiSession.name, schema: CustomerAiSessionSchema },
      {
        name: CustomerAiToolExecution.name,
        schema: CustomerAiToolExecutionSchema,
      },
      { name: WhatsappInboundEvent.name, schema: WhatsappInboundEventSchema },
      { name: WhatsappConversation.name, schema: WhatsappConversationSchema },
    ]),
    StorefrontSearchModule,
  ],
  providers: [
    CustomerAiEvaluationEvidenceRepository,
    CustomerAiEvaluationEvidenceService,
    CustomerAiRepository,
    CustomerAiMetricsService,
    CustomerAiRoutingService,
    CustomerAiPolicyEvidenceService,
    CustomerAiPolicyService,
    CustomerAiProviderHealthService,
    CustomerAiResponseCompilerService,
    CustomerAiReadToolsService,
    CustomerAiQueueService,
    CustomerAiShadowService,
    CustomerAiIntentService,
    CustomerAiOrchestratorService,
    CustomerAiSpendGuardService,
    FakeCustomerAiProvider,
    OpenAiCustomerAiProvider,
    {
      provide: OPENAI_CUSTOMER_AI_CLIENT,
      inject: [customerAiConfig.KEY],
      useFactory: (config: ConfigType<typeof customerAiConfig>) =>
        config.openAiApiKey
          ? new OpenAI({
              apiKey: config.openAiApiKey,
              timeout: config.apiTimeoutMs,
              // Callers own retries and state reloads. In particular, the live
              // classifier reserves spend for one request per invocation;
              // hidden SDK retries could make additional unreserved paid calls.
              maxRetries: 0,
            })
          : null,
    },
    {
      provide: CUSTOMER_AI_PROVIDER,
      inject: [
        customerAiConfig.KEY,
        FakeCustomerAiProvider,
        OpenAiCustomerAiProvider,
      ],
      useFactory: (
        config: ConfigType<typeof customerAiConfig>,
        fakeProvider: FakeCustomerAiProvider,
        openAiProvider: OpenAiCustomerAiProvider,
      ) => (config.provider === 'openai' ? openAiProvider : fakeProvider),
    },
  ],
  exports: [
    CustomerAiIntentService,
    CustomerAiEvaluationEvidenceService,
    CustomerAiOrchestratorService,
    CustomerAiQueueService,
    CustomerAiRepository,
    CustomerAiShadowService,
  ],
})
export class CustomerAiModule {}
