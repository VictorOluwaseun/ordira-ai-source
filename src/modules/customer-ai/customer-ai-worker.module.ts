import { Module } from '@nestjs/common';
import { CustomerAiModule } from './customer-ai.module';
import { CustomerAiProcessor } from './customer-ai.processor';

/** Adds queue consumption only to the worker process, not the HTTP API. */
@Module({
  imports: [CustomerAiModule],
  providers: [CustomerAiProcessor],
})
export class CustomerAiWorkerModule {}
