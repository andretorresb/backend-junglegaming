export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<unknown>;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, 'up' | 'down'>;
  errors?: Record<string, string>;
}

/**
 * Executa as dependências em paralelo, cada uma com timeout curto.
 * Qualquer falha torna o processo não pronto (503), com o detalhe por dependência.
 */
export class ReadinessChecker {
  constructor(
    private readonly checks: readonly ReadinessCheck[],
    /** 3s: a primeira chamada a uma dependência fria (pool, SDK) pode passar de 2s. */
    private readonly timeoutMs = 3000,
    /** Motivo da falha vai para o log, nunca para a resposta HTTP. */
    private readonly onFailure: (name: string, reason: string) => void = () => undefined,
  ) {}

  async run(): Promise<ReadinessReport> {
    const results = await Promise.all(this.checks.map((c) => this.runOne(c)));
    const checks: Record<string, 'up' | 'down'> = {};
    const errors: Record<string, string> = {};
    for (const result of results) {
      checks[result.name] = result.error === undefined ? 'up' : 'down';
      if (result.error !== undefined) {
        errors[result.name] = result.error;
        this.onFailure(result.name, result.error);
      }
    }
    const ok = Object.keys(errors).length === 0;
    return ok ? { ok, checks } : { ok, checks, errors };
  }

  private async runOne(check: ReadinessCheck): Promise<{ name: string; error?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check.check(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout após ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
      return { name: check.name };
    } catch (error) {
      return { name: check.name, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
