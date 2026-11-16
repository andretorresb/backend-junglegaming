import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { MetricsController } from '../observability/metrics.controller';
import { HttpObservabilityInterceptor } from '../observability/http-observability.interceptor';
import { MetricsRegistry } from '../../../infrastructure/observability/metrics-registry';
import { preregisterMetrics } from '../../../infrastructure/observability/preregister';
import { EntityManager } from '@mikro-orm/core';
import { ProcessWagerTransaction } from '../../../application/wagering/process-wager-transaction.use-case';
import { PendingReferenceWorker, type WorkerLogEntry } from '../../../application/wagering/pending-reference.worker';
import { OpenWallet } from '../../../application/wallets/open-wallet.use-case';
import type { Clock } from '../../../application/ports/clock';
import { loadEnv } from '../../../config/env';
import { MikroOrmWagerUnitOfWork } from '../../../infrastructure/persistence/wagering.persistence';
import { WagerTransactionQueries } from '../../../infrastructure/persistence/wagering.queries';
import { WalletQueries } from '../../../infrastructure/persistence/wallet.queries';
import { JsonLogger } from '../../../infrastructure/observability/json-logger';
import { SystemClock } from '../../../infrastructure/time/system-clock';
import type { ReferenceRetryPolicy } from '../../../domain/wagering/reference-retry-policy';
import { PendingReferenceScheduler } from '../../workers/pending-reference.scheduler';
import { OutboxPublisherScheduler } from '../../workers/outbox-publisher.scheduler';
import { WagerConsumerRunner } from '../../workers/wager-consumer.runner';
import { WagerTransactionsConsumer } from '../../messaging/sqs/wager-transactions.consumer';
import type { ConsumerLifecycle } from '../../messaging/sqs/lifecycle';
import { OutboxPublisherWorker } from '../../../application/outbox/outbox-publisher.worker';
import { MikroOrmOutboxUnitOfWork } from '../../../infrastructure/persistence/outbox.persistence';
import { SqsEventPublisher } from '../../../infrastructure/messaging/sqs-event-publisher';
import { createSqsClient } from '../../../infrastructure/messaging/sqs-client';
import { ApplicationErrorFilter } from '../errors/application-error.filter';
import { WalletController } from '../wallets/wallets.controller';
import { WagerController } from './wagering.controller';
import {
  OPEN_WALLET,
  PENDING_REFERENCE_SCHEDULE,
  PENDING_REFERENCE_WORKER,
  PROCESS_WAGER_TRANSACTION,
  RETRY_POLICY,
  WAGER_TRANSACTION_QUERIES,
  LOGGER,
  METRICS,
  WALLET_QUERIES,
  OUTBOX_PUBLISHER,
  OUTBOX_SCHEDULE,
  EVENT_PUBLISHER,
  SQS_CLIENT,
  WAGER_CONSUMER,
  WAGER_CONSUMER_ENABLED,
  CONSUMER_LIFECYCLE,
} from './wagering.tokens';

export const CLOCK = Symbol('CLOCK');

const retryPolicyFromEnv = (): ReferenceRetryPolicy => {
  const { maxAttempts, ttlMs, baseDelayMs, maxDelayMs } = loadEnv().pendingReference;
  return { maxAttempts, ttlMs, baseDelayMs, maxDelayMs };
};

const workerLogger = new Logger('PendingReferenceWorker');
const logWorker = (entry: WorkerLogEntry): void => {
  const line = JSON.stringify(entry);
  if (entry['level'] === 'error') workerLogger.error(line);
  else workerLogger.log(line);
};

