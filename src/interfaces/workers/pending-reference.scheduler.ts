import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { PendingReferenceWorker } from '../../application/wagering/pending-reference.worker';
import { PENDING_REFERENCE_SCHEDULE, PENDING_REFERENCE_WORKER } from '../http/wagering/wagering.tokens';

export interface PendingReferenceSchedule {
  readonly pollMs: number;
  readonly batchSize: number;
}

/**
 * Dispara o worker em intervalo fixo. Um ciclo só começa depois que o anterior termina,
 * então ciclos não se sobrepõem dentro da mesma instância. Entre instâncias, o
 * SKIP LOCKED do worker garante que não há processamento duplicado.
 */
@Injectable()
export class PendingReferenceScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PendingReferenceScheduler');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    @Inject(PENDING_REFERENCE_WORKER) private readonly worker: PendingReferenceWorker,
    @Inject(PENDING_REFERENCE_SCHEDULE) private readonly schedule: PendingReferenceSchedule,
  ) {}

  onApplicationBootstrap(): void {
    if (this.schedule.pollMs > 0) {
      this.arm();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.arm();
      });
    }, this.schedule.pollMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.worker.runCycle(this.schedule.batchSize);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    }
  }
}
