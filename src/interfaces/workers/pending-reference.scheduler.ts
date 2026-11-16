import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { PendingReferenceWorker } from '../../application/wagering/pending-reference.worker';
import { PENDING_REFERENCE_SCHEDULE, PENDING_REFERENCE_WORKER } from '../http/wagering/wagering.tokens';
import { PeriodicTask } from './periodic-task';

export interface PendingReferenceSchedule {
  readonly pollMs: number;
  readonly batchSize: number;
}

/** Dispara o worker de referências pendentes em intervalo fixo (ver PeriodicTask). */
@Injectable()
export class PendingReferenceScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly task: PeriodicTask;

  constructor(
    @Inject(PENDING_REFERENCE_WORKER) worker: PendingReferenceWorker,
    @Inject(PENDING_REFERENCE_SCHEDULE) schedule: PendingReferenceSchedule,
  ) {
    this.task = new PeriodicTask('PendingReferenceWorker', schedule.pollMs, () => worker.runCycle(schedule.batchSize));
  }

  onApplicationBootstrap(): void {
    this.task.start();
  }

  onModuleDestroy(): void {
    this.task.stop();
  }
}
