import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DeleteQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueSettingsFromEnv, queueUrl, type QueueSettings } from '../../../src/infrastructure/messaging/queues';
import { loadEnv } from '../../../src/config/env';

/**
 * Regressão: a inicialização das filas tem de usar os nomes e o limite configurados no ambiente,
 * os mesmos que o consumidor e o publisher usam. Antes, os nomes eram fixos.
 */
describe('Nomes de filas configuráveis (inicialização = runtime)', () => {
  const sqs: SQSClient = createSqsClient(loadEnv());
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const settings: QueueSettings = {
    wager: `qn-${suffix}.fifo`,
    dlq: `qn-${suffix}-dlq.fifo`,
    events: `qn-${suffix}-events`,
    maxReceiveCount: 7,
  };

  afterAll(async () => {
    for (const name of created) {
      const url = await queueUrl(sqs, name).catch(() => undefined);
      if (url) await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    sqs.destroy();
  });

  it('cria as filas com os nomes recebidos, e não com os padrões', async () => {
    await ensureQueues(sqs, settings);
    created.push(settings.wager, settings.dlq, settings.events);

    expect(await queueUrl(sqs, settings.wager)).toContain(settings.wager);
    expect(await queueUrl(sqs, settings.dlq)).toContain(settings.dlq);
    expect(await queueUrl(sqs, settings.events)).toContain(settings.events);
  });

  it('a redrive policy aponta para a DLQ configurada, com o limite configurado', async () => {
    const url = await queueUrl(sqs, settings.wager);
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['RedrivePolicy'] }));
    const policy = JSON.parse(attrs.Attributes?.['RedrivePolicy'] ?? '{}') as { deadLetterTargetArn: string; maxReceiveCount: number | string };
    expect(policy.deadLetterTargetArn.endsWith(`:${settings.dlq}`)).toBe(true);
    expect(Number(policy.maxReceiveCount)).toBe(7);
  });

  it('recusa nome FIFO sem o sufixo .fifo antes de chamar a AWS', async () => {
    await expect(ensureQueues(sqs, { ...settings, wager: 'sem-sufixo' })).rejects.toThrow('precisa terminar em .fifo');
    await expect(ensureQueues(sqs, { ...settings, dlq: 'dlq-sem-sufixo' })).rejects.toThrow('precisa terminar em .fifo');
  });

  it('o ambiente alimenta os mesmos nomes e limite no consumidor, no publisher e na inicialização', () => {
    const env = loadEnv({
      SQS_WAGER_QUEUE: 'a.fifo',
      SQS_WAGER_DLQ: 'a-dlq.fifo',
      EVENTS_QUEUE_NAME: 'a-events',
      SQS_MAX_RECEIVE_COUNT: '9',
    });
    expect(env.consumer.queueName).toBe('a.fifo');
    expect(env.consumer.dlqName).toBe('a-dlq.fifo');
    expect(env.outbox.queueName).toBe('a-events');
    expect(queueSettingsFromEnv(env)).toEqual({ wager: 'a.fifo', dlq: 'a-dlq.fifo', events: 'a-events', maxReceiveCount: 9 });
  });
});
