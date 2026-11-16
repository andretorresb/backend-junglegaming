/**
 * Portas de observabilidade. A aplicação registra eventos e contadores através destas
 * interfaces; a implementação (stdout JSON, Prometheus) fica na infraestrutura.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface Metrics {
  increment(name: string, labels?: Record<string, string>, by?: number): void;
  /** Valor atual de um medidor (gauge). */
  set(name: string, value: number, labels?: Record<string, string>): void;
}
