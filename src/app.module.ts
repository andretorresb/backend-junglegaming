import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/core';
import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import mikroOrmConfig from '../mikro-orm.config';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { HealthController } from './interfaces/http/health/health.controller';
import { ReadinessChecker } from './interfaces/http/health/readiness';
import { WagerModule } from './interfaces/http/wagering/wagering.module';
import { CONSUMER_LIFECYCLE, READINESS, SQS_CLIENT } from './interfaces/http/wagering/wagering.tokens';
import type { ConsumerLifecycle } from './interfaces/messaging/sqs/lifecycle';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WagerModule],
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS,
      inject: [EntityManager, SQS_CLIENT, CONSUMER_LIFECYCLE],
      useFactory: (em: EntityManager, sqs: SQSClient, lifecycle: ConsumerLifecycle) =>
        new ReadinessChecker([
          {
            name: 'postgres',
            check: () => em.fork().getConnection().execute('select 1'),
          },
          {
            name: 'sqs',
            check: () => sqs.send(new ListQueuesCommand({ MaxResults: 1 })),
          },
          {
            // durante o shutdown o processo sai da rotação (seção 10: shutdown gracioso)
            name: 'draining',
            check: async () => {
              if (lifecycle.draining) throw new Error('drenando mensagens (shutdown em andamento)');
            },
          },
        ]),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
