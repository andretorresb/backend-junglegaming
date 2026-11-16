import type { Metrics } from '../../application/ports/observability';

type Labels = Record<string, string>;

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Descrição das métricas do enunciado (seção 12) e das que o processo expõe além delas. */
const HELP: Record<string, string> = {
  wagering_transactions_total: 'Transações decididas, por tipo e status final.',
  duplicates_detected_total: 'Mensagens ou requisições repetidas detectadas (replay ou inbox).',
  retries_total: 'Tentativas repetidas por componente (fila, worker de referência, outbox).',
  dlq_messages_total: 'Mensagens enviadas à dead-letter queue.',
  lock_conflicts_total: 'Esperas de lock de wallet que estouraram o timeout ou deadlock.',
  outbox_lag_seconds: 'Idade, em segundos, da mensagem da outbox mais antiga ainda não publicada.',
  outbox_published_total: 'Eventos publicados na fila de eventos.',
  outbox_publish_failed_total: 'Falhas de publicação de eventos.',
  processing_latency_seconds: 'Latência de processamento, em segundos.',
  reconciliation_divergence_total: 'Divergências encontradas na reconciliação de wallets.',
  sqs_messages_received_total: 'Mensagens recebidas da fila de transações.',
  sqs_messages_acked_total: 'Mensagens confirmadas após processamento.',
};

type Kind = 'counter' | 'gauge' | 'histogram';

interface Histogram {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

/**
 * Registro de métricas com exposição no formato texto do Prometheus (GET /metrics).
 * Implementação própria, sem dependência externa: a superfície é pequena e o formato é estável.
 */
export class MetricsRegistry implements Metrics {
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly gauges = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  increment(name: string, labels: Labels = {}, by = 1): void {
    const series = this.series(this.counters, name);
    const key = labelKey(labels);
    const current = series.get(key) ?? { labels, value: 0 };
    current.value += by;
    series.set(key, current);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    const series = this.series(this.gauges, name);
    series.set(labelKey(labels), { labels, value });
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const series = this.series(this.histograms, name);
    const key = labelKey(labels);
    const h = (series.get(key) as Histogram | undefined) ?? {
      labels,
      counts: HISTOGRAM_BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    HISTOGRAM_BUCKETS.forEach((bound, i) => {
      if (value <= bound) h.counts[i] = (h.counts[i] ?? 0) + 1;
    });
    h.sum += value;
    h.count += 1;
    series.set(key, h);
  }

  /** Valor atual de um contador ou medidor. Para histogramas, o número de observações. */
  value(name: string, labels: Labels = {}): number {
    const key = labelKey(labels);
    const counter = this.counters.get(name)?.get(key)?.value;
    if (counter !== undefined) return counter;
    const gauge = this.gauges.get(name)?.get(key)?.value;
    if (gauge !== undefined) return gauge;
    return (this.histograms.get(name)?.get(key) as Histogram | undefined)?.count ?? 0;
  }

  /** Texto no formato de exposição do Prometheus (versão 0.0.4). */
  render(): string {
    const lines: string[] = [];
    this.renderKind('counter', this.counters, lines);
    this.renderKind('gauge', this.gauges, lines);
    this.renderHistograms(lines);
    return `${lines.join('\n')}\n`;
  }

  private renderKind(kind: Kind, source: Map<string, Map<string, { labels: Labels; value: number }>>, lines: string[]): void {
    for (const [name, series] of source) {
      lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} ${kind}`);
      for (const { labels, value } of series.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }
  }

  private renderHistograms(lines: string[]): void {
    for (const [name, series] of this.histograms) {
      lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} histogram`);
      for (const h of series.values() as IterableIterator<Histogram>) {
        HISTOGRAM_BUCKETS.forEach((bound, i) => {
          lines.push(`${name}_bucket${formatLabels({ ...h.labels, le: String(bound) })} ${h.counts[i] ?? 0}`);
        });
        lines.push(`${name}_bucket${formatLabels({ ...h.labels, le: '+Inf' })} ${h.count}`);
        lines.push(`${name}_sum${formatLabels(h.labels)} ${h.sum}`);
        lines.push(`${name}_count${formatLabels(h.labels)} ${h.count}`);
      }
    }
  }

  private series<T>(map: Map<string, Map<string, T>>, name: string): Map<string, T> {
    let series = map.get(name);
    if (!series) {
      series = new Map();
      map.set(name, series);
    }
    return series;
  }
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
