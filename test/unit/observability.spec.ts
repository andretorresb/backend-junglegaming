import { describe, expect, it } from 'bun:test';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics-registry';
import { JsonLogger, redact } from '../../src/infrastructure/observability/json-logger';
import { JsonNestLogger } from '../../src/infrastructure/observability/nest-logger.adapter';

describe('MetricsRegistry — formato Prometheus', () => {
  it('contador com labels, ordenados e com HELP/TYPE', () => {
    const m = new MetricsRegistry();
    m.increment('wagering_transactions_total', { status: 'PROCESSED', kind: 'BET' });
    m.increment('wagering_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    const text = m.render();
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toContain('wagering_transactions_total{kind="BET",status="PROCESSED"} 2');
  });

  it('gauge substitui o valor', () => {
    const m = new MetricsRegistry();
    m.set('outbox_lag_seconds', 5);
    m.set('outbox_lag_seconds', 3);
    expect(m.render()).toContain('outbox_lag_seconds 3');
    expect(m.value('outbox_lag_seconds')).toBe(3);
  });

  it('histograma com buckets cumulativos, soma e contagem', () => {
    const m = new MetricsRegistry();
    m.observe('processing_latency_seconds', 0.03, { source: 'http' });
    m.observe('processing_latency_seconds', 2, { source: 'http' });
    const text = m.render();
    expect(text).toContain('# TYPE processing_latency_seconds histogram');
    expect(text).toContain('processing_latency_seconds_bucket{le="0.05",source="http"} 1');
    expect(text).toContain('processing_latency_seconds_bucket{le="2.5",source="http"} 2');
    expect(text).toContain('processing_latency_seconds_bucket{le="+Inf",source="http"} 2');
    expect(text).toContain('processing_latency_seconds_count{source="http"} 2');
    expect(text).toContain('processing_latency_seconds_sum{source="http"} 2.03');
  });

  it('escapa aspas e quebras de linha em valores de label', () => {
    const m = new MetricsRegistry();
    m.increment('retries_total', { component: 'a"b\nc' });
    expect(m.render()).toContain('retries_total{component="a\\"b\\nc"} 1');
  });

  it('increment com by 0 declara a série sem alterar o valor', () => {
    const m = new MetricsRegistry();
    m.increment('dlq_messages_total', {}, 0);
    expect(m.render()).toContain('dlq_messages_total 0');
  });
});

describe('redact — campos sensíveis nunca vão para o log', () => {
  it('remove chaves de valor, payload e autorização em qualquer nível', () => {
    const out = redact({
      walletId: 'w',
      amount: '25.00',
      nested: { money: { amount: '1.00' }, balanceBefore: '1', keep: 'ok' },
      payload: { x: 1 },
      authorization: 'Bearer abc',
      list: [{ amount: '9' }],
    });
    expect(out).toEqual({ walletId: 'w', nested: { keep: 'ok' }, list: [{}] });
  });
});

describe('JsonLogger e JsonNestLogger', () => {
  it('uma linha JSON por evento, com nível, serviço e evento', () => {
    const lines: string[] = [];
    const log = new JsonLogger('svc', (l) => lines.push(l));
    log.info('transaction_decided', { transactionId: 't', amount: '1.00' });
    log.error('reconciliation_divergence', { walletId: 'w' });
    const [a, b] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(a).toMatchObject({ level: 'info', service: 'svc', event: 'transaction_decided', transactionId: 't' });
    expect(a).not.toHaveProperty('amount');
    expect(b).toMatchObject({ level: 'error', event: 'reconciliation_divergence', walletId: 'w' });
    expect(typeof a?.['time']).toBe('string');
  });

  it('logs do framework (Nest) saem no mesmo formato', () => {
    const lines: string[] = [];
    const adapter = new JsonNestLogger(new JsonLogger('svc', (l) => lines.push(l)));
    adapter.log('iniciado', 'Bootstrap');
    adapter.error(new Error('falhou'), 'stack...', 'Bootstrap');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ event: 'app', message: 'iniciado', context: 'Bootstrap' });
    expect(parsed[1]).toMatchObject({ level: 'error', event: 'app_error', stack: 'stack...' });
  });
});
