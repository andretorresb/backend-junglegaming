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
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  return {
    port: parseIntEnv(source['PORT'], 3000, 'PORT'),
    serviceName: source['SERVICE_NAME'] ?? 'wagering-processor',
    database: {
      host: source['DB_HOST'] ?? 'localhost',
      port: parseIntEnv(source['DB_PORT'], 5432, 'DB_PORT'),
      user: source['DB_USER'] ?? 'jungle',
      password: source['DB_PASSWORD'] ?? 'jungle',
      name: source['DB_NAME'] ?? 'junglegaming',
    },
    aws: {
      endpoint: source['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566',
      region: source['AWS_REGION'] ?? 'us-east-1',
    },
  };
}

function parseIntEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Variável de ambiente ${name} inválida: "${raw}"`);
  }
  return value;
}
