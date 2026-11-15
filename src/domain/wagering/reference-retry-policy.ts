/**
 * Política de espera por referências ausentes (seção 7.1 do enunciado).
 * Funções puras: o relógio e o jitter entram por parâmetro, então são testáveis sem tempo real.
 */
export interface ReferenceRetryPolicy {
  /** Atraso da primeira tentativa de reprocessamento, antes do jitter. */
  readonly baseDelayMs: number;
  /** Teto do backoff exponencial. */
  readonly maxDelayMs: number;
  /** Número de consultas à referência antes de desistir. */
  readonly maxAttempts: number;
  /** Tempo máximo desde a chegada da transação pendente. */
  readonly ttlMs: number;
}

/**
 * Valores padrão e justificativa (documentada em ARCHITECTURE.md):
 * - base 1s com fator 2 e teto 5 min: a reversão chega normalmente em segundos ou minutos
 *   após a aposta original; as primeiras tentativas são rápidas, as seguintes espaçam a carga;
 * - 10 tentativas: cobrem cerca de 25 min com o backoff acima;
 * - TTL de 24h: limita o tempo de vida de uma transação pendente, mesmo que o limite de
 *   tentativas não seja atingido (ex.: worker parado por muito tempo).
 */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxAttempts: 10,
  ttlMs: 24 * 60 * 60 * 1_000,
};

/**
 * Atraso até a próxima tentativa: min(teto, base × 2^tentativas), com jitter.
 * `jitter` em [0, 1]: 1 devolve o atraso cheio; 0 devolve metade. O jitter espalha
 * os reprocessamentos de muitas transações que chegaram juntas.
 */
export function nextAttemptDelayMs(attempts: number, policy: ReferenceRetryPolicy, jitter: number): number {
  const clampedJitter = Math.min(1, Math.max(0, jitter));
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempts);
  return Math.round(exponential * (0.5 + 0.5 * clampedJitter));
}

/** Desiste quando esgota as tentativas ou o TTL desde a chegada. */
export function isReferenceWaitExhausted(
  attempts: number,
  arrivedAt: Date,
  now: Date,
  policy: ReferenceRetryPolicy,
): boolean {
  return attempts >= policy.maxAttempts || now.getTime() - arrivedAt.getTime() >= policy.ttlMs;
}
