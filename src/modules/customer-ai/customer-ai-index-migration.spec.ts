import type { Db, IndexDescriptionInfo } from 'mongodb';
import { reconcileCustomerAiIndexes } from './customer-ai-index-migration';

type MutableIndex = IndexDescriptionInfo & { name: string };

describe('reconcileCustomerAiIndexes', () => {
  it('creates the fenced index before dropping the legacy constraint and reconciles TTLs', async () => {
    const fake = createDatabase({
      customer_ai_tool_executions: [
        index('_id_', { _id: 1 }),
        index('runId_1_sequence_1', { runId: 1, sequence: 1 }, true),
        index('expiresAt_1', { expiresAt: 1 }, false, 300),
      ],
      customer_ai_runs: [
        index('_id_', { _id: 1 }),
        index('expiresAt_1', { expiresAt: 1 }, false, 60),
      ],
      customer_ai_sessions: [index('_id_', { _id: 1 })],
    });

    const first = await reconcileCustomerAiIndexes(fake.database);

    expect(fake.operations).toEqual([
      'create:customer_ai_tool_executions:runId_1_fencingToken_1_sequence_1',
      'drop:customer_ai_tool_executions:runId_1_sequence_1',
      'ttl:customer_ai_tool_executions:expiresAt_1:0',
      'ttl:customer_ai_runs:expiresAt_1:0',
      'create:customer_ai_sessions:expiresAt_1',
    ]);
    expect(first.actions).toEqual(
      expect.arrayContaining([
        {
          collection: 'customer_ai_tool_executions',
          action: 'create',
          index: 'runId_1_fencingToken_1_sequence_1',
        },
        {
          collection: 'customer_ai_tool_executions',
          action: 'drop',
          index: 'runId_1_sequence_1',
        },
      ]),
    );

    fake.operations.length = 0;
    const second = await reconcileCustomerAiIndexes(fake.database);

    expect(fake.operations).toEqual([]);
    expect(second.actions.every(({ action }) => action === 'verified')).toBe(
      true,
    );
  });

  it('reports a dry run without mutating deployed indexes', async () => {
    const fake = createDatabase({
      customer_ai_tool_executions: [
        index('_id_', { _id: 1 }),
        index('runId_1_sequence_1', { runId: 1, sequence: 1 }, true),
      ],
    });

    const report = await reconcileCustomerAiIndexes(fake.database, true);

    expect(fake.operations).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'create' }),
        expect.objectContaining({ action: 'drop' }),
      ]),
    );
  });
});

function index(
  name: string,
  key: Record<string, number>,
  unique = false,
  expireAfterSeconds?: number,
): MutableIndex {
  return {
    name,
    key,
    ...(unique ? { unique: true } : {}),
    ...(expireAfterSeconds === undefined ? {} : { expireAfterSeconds }),
  };
}

function createDatabase(initial: Record<string, MutableIndex[]>): {
  database: Db;
  operations: string[];
} {
  const indexes = new Map(
    Object.entries(initial).map(([name, values]) => [
      name,
      values.map((value) => ({ ...value, key: { ...value.key } })),
    ]),
  );
  const operations: string[] = [];
  const collection = (name: string) => ({
    collectionName: name,
    listIndexes: () => ({
      toArray: () => Promise.resolve([...(indexes.get(name) ?? [])]),
    }),
    createIndex: (
      keys: Record<string, number>,
      options: { unique?: boolean; expireAfterSeconds?: number },
    ) => {
      const indexName = Object.entries(keys)
        .map(([key, value]) => `${key}_${value}`)
        .join('_');
      indexes
        .get(name)
        ?.push(
          index(
            indexName,
            keys,
            options.unique ?? false,
            options.expireAfterSeconds,
          ),
        );
      operations.push(`create:${name}:${indexName}`);
      return Promise.resolve(indexName);
    },
    dropIndex: (indexName: string) => {
      indexes.set(
        name,
        (indexes.get(name) ?? []).filter(
          (candidate) => candidate.name !== indexName,
        ),
      );
      operations.push(`drop:${name}:${indexName}`);
      return Promise.resolve();
    },
  });
  const database = {
    listCollections: () => ({
      toArray: () =>
        Promise.resolve([...indexes.keys()].map((name) => ({ name }))),
    }),
    collection,
    command: (command: {
      collMod: string;
      index: { name: string; expireAfterSeconds: number };
    }) => {
      const target = (indexes.get(command.collMod) ?? []).find(
        (candidate) => candidate.name === command.index.name,
      );
      if (target) target.expireAfterSeconds = command.index.expireAfterSeconds;
      operations.push(
        `ttl:${command.collMod}:${command.index.name}:${command.index.expireAfterSeconds}`,
      );
      return Promise.resolve({ ok: 1 });
    },
  } as unknown as Db;

  return { database, operations };
}
