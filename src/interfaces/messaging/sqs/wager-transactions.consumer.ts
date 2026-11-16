import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerTransaction, ProcessWagerTransactionCommand } from '../../../application/wagering/process-wager-transaction.use-case';
import {
  IdempotencyConflictError,
  InboxDuplicateError,
  InternalOnlyKindError,
  RejectedBeforePersistenceError,
  WalletNotFoundError,
} from '../../../application/wagering/errors';
import type { Logger, Metrics } from '../../../application/ports/observability';
import { DomainError } from '../../../domain/errors';
import { FailureCode } from '../../../domain/failure-code';
import { queueUrl } from '../../../infrastructure/messaging/queues';
import { groupIdOf, parseWagerMessage, type ParsedWagerMessage } from './wager-message';
import type { ConsumerLifecycle } from './lifecycle';

export const CONSUMER_NAME = 'wager-transactions';

export interface WagerConsumerSettings {
  queueName: string;
  dlqName: string;
  waitSeconds: number;
  maxMessages: number;
  /** Tentativas antes da DLQ (seção 10: limite de tentativas). */
  maxReceiveCount: number;
  /** Atraso de retry: base × 2^(tentativa-1), limitado pelo teto. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** Tempo para concluir mensagens em andamento no shutdown. */
  shutdownGraceMs: number;
}

export interface WagerConsumerHooks {
  /** Chamado depois do commit e antes do ack. Usado em testes para simular falha nesse ponto. */
  afterCommit?: (messageId: string) => Promise<void> | void;
}

export interface WagerConsumerDeps {
  sqs: SQSClient;
  useCase: ProcessWagerTransaction;
  logger: Logger;
  metrics: Metrics;
  lifecycle: ConsumerLifecycle;
  hooks?: WagerConsumerHooks | undefined;
}

/**
 * Consome `wager-transactions.fifo` (seção 10 do enunciado).
 *
 * Para cada mensagem:
 *   - valida o schema (inválido → DLQ);
 *   - chama o mesmo caso de uso da HTTP, com a inbox gravada na mesma transação do efeito;
 *   - confirma (ack) somente depois do commit.
 *
 * Erros, em três classes:
 *   - negócio (conflito de idempotência, rejeição por contexto, mensagem já processada): ack;
 *   - permanente (dados que nenhum retry corrige): DLQ;
 *   - transitório (banco, lock, rede): não confirma, reagenda com backoff; ao atingir o limite, DLQ.
 */
export class WagerTransactionsConsumer {
  private readonly inFlight = new Map<string, string>();
  private loop: Promise<void> | undefined;
  private stopping = false;
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;

  constructor(
    private readonly deps: WagerConsumerDeps,
    private readonly settings: WagerConsumerSettings,
  ) {}

  start(): void {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.deps.lifecycle.draining = false;
    this.loop = this.run();
  }

