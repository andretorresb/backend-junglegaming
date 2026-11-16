/**
 * Cria as filas no LocalStack. Uso: bun run localstack:init
 * Pré-requisito: docker compose up -d
 */
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { ensureQueues } from '../../src/infrastructure/messaging/queues';
import { loadEnv } from '../../src/config/env';

const queues = await ensureQueues(createSqsClient(loadEnv()));
console.log(`filas prontas: ${JSON.stringify(queues)}`);
