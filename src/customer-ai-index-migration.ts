import { createConnection } from 'mongoose';
import { validateEnv } from '@config/env.schema';
import { reconcileCustomerAiIndexes } from '@modules/customer-ai/customer-ai-index-migration';

async function main(): Promise<void> {
  const arguments_ = new Set(process.argv.slice(2));
  if (arguments_.has('--help')) {
    process.stdout.write(
      'Usage: npm run migrate:customer-ai-indexes -- [--dry-run]\n',
    );
    return;
  }
  const unknown = [...arguments_].find((value) => value !== '--dry-run');
  if (unknown) {
    throw new Error(`Unknown customer AI index migration option: ${unknown}`);
  }

  const environment = validateEnv(process.env);
  const connection = await createConnection(environment.MONGODB_URI, {
    serverSelectionTimeoutMS: environment.DATABASE_SERVER_SELECTION_TIMEOUT_MS,
  }).asPromise();
  try {
    if (!connection.db) {
      throw new Error('MongoDB connection did not expose a database handle');
    }
    const report = await reconcileCustomerAiIndexes(
      connection.db,
      arguments_.has('--dry-run'),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown index migration failure';
  process.stderr.write(`Customer AI index migration failed: ${message}\n`);
  process.exitCode = 1;
});
