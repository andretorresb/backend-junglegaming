/**
 * Cria as filas no LocalStack. Uso: bun run localstack:init
 * Pré-requisito: docker compose up -d
 */
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueSettingsFromEnv } from '../../src/infrastructure/messaging/queues';
import { loadEnv } from '../../src/config/env';

const env = loadEnv();
const queues = await ensureQueues(createSqsClient(env), queueSettingsFromEnv(env));
console.log(`filas prontas: ${JSON.stringify(queues)}`);
