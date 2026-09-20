import type { Db, IndexDescriptionInfo, IndexSpecification } from 'mongodb';

type CustomerAiIndexAction = {
  collection: string;
  action: 'create' | 'drop' | 'update_ttl' | 'verified' | 'skipped';
  index: string;
};

export type CustomerAiIndexMigrationReport = {
  dryRun: boolean;
  actions: CustomerAiIndexAction[];
};

const TOOL_EXECUTIONS = 'customer_ai_tool_executions';
const RUNS = 'customer_ai_runs';
const SESSIONS = 'customer_ai_sessions';
const FENCED_TOOL_INDEX = {
  runId: 1,
  fencingToken: 1,
  sequence: 1,
} as const;
const LEGACY_TOOL_INDEX = { runId: 1, sequence: 1 } as const;
const EXPIRY_INDEX = { expiresAt: 1 } as const;

/**
 * Reconciles deployed indexes that Mongoose schema declarations cannot safely
 * replace. The fenced tool index is created and verified before the obsolete
 * uniqueness constraint is dropped, so a failed migration never weakens the
 * existing idempotency boundary.
 */
export async function reconcileCustomerAiIndexes(
  database: Db,
  dryRun = false,
): Promise<CustomerAiIndexMigrationReport> {
  const actions: CustomerAiIndexAction[] = [];
  const existingCollections = new Set(
    (await database.listCollections({}, { nameOnly: true }).toArray()).map(
      ({ name }) => name,
    ),
  );

  if (existingCollections.has(TOOL_EXECUTIONS)) {
    const collection = database.collection(TOOL_EXECUTIONS);
    await ensureIndex(
      database,
      collection.collectionName,
      await readIndexes(database, collection.collectionName),
      FENCED_TOOL_INDEX,
      { unique: true },
      dryRun,
      actions,
    );
    await dropIndexesWithKeys(
      collection.collectionName,
      await readIndexes(database, collection.collectionName),
      LEGACY_TOOL_INDEX,
      dryRun,
      actions,
      (name) => collection.dropIndex(name),
    );
    await ensureTtlIndex(
      database,
      collection.collectionName,
      await readIndexes(database, collection.collectionName),
      dryRun,
      actions,
    );
  } else {
    actions.push({
      collection: TOOL_EXECUTIONS,
      action: 'skipped',
      index: 'collection_missing',
    });
  }

  for (const collectionName of [RUNS, SESSIONS]) {
    if (!existingCollections.has(collectionName)) {
      actions.push({
        collection: collectionName,
        action: 'skipped',
        index: 'collection_missing',
      });
      continue;
    }
    await ensureTtlIndex(
      database,
      collectionName,
      await readIndexes(database, collectionName),
      dryRun,
      actions,
    );
  }

  if (!dryRun) {
    await verifyReconciledIndexes(database, existingCollections);
  }

  return { dryRun, actions };
}

async function ensureIndex(
  database: Db,
  collectionName: string,
  indexes: IndexDescriptionInfo[],
  keys: Record<string, 1>,
  options: { unique: true },
  dryRun: boolean,
  actions: CustomerAiIndexAction[],
): Promise<void> {
  const existing = findIndexByKeys(indexes, keys);
  if (existing?.unique === true) {
    const existingName = requireIndexName(existing);
    actions.push({
      collection: collectionName,
      action: 'verified',
      index: existingName,
    });
    return;
  }
  if (existing) {
    const existingName = requireIndexName(existing);
    if (!dryRun) {
      await database.collection(collectionName).dropIndex(existingName);
    }
    actions.push({
      collection: collectionName,
      action: 'drop',
      index: existingName,
    });
  }
  if (!dryRun) {
    await database.collection(collectionName).createIndex(keys, options);
  }
  actions.push({
    collection: collectionName,
    action: 'create',
    index: keyName(keys),
  });
}

