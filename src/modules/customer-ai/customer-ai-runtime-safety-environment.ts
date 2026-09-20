import { validateEnv } from '@config/env.schema';
import type { EnvConfig } from '@config/types/env.types';

/**
 * Resolves the isolated infrastructure used only to generate promotable
 * runtime-safety evidence. Credentials are ignored when endpoints are compared
 * because different accounts can still address the same database or counters.
 */
export function resolveCustomerAiRuntimeSafetyEnvironment(
  configured: EnvConfig,
  environment: NodeJS.ProcessEnv,
): EnvConfig {
  if (configured.NODE_ENV === 'production') {
    throw new Error(
      'Customer AI runtime safety evidence cannot run in production',
    );
  }
  const mongodbUri = environment.CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI?.trim();
  const redisUrl = environment.CUSTOMER_AI_RUNTIME_SAFETY_REDIS_URL?.trim();
  if (!mongodbUri || !redisUrl) {
    throw new Error(
      'Dedicated CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI and CUSTOMER_AI_RUNTIME_SAFETY_REDIS_URL are required',
    );
  }
  const dedicated = validateEnv({
    ...environment,
    NODE_ENV: configured.NODE_ENV,
    MONGODB_URI: mongodbUri,
    REDIS_URL: redisUrl,
  });
  if (
    infrastructureTarget(dedicated.MONGODB_URI, 'test') ===
      infrastructureTarget(configured.MONGODB_URI, 'test') ||
    infrastructureTarget(dedicated.REDIS_URL, '0') ===
      infrastructureTarget(configured.REDIS_URL, '0')
  ) {
    throw new Error(
      'Customer AI runtime safety evidence requires infrastructure distinct from application MongoDB and Redis',
    );
  }

  return dedicated;
}

export function assertCustomerAiRuntimeSafetyDatabaseName(
  databaseName: string,
): void {
  if (!/(?:^|[-_])(test|e2e|ci|runtime|safety)(?:[-_]|$)/i.test(databaseName)) {
    throw new Error(
      'Customer AI runtime safety MongoDB database name must be explicitly test/e2e/ci/runtime/safety scoped',
    );
  }
}

function infrastructureTarget(uri: string, defaultDatabase: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Customer AI runtime safety infrastructure URL is invalid');
  }
  const database = parsed.pathname.replace(/^\/+/, '') || defaultDatabase;

  return `${parsed.protocol}//${parsed.host.toLowerCase()}/${database}`;
}
