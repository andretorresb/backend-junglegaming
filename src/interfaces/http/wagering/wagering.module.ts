import { randomUUID } from 'node:crypto';
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/core';
import { ProcessWagerTransaction } from '../../../application/wagering/process-wager-transaction.use-case';
import { OpenWallet } from '../../../application/wallets/open-wallet.use-case';
import { WalletController } from '../wallets/wallets.controller';
import type { Clock } from '../../../application/ports/clock';
import { MikroOrmWagerUnitOfWork } from '../../../infrastructure/persistence/wagering.persistence';
import { WagerTransactionQueries } from '../../../infrastructure/persistence/wagering.queries';
import { SystemClock } from '../../../infrastructure/time/system-clock';
import { ApplicationErrorFilter } from '../errors/application-error.filter';
import { WagerController } from './wagering.controller';
import { OPEN_WALLET, PROCESS_WAGER_TRANSACTION, WAGER_TRANSACTION_QUERIES } from './wagering.tokens';

export const CLOCK = Symbol('CLOCK');

@Module({
  controllers: [WagerController, WalletController],
  providers: [
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: PROCESS_WAGER_TRANSACTION,
      inject: [EntityManager, CLOCK],
      useFactory: (em: EntityManager, clock: Clock) =>
        new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em), clock, randomUUID),
    },
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
