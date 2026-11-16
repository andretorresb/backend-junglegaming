import type { LogFields, Logger } from '../../application/ports/observability';

/** Chaves que nunca vão para o log, mesmo que apareçam aninhadas (seção 12 do enunciado). */
const REDACTED_KEYS = new Set(['amount', 'money', 'balance', 'payload', 'authorization', 'body', 'balanceBefore', 'balanceAfter']);

/**
 * Logger estruturado: uma linha JSON por evento, em stdout.
 * Campos sensíveis são removidos recursivamente antes de serializar.
 */
export class JsonLogger implements Logger {
  constructor(
    private readonly service: string,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  info(event: string, fields: LogFields = {}): void {
    this.emit('info', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.emit('error', event, fields);
  }

  private emit(level: 'info' | 'error', event: string, fields: LogFields): void {
    this.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        service: this.service,
        event,
        ...redact(fields),
      }),
    );
  }
}

export function redact(value: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) continue;
    out[key] = val !== null && typeof val === 'object' && !Array.isArray(val) ? redact(val as LogFields) : val;
  }
  return out;
}
