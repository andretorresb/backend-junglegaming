import { EntitySchema } from '@mikro-orm/core';

/**
 * Registros de persistência. Separados do domínio: não têm comportamento.
 * Valores monetários são `string` (numeric do PostgreSQL, sem perda de precisão).
 * O espelho do schema real são as migrations em `./migrations`; estas definições
 * apenas mapeiam colunas para o ORM.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
  balanceObserved!: string | null;
}

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

const money = (column: string) => ({
  type: 'decimal' as const,
  columnType: 'numeric(19,2)',
  precision: 19,
  scale: 2,
  fieldName: column,
});

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: money('balance'),
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: money('amount'),
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
    balanceObserved: { type: 'decimal', fieldName: 'balance_observed', columnType: 'numeric(19,2)', precision: 19, scale: 2, nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: money('amount'),
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: money('balance_before'),
    balanceAfter: money('balance_after'),
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    receivedAt: { type: 'Date', fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
  },
});

export const PERSISTENCE_ENTITIES = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
