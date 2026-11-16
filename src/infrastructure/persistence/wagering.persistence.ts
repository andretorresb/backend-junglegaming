import { EntityManager, LockMode } from '@mikro-orm/core';
import type { WagerRepositories, WagerUnitOfWork } from '../../application/wagering/ports';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/outbox/outbox-message';
import { outboxToRecord } from './mappers';
import {
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../application/wagering/errors';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { InboxMessage } from '../../domain/inbox/inbox-message';
import {
  ledgerEntryToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from './entities/records';

/** Tempo máximo de espera por lock de wallet. Acima disso a requisição falha como transitória. */
export const WALLET_LOCK_TIMEOUT_MS = 2000;

/** SQLSTATE de erros transitórios: lock_timeout, deadlock, falha de serialização. */
const TRANSIENT_SQLSTATES = new Set(['55P03', '40P01', '40001']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export class MikroOrmWagerRepositories implements WagerRepositories {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletFromRecord(record) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletToRecord(wallet));
  }

  async saveWallet(wallet: Wallet, previousVersion: number): Promise<void> {
    const data = walletToRecord(wallet);
    // Guarda de versão: com o lock, a versão nunca diverge. Se diverge, há um bug e a operação falha.
    const updated = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: previousVersion },
      { balance: data.balance, version: data.version, updatedAt: data.updatedAt },
    );
    if (updated !== 1) {
      throw new Error(`wallet ${wallet.id} alterada concorrentemente sob lock (versão esperada ${previousVersion})`);
    }
  }

  async findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key });
    return record ? wagerTransactionFromRecord(record) : undefined;
  }

  async findTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? wagerTransactionFromRecord(record) : undefined;
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return record ? wagerTransactionFromRecord(record) : undefined;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, wagerTransactionToRecord(tx));
  }

  /**
   * ON CONFLICT DO NOTHING: uma duplicata não lança erro, então a transação continua utilizável.
   * (Um erro de unicidade dentro da transação a abortaria no PostgreSQL.)
   */
  async insertInbox(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.getConnection().execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
      'all',
      this.em.getTransactionContext(),
    );
    return rows.length === 1;
  }

  async markInboxProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }

  async updateTransaction(tx: WagerTransaction): Promise<void> {
    const r = wagerTransactionToRecord(tx);
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        status: r.status,
        failureCode: r.failureCode,
        processedAt: r.processedAt,
        referenceTransactionId: r.referenceTransactionId,
        balanceObserved: r.balanceObserved,
        referenceAttempts: r.referenceAttempts,
        referenceNextAttemptAt: r.referenceNextAttemptAt,
      },
    );
  }

  async claimDuePendingReference(now: Date, excludedIds: readonly string[]): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      {
        status: 'PENDING_REFERENCE',
        referenceNextAttemptAt: { $lte: now },
        ...(excludedIds.length > 0 ? { id: { $nin: [...excludedIds] } } : {}),
      },
      {
        orderBy: { referenceNextAttemptAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return record ? wagerTransactionFromRecord(record) : undefined;
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(entry));
  }

  async enqueueOutbox(event: IntegrationEvent<unknown>): Promise<void> {
    await this.em.insert(OutboxMessageRecord, outboxToRecord(OutboxMessage.enqueue(event)));
  }}

export class MikroOrmWagerUnitOfWork implements WagerUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: WagerRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(async (tem) => {
        // Executa dentro da transação (ctx). Sem o ctx, a instrução usaria outra conexão do pool
        // e o SET LOCAL não valeria para esta transação.
        await tem
          .getConnection()
          .execute(`SET LOCAL lock_timeout = '${WALLET_LOCK_TIMEOUT_MS}ms'`, [], 'run', tem.getTransactionContext());
        return work(new MikroOrmWagerRepositories(tem));
      });
    } catch (error) {
      throw translateInfrastructureError(error);
    }
  }
}

/**
 * Traduz erros do driver para erros de aplicação.
 * Erros de domínio e de aplicação passam sem alteração.
 */
export function translateInfrastructureError(error: unknown): unknown {
  const sqlState = findCode(error, /^[0-9A-Z]{5}$/);
  if (sqlState === '23505') {
    return new UniqueViolationError(findConstraint(error));
  }
  if ((sqlState && TRANSIENT_SQLSTATES.has(sqlState)) || (sqlState?.startsWith('08') ?? false)) {
    return new TransientInfrastructureError(`falha transitória de banco (${sqlState})`);
  }
  const nodeCode = findCode(error, /^E[A-Z]+$/);
  if (nodeCode && TRANSIENT_NODE_CODES.has(nodeCode)) {
    return new TransientInfrastructureError(`falha transitória de conexão (${nodeCode})`);
  }
  return error;
}

function findCode(error: unknown, pattern: RegExp): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && pattern.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function findConstraint(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return 'desconhecida';
}