@Module({
  controllers: [WagerController, WalletController, MetricsController],
  exports: [SQS_CLIENT, CONSUMER_LIFECYCLE],
  providers: [
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(loadEnv()) },
    { provide: CONSUMER_LIFECYCLE, useFactory: (): ConsumerLifecycle => ({ draining: false }) },
    {
      provide: WAGER_CONSUMER,
      inject: [SQS_CLIENT, PROCESS_WAGER_TRANSACTION, LOGGER, METRICS, CONSUMER_LIFECYCLE],
      useFactory: (sqs: SQSClient, useCase: ProcessWagerTransaction, logger: JsonLogger, metrics: MetricsRegistry, lifecycle: ConsumerLifecycle) => {
        const env = loadEnv();
        const c = env.consumer;
        // Falha injetada (teste): processo morre entre o commit e o ack. Desligada por padrão.
        const hooks = env.faults.crashAfterCommit ? { afterCommit: () => process.exit(137) } : undefined;
        return new WagerTransactionsConsumer(
          { sqs, useCase, logger, metrics, lifecycle, hooks },
          {
            queueName: c.queueName,
            dlqName: c.dlqName,
            waitSeconds: c.waitSeconds,
            maxMessages: c.maxMessages,
            maxReceiveCount: c.maxReceiveCount,
            retryBaseSeconds: c.retryBaseSeconds,
            retryMaxSeconds: c.retryMaxSeconds,
            shutdownGraceMs: c.shutdownGraceMs,
            visibilitySeconds: c.visibilitySeconds,
          },
        );
      },
    },
    { provide: WAGER_CONSUMER_ENABLED, useFactory: () => loadEnv().consumer.enabled },
    WagerConsumerRunner,
    { provide: RETRY_POLICY, useFactory: retryPolicyFromEnv },
    {
      provide: PROCESS_WAGER_TRANSACTION,
      inject: [EntityManager, CLOCK, RETRY_POLICY, LOGGER, METRICS],
      useFactory: (em: EntityManager, clock: Clock, retryPolicy: ReferenceRetryPolicy, logger: JsonLogger, metrics: MetricsRegistry) =>
        new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em, metrics), clock, randomUUID, {
          retryPolicy,
          random: Math.random,
          logger,
          metrics,
        }),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [EntityManager, CLOCK, RETRY_POLICY, METRICS],
      useFactory: (em: EntityManager, clock: Clock, retryPolicy: ReferenceRetryPolicy, metrics: MetricsRegistry) =>
        new PendingReferenceWorker(new MikroOrmWagerUnitOfWork(em, metrics), clock, randomUUID, {
          retryPolicy,
          random: Math.random,
          metrics,
        }, logWorker),
    },
    {
      provide: PENDING_REFERENCE_SCHEDULE,
      useFactory: () => {
        const { pollMs, batchSize } = loadEnv().pendingReference;
        return { pollMs, batchSize };
      },
    },
    PendingReferenceScheduler,
    { provide: EVENT_PUBLISHER, useFactory: () => { const env = loadEnv(); return new SqsEventPublisher(createSqsClient(env), env.outbox.queueName); } },
    {
      provide: OUTBOX_PUBLISHER,
      inject: [EntityManager, EVENT_PUBLISHER, CLOCK, METRICS, LOGGER],
      useFactory: (em: EntityManager, publisher: SqsEventPublisher, clock: Clock, metrics: MetricsRegistry, logger: JsonLogger) => {
        const env = loadEnv();
        return new OutboxPublisherWorker(new MikroOrmOutboxUnitOfWork(em), publisher, clock, metrics, logger, {
          retryPolicy: { baseDelayMs: 1000, maxDelayMs: env.outbox.maxBackoffMs },
        });
      },
    },
    {
      provide: OUTBOX_SCHEDULE,
      useFactory: () => {
        const { pollMs, batchSize } = loadEnv().outbox;
        return { pollMs, batchSize };
      },
    },
    OutboxPublisherScheduler,
    {
      provide: OPEN_WALLET,
      inject: [EntityManager, CLOCK, METRICS],
      useFactory: (em: EntityManager, clock: Clock, metrics: MetricsRegistry) => new OpenWallet(new MikroOrmWagerUnitOfWork(em, metrics), clock, randomUUID),
    },
    {
      provide: WAGER_TRANSACTION_QUERIES,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new WagerTransactionQueries(em),
    },
    { provide: LOGGER, useFactory: () => new JsonLogger(loadEnv().serviceName) },
    { provide: METRICS, useFactory: () => preregisterMetrics(new MetricsRegistry()) },
    { provide: APP_INTERCEPTOR, useClass: HttpObservabilityInterceptor },
    {
      provide: WALLET_QUERIES,
      inject: [EntityManager, METRICS, LOGGER],
      useFactory: (em: EntityManager, metrics: MetricsRegistry, logger: JsonLogger) => new WalletQueries(em, metrics, logger),
    },
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    {
      provide: APP_PIPE,
      useFactory: () => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class WagerModule {}
