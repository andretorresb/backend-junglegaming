import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/core';
import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import mikroOrmConfig from '../mikro-orm.config';
import { loadEnv } from './config/env';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { HealthController } from './interfaces/http/health/health.controller';
import { ReadinessChecker } from './interfaces/http/health/readiness';
import { WagerModule } from './interfaces/http/wagering/wagering.module';
import { READINESS, SQS_CLIENT } from './interfaces/http/wagering/wagering.tokens';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WagerModule],
  controllers: [HealthController],
  providers: [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(loadEnv()) },
    {
      provide: READINESS,
      inject: [EntityManager, SQS_CLIENT],
      useFactory: (em: EntityManager, sqs: SQSClient) =>
        new ReadinessChecker([
          {
            name: 'postgres',
            check: () => em.fork().getConnection().execute('select 1'),
          },
          {
            name: 'sqs',
            check: () => sqs.send(new ListQueuesCommand({ MaxResults: 1 })),
          },
        ]),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
