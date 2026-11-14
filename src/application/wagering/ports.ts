import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

/** Mensagem a publicar, gravada na outbox na mesma transação (Etapa 7 publica). */
export interface OutboxEnvelope {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Operações disponíveis dentro de uma única transação SQL.
 * Todas compartilham a mesma conexão; nenhuma consulta pode sair dessa transação.
 */
export interface WagerRepositories {
  /** SELECT ... FOR UPDATE na linha da wallet. Serializa operações da mesma wallet. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet, previousVersion: number): Promise<void>;
  findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findTransactionByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Reversão já processada que aponta para esta transação (REFUND ou ROLLBACK), se existir. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  enqueueOutbox(message: OutboxEnvelope): Promise<void>;
}

export interface WagerUnitOfWork {
  /** Executa `work` em uma transação. Erros de infraestrutura são traduzidos aqui. */
  run<T>(work: (repos: WagerRepositories) => Promise<T>): Promise<T>;
}
