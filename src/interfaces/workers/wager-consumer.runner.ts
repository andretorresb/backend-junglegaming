import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { WagerTransactionsConsumer } from '../messaging/sqs/wager-transactions.consumer';
import { WAGER_CONSUMER, WAGER_CONSUMER_ENABLED } from '../http/wagering/wagering.tokens';

/** Liga o consumidor da fila ao ciclo de vida. SIGTERM → onModuleDestroy → stop gracioso. */
@Injectable()
export class WagerConsumerRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('WagerConsumerRunner');

  constructor(
    @Inject(WAGER_CONSUMER) private readonly consumer: WagerTransactionsConsumer,
    @Inject(WAGER_CONSUMER_ENABLED) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.consumer.start();
      this.logger.log('consumidor de wager-transactions iniciado');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.consumer.stop();
  }
}
