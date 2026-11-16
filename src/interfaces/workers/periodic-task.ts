import { Logger } from '@nestjs/common';

/**
 * Executa uma tarefa em intervalo fixo, sem sobreposição: o próximo ciclo só é agendado
 * depois que o atual termina. Com `intervalMs` 0 não agenda nada.
 */
export class PeriodicTask {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  private readonly logger: Logger;

  constructor(
    name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.intervalMs > 0) this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      void this.run().finally(() => {
        if (!this.stopped) this.arm();
      });
    }, this.intervalMs);
  }

  private async run(): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    }
  }
}
