/**
 * Leitura centralizada de variáveis de ambiente.
 * Valores padrão são apenas para desenvolvimento local (ver .env.example).
 */
export interface AppEnv {
  readonly port: number;
  readonly serviceName: string;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly name: string;
  };
  readonly aws: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly consumer: {
    readonly enabled: boolean;
    readonly queueName: string;
    readonly dlqName: string;
    readonly waitSeconds: number;
    readonly maxMessages: number;
    readonly maxReceiveCount: number;
    readonly retryBaseSeconds: number;
    readonly retryMaxSeconds: number;
    readonly shutdownGraceMs: number;
    readonly visibilitySeconds: number;
  };
  /** Falhas injetadas para teste de recuperação. Desligadas por padrão; nunca ativas em produção. */
  readonly faults: {
    readonly crashAfterCommit: boolean;
  };
  readonly outbox: {
    /** Intervalo entre ciclos do publisher. 0 desliga o agendamento. */
    readonly pollMs: number;
    readonly batchSize: number;
    readonly maxBackoffMs: number;
    readonly queueName: string;
    /** Faixas concorrentes de publicação por processo. */
    readonly parallelism: number;
  };
  readonly pendingReference: {
    /** Intervalo entre ciclos do worker. 0 desliga o agendamento (usado nos testes). */
    readonly pollMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
    readonly ttlMs: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
  };
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  return {
    port: parseIntEnv(source['PORT'], 3000, 'PORT'),
    serviceName: source['SERVICE_NAME'] ?? 'wagering-processor',
    database: {
      host: source['DB_HOST'] ?? 'localhost',
      port: parseIntEnv(source['DB_PORT'], 5433, 'DB_PORT'),
      user: source['DB_USER'] ?? 'jungle',
      password: source['DB_PASSWORD'] ?? 'jungle',
      name: source['DB_NAME'] ?? 'junglegaming',
    },
    aws: {
      endpoint: source['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566',
      region: source['AWS_REGION'] ?? 'us-east-1',
      accessKeyId: source['AWS_ACCESS_KEY_ID'] ?? 'test',
      secretAccessKey: source['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    },
    consumer: {
      enabled: (source['WAGER_CONSUMER_ENABLED'] ?? '1') !== '0',
      queueName: source['SQS_WAGER_QUEUE'] ?? 'wager-transactions.fifo',
      dlqName: source['SQS_WAGER_DLQ'] ?? 'wager-transactions-dlq.fifo',
      waitSeconds: parseIntEnv(source['SQS_WAIT_SECONDS'], 10, 'SQS_WAIT_SECONDS', 0),
      maxMessages: parseIntEnv(source['SQS_MAX_MESSAGES'], 10, 'SQS_MAX_MESSAGES'),
      maxReceiveCount: parseIntEnv(source['SQS_MAX_RECEIVE_COUNT'], 5, 'SQS_MAX_RECEIVE_COUNT'),
      retryBaseSeconds: parseIntEnv(source['SQS_RETRY_BASE_SECONDS'], 5, 'SQS_RETRY_BASE_SECONDS'),
      retryMaxSeconds: parseIntEnv(source['SQS_RETRY_MAX_SECONDS'], 900, 'SQS_RETRY_MAX_SECONDS'),
      shutdownGraceMs: parseIntEnv(source['SHUTDOWN_GRACE_MS'], 10_000, 'SHUTDOWN_GRACE_MS', 0),
      visibilitySeconds: parseIntEnv(source['SQS_VISIBILITY_SECONDS'], 60, 'SQS_VISIBILITY_SECONDS'),
    },
    faults: {
      crashAfterCommit: source['FAULT_CRASH_AFTER_COMMIT'] === '1',
    },
    outbox: {
      pollMs: parseIntEnv(source['OUTBOX_POLL_MS'], 500, 'OUTBOX_POLL_MS', 0),
      batchSize: parseIntEnv(source['OUTBOX_BATCH_SIZE'], 50, 'OUTBOX_BATCH_SIZE'),
      maxBackoffMs: parseIntEnv(source['OUTBOX_MAX_BACKOFF_MS'], 300_000, 'OUTBOX_MAX_BACKOFF_MS'),
      queueName: source['EVENTS_QUEUE_NAME'] ?? 'wager-events',
      parallelism: parseIntEnv(source['OUTBOX_PARALLELISM'], 8, 'OUTBOX_PARALLELISM'),
    },
    pendingReference: {
      pollMs: parseIntEnv(source['PENDING_REFERENCE_POLL_MS'], 1000, 'PENDING_REFERENCE_POLL_MS', 0),
      batchSize: parseIntEnv(source['PENDING_REFERENCE_BATCH_SIZE'], 50, 'PENDING_REFERENCE_BATCH_SIZE'),
      maxAttempts: parseIntEnv(source['PENDING_REFERENCE_MAX_ATTEMPTS'], 10, 'PENDING_REFERENCE_MAX_ATTEMPTS'),
      ttlMs: parseIntEnv(source['PENDING_REFERENCE_TTL_MS'], 24 * 60 * 60 * 1000, 'PENDING_REFERENCE_TTL_MS'),
      baseDelayMs: parseIntEnv(source['PENDING_REFERENCE_BASE_DELAY_MS'], 1000, 'PENDING_REFERENCE_BASE_DELAY_MS'),
      maxDelayMs: parseIntEnv(source['PENDING_REFERENCE_MAX_DELAY_MS'], 300_000, 'PENDING_REFERENCE_MAX_DELAY_MS'),
    },
  };
}

/** Inteiro positivo; `minimum` permite 0 quando faz sentido (ex.: desligar um intervalo). */
function parseIntEnv(raw: string | undefined, fallback: number, name: string, minimum = 1): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Variável de ambiente ${name} inválida: "${raw}"`);
  }
  return value;
}
