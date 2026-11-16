import type { Metrics } from '../../application/ports/observability';

type Labels = Record<string, string>;

/**
 * Contadores em memória. Adequados a testes e a um processo único.
 * A Etapa 9 substitui por Prometheus (prom-client) mantendo a mesma porta.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, labels: Labels = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.counters.set(this.key(name, labels), value);
  }

  value(name: string, labels: Labels = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  private key(name: string, labels: Labels): string {
    const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
    return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
  }
}
