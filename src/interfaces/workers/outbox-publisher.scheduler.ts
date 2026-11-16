import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { OutboxPublisherWorker } from '../../application/outbox/outbox-publisher.worker';
import { OUTBOX_PUBLISHER, OUTBOX_SCHEDULE } from '../http/wagering/wagering.tokens';
import { PeriodicTask } from './periodic-task';

export interface OutboxSchedule {
  readonly pollMs: number;
  readonly batchSize: number;
}

/** Liga o publisher da outbox ao ciclo de vida da aplicação. */
@Injectable()
export class OutboxPublisherScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly task: PeriodicTask;

  constructor(
    @Inject(OUTBOX_PUBLISHER) worker: OutboxPublisherWorker,
    @Inject(OUTBOX_SCHEDULE) schedule: OutboxSchedule,
  ) {
    this.task = new PeriodicTask('OutboxPublisher', schedule.pollMs, () => worker.runCycle(schedule.batchSize));
  }

  onApplicationBootstrap(): void {
    this.task.start();
  }

  onModuleDestroy(): void {
    this.task.stop();
  }
}
