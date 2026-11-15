import { randomUUID } from 'node:crypto';
import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/core';
import { ProcessWagerTransaction } from '../../../application/wagering/process-wager-transaction.use-case';
import { PendingReferenceWorker, type WorkerLogEntry } from '../../../application/wagering/pending-reference.worker';
import { OpenWallet } from '../../../application/wallets/open-wallet.use-case';
import type { Clock } from '../../../application/ports/clock';
import { loadEnv } from '../../../config/env';
import { MikroOrmWagerUnitOfWork } from '../../../infrastructure/persistence/wagering.persistence';
import { WagerTransactionQueries } from '../../../infrastructure/persistence/wagering.queries';
import { SystemClock } from '../../../infrastructure/time/system-clock';
import type { ReferenceRetryPolicy } from '../../../domain/wagering/reference-retry-policy';
import { PendingReferenceScheduler } from '../../workers/pending-reference.scheduler';
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
  controllers: [WagerController, WalletController],
  providers: [
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    { provide: RETRY_POLICY, useFactory: retryPolicyFromEnv },
    {
      provide: PROCESS_WAGER_TRANSACTION,
      inject: [EntityManager, CLOCK, RETRY_POLICY],
      useFactory: (em: EntityManager, clock: Clock, retryPolicy: ReferenceRetryPolicy) =>
        new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em), clock, randomUUID, {
          retryPolicy,
          random: Math.random,
        }),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [EntityManager, CLOCK, RETRY_POLICY],
      useFactory: (em: EntityManager, clock: Clock, retryPolicy: ReferenceRetryPolicy) =>
        new PendingReferenceWorker(new MikroOrmWagerUnitOfWork(em), clock, randomUUID, {
          retryPolicy,
          random: Math.random,
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
    {
      provide: OPEN_WALLET,
      inject: [EntityManager, CLOCK],
      useFactory: (em: EntityManager, clock: Clock) => new OpenWallet(new MikroOrmWagerUnitOfWork(em), clock, randomUUID),
    },
    {
      provide: WAGER_TRANSACTION_QUERIES,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new WagerTransactionQueries(em),
    },
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    {
      provide: APP_PIPE,
      useFactory: () => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class WagerModule {}
