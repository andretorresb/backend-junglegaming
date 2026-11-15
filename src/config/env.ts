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