  /**
   * Shutdown: para de receber, espera as mensagens em andamento até o limite de graça e devolve
   * as que sobraram à fila (visibilidade zero).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.deps.lifecycle.draining = true;
    if (this.loop === undefined) return;

    const finished = await raceWithTimeout(this.loop, this.settings.shutdownGraceMs);
    if (!finished) {
      for (const receipt of this.inFlight.keys()) {
        await this.changeVisibility(receipt, 0).catch(() => undefined);
      }
      this.deps.logger.info('consumer_shutdown_released', { released: this.inFlight.size });
      await raceWithTimeout(this.loop, 2000);
    }
    this.loop = undefined;
  }

  /** Uma leitura da fila e processamento sequencial do lote. Usado pelo loop e pelos testes. */
  async pollOnce(): Promise<number> {
    const url = await this.resolveQueueUrl();
    const response = await this.deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: this.settings.maxMessages,
        WaitTimeSeconds: this.settings.waitSeconds,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const messages = response.Messages ?? [];
    for (const message of messages) {
      if (this.stopping) {
        // recebida antes do shutdown: devolve sem processar
        if (message.ReceiptHandle) await this.changeVisibility(message.ReceiptHandle, 0).catch(() => undefined);
        continue;
      }
      await this.track(message);
    }
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.deps.logger.error('consumer_poll_error', { reason: errorMessage(error) });
        await sleep(1000);
      }
    }
  }

  private async track(message: Message): Promise<void> {
    if (message.ReceiptHandle) this.inFlight.set(message.ReceiptHandle, message.MessageId ?? '');
    try {
      await this.handle(message);
    } finally {
      if (message.ReceiptHandle) this.inFlight.delete(message.ReceiptHandle);
    }
  }

  private async handle(message: Message): Promise<void> {
    this.deps.metrics.increment('sqs_messages_received_total');
    const body = message.Body ?? '';
    const receipt = message.ReceiptHandle ?? '';
    const receiveCount = Number(message.Attributes?.['ApproximateReceiveCount'] ?? 1);

    const parsed = await parseWagerMessage(body);
    if (!parsed.ok) {
      await this.toDeadLetter(message, parsed.reason, undefined);
      return;
    }

    try {
      await this.process(parsed.value, receipt);
    } catch (error) {
      await this.onError(message, parsed.value.messageId, error, receiveCount);
    }
  }

  private async process(parsed: ParsedWagerMessage, receipt: string): Promise<void> {
    const { data, messageId } = parsed;
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: data.idempotencyKey,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: { amount: data.money.amount, currency: data.money.currency },
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      correlationId: messageId,
    };

    const result = await this.deps.useCase.execute(command, { consumerName: CONSUMER_NAME, messageId });
    // Commit feito. Qualquer falha daqui para a frente faz a mensagem voltar, e a inbox impede o efeito duplicado.
    await this.deps.hooks?.afterCommit?.(messageId);
    await this.ack(receipt);
    this.deps.metrics.increment('sqs_messages_acked_total');
    this.deps.logger.info('message_processed', {
      messageId,
      transactionId: result.transactionId,
      status: result.status,
      failureCode: result.failureCode ?? null,
      idempotentReplay: result.idempotentReplay,
    });
  }

  private async onError(message: Message, messageId: string, error: unknown, receiveCount: number): Promise<void> {
    const receipt = message.ReceiptHandle ?? '';
    const reason = errorMessage(error);

    if (error instanceof InboxDuplicateError) {
      this.deps.metrics.increment('duplicates_detected_total', { source: 'sqs' });
      await this.ack(receipt);
      this.deps.logger.info('message_duplicate', { messageId });
      return;
    }

    if (error instanceof IdempotencyConflictError || error instanceof RejectedBeforePersistenceError) {
      await this.ack(receipt);
      this.deps.logger.info('message_business_rejected', { messageId, failureCode: error.failureCode ?? null });
      return;
    }

    if (
      error instanceof InternalOnlyKindError ||
      error instanceof WalletNotFoundError ||
      (error instanceof DomainError && error.failureCode === FailureCode.InvalidPayload)
    ) {
      await this.toDeadLetter(message, reason, messageId);
      return;
    }

    // transitório ou desconhecido
    if (receiveCount >= this.settings.maxReceiveCount) {
      await this.toDeadLetter(message, `limite de tentativas atingido: ${reason}`, messageId);
      return;
    }
    const delay = Math.min(this.settings.retryMaxSeconds, this.settings.retryBaseSeconds * 2 ** (receiveCount - 1));
    await this.changeVisibility(receipt, delay);
    this.deps.metrics.increment('retries_total', { component: 'sqs' });
    this.deps.logger.error('message_retry', { messageId, receiveCount, delaySeconds: delay, reason });
  }

  /** Envia para a DLQ e só então confirma a original. Falha entre os dois passos gera cópia na DLQ, nunca perda. */
  private async toDeadLetter(message: Message, reason: string, messageId: string | undefined): Promise<void> {
    const url = await this.resolveDlqUrl();
    const body = message.Body ?? '';
    await this.deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: body,
        MessageGroupId: groupIdOf(body),
        MessageDeduplicationId: randomUUID(),
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason.slice(0, 256) },
          originalMessageId: { DataType: 'String', StringValue: messageId ?? 'unknown' },
        },
      }),
    );
    await this.ack(message.ReceiptHandle ?? '');
    this.deps.metrics.increment('dlq_messages_total');
    this.deps.logger.error('message_dead_lettered', { messageId: messageId ?? null, reason });
  }

  private async ack(receipt: string): Promise<void> {
    if (!receipt) return;
    const url = await this.resolveQueueUrl();
    await this.deps.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }));
  }

  private async changeVisibility(receipt: string, seconds: number): Promise<void> {
    const url = await this.resolveQueueUrl();
    await this.deps.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receipt, VisibilityTimeout: seconds }));
  }

  private async resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= await queueUrl(this.deps.sqs, this.settings.queueName);
    return this.queueUrl;
  }

  private async resolveDlqUrl(): Promise<string> {
    this.dlqUrl ??= await queueUrl(this.deps.sqs, this.settings.dlqName);
    return this.dlqUrl;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true se `promise` terminou dentro do prazo; false se o prazo venceu. */
async function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