async function dropIndexesWithKeys(
  collectionName: string,
  indexes: IndexDescriptionInfo[],
  keys: Record<string, 1>,
  dryRun: boolean,
  actions: CustomerAiIndexAction[],
  drop: (name: string) => Promise<unknown>,
): Promise<void> {
  for (const index of indexes.filter((candidate) =>
    sameKeys(candidate.key, keys),
  )) {
    const indexName = requireIndexName(index);
    if (!dryRun) {
      await drop(indexName);
    }
    actions.push({
      collection: collectionName,
      action: 'drop',
      index: indexName,
    });
  }
}

async function ensureTtlIndex(
  database: Db,
  collectionName: string,
  indexes: IndexDescriptionInfo[],
  dryRun: boolean,
  actions: CustomerAiIndexAction[],
): Promise<void> {
  const existing = findIndexByKeys(indexes, EXPIRY_INDEX);
  if (!existing) {
    if (!dryRun) {
      await database
        .collection(collectionName)
        .createIndex(EXPIRY_INDEX, { expireAfterSeconds: 0 });
    }
    actions.push({
      collection: collectionName,
      action: 'create',
      index: keyName(EXPIRY_INDEX),
    });
    return;
  }
  if (Number(existing.expireAfterSeconds) === 0) {
    const existingName = requireIndexName(existing);
    actions.push({
      collection: collectionName,
      action: 'verified',
      index: existingName,
    });
    return;
  }
  const existingName = requireIndexName(existing);
  if (!dryRun) {
    await database.command({
      collMod: collectionName,
      index: { name: existingName, expireAfterSeconds: 0 },
    });
  }
  actions.push({
    collection: collectionName,
    action: 'update_ttl',
    index: existingName,
  });
}

async function verifyReconciledIndexes(
  database: Db,
  existingCollections: Set<string>,
): Promise<void> {
  if (existingCollections.has(TOOL_EXECUTIONS)) {
    const indexes = await readIndexes(database, TOOL_EXECUTIONS);
    const fenced = findIndexByKeys(indexes, FENCED_TOOL_INDEX);
    if (!fenced?.unique || findIndexByKeys(indexes, LEGACY_TOOL_INDEX)) {
      throw new Error('Customer AI fenced tool index reconciliation failed');
    }
  }
  for (const collectionName of [TOOL_EXECUTIONS, RUNS, SESSIONS]) {
    if (!existingCollections.has(collectionName)) continue;
    const expiry = findIndexByKeys(
      await readIndexes(database, collectionName),
      EXPIRY_INDEX,
    );
    if (!expiry || Number(expiry.expireAfterSeconds) !== 0) {
      throw new Error(
        `Customer AI TTL index reconciliation failed for ${collectionName}`,
      );
    }
  }
}

function findIndexByKeys(
  indexes: IndexDescriptionInfo[],
  keys: Record<string, 1>,
): IndexDescriptionInfo | undefined {
  return indexes.find((index) => sameKeys(index.key, keys));
}

function sameKeys(
  actual: IndexSpecification,
  expected: Record<string, 1>,
): boolean {
  const entries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);

  return (
    entries.length === expectedEntries.length &&
    entries.every(
      ([key, value], index) =>
        key === expectedEntries[index]?.[0] &&
        Number(value) === expectedEntries[index]?.[1],
    )
  );
}

function keyName(keys: Record<string, 1>): string {
  return Object.entries(keys)
    .map(([key, value]) => `${key}_${value}`)
    .join('_');
}

function requireIndexName(index: IndexDescriptionInfo): string {
  if (!index.name) {
    throw new Error('MongoDB returned an unnamed index during reconciliation');
  }
  return index.name;
}

async function readIndexes(
  database: Db,
  collectionName: string,
): Promise<IndexDescriptionInfo[]> {
  const indexes: unknown = await database
    .collection(collectionName)
    .listIndexes()
    .toArray();

  return indexes as IndexDescriptionInfo[];
}
