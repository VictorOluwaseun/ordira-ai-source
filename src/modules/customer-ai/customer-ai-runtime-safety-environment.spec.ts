import { validateEnv } from '@config/env.schema';
import {
  assertCustomerAiRuntimeSafetyDatabaseName,
  resolveCustomerAiRuntimeSafetyEnvironment,
} from './customer-ai-runtime-safety-environment';

const APPLICATION_ENV = {
  MONGODB_URI: 'mongodb://app-user:app-pass@localhost:27017/ordira',
  REDIS_URL: 'redis://app-user:app-pass@localhost:6379',
  JWT_SECRET: 'runtime-safety-environment-test-secret',
};

describe('customer AI runtime safety environment', () => {
  it('accepts only dedicated evidence targets', () => {
    const configured = validateEnv(APPLICATION_ENV);

    expect(
      resolveCustomerAiRuntimeSafetyEnvironment(configured, {
        ...APPLICATION_ENV,
        CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI:
          'mongodb://localhost:27017/ordira-runtime-safety',
        CUSTOMER_AI_RUNTIME_SAFETY_REDIS_URL: 'redis://localhost:6379/15',
      }),
    ).toEqual(
      expect.objectContaining({
        MONGODB_URI: 'mongodb://localhost:27017/ordira-runtime-safety',
        REDIS_URL: 'redis://localhost:6379/15',
      }),
    );
  });

  it('rejects the application Redis database despite URL spelling or credentials', () => {
    const configured = validateEnv(APPLICATION_ENV);

    expect(() =>
      resolveCustomerAiRuntimeSafetyEnvironment(configured, {
        ...APPLICATION_ENV,
        CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI:
          'mongodb://localhost:27017/ordira-runtime-safety',
        CUSTOMER_AI_RUNTIME_SAFETY_REDIS_URL:
          'redis://different:credentials@localhost:6379/0',
      }),
    ).toThrow('requires infrastructure distinct');
  });

  it('rejects the application Mongo database despite different credentials', () => {
    const configured = validateEnv(APPLICATION_ENV);

    expect(() =>
      resolveCustomerAiRuntimeSafetyEnvironment(configured, {
        ...APPLICATION_ENV,
        CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI:
          'mongodb://different:credentials@localhost:27017/ordira',
        CUSTOMER_AI_RUNTIME_SAFETY_REDIS_URL: 'redis://localhost:6379/15',
      }),
    ).toThrow('requires infrastructure distinct');
  });

  it('refuses evidence generation in production or without dedicated URLs', () => {
    const configured = validateEnv(APPLICATION_ENV);

    expect(() =>
      resolveCustomerAiRuntimeSafetyEnvironment(
        { ...configured, NODE_ENV: 'production' },
        APPLICATION_ENV,
      ),
    ).toThrow('cannot run in production');
    expect(() =>
      resolveCustomerAiRuntimeSafetyEnvironment(configured, APPLICATION_ENV),
    ).toThrow('Dedicated CUSTOMER_AI_RUNTIME_SAFETY_MONGODB_URI');
  });

  it('requires an explicitly safety-scoped Mongo database name', () => {
    expect(() =>
      assertCustomerAiRuntimeSafetyDatabaseName('ordira-staging'),
    ).toThrow('must be explicitly test/e2e/ci/runtime/safety scoped');
    expect(() =>
      assertCustomerAiRuntimeSafetyDatabaseName('ordira-runtime-safety'),
    ).not.toThrow();
  });
});
