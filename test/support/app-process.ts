import { TEST_DB_NAME } from '../integration/helpers/database';

/**
 * Sobe a aplicação como processo separado (`bun src/main.ts`), apontando para o banco de teste.
 * Usado pelos testes que precisam de paralelismo real entre instâncias e de morte de processo.
 */
export interface AppProcess {
  readonly port: number;
  readonly base: string;
  readonly pid: number;
  readonly output: () => string;
  /** Código de saída real do processo. */
  readonly exited: Promise<number>;
  /** SIGTERM: shutdown gracioso. Resolve quando o processo termina. */
  terminate(): Promise<number>;
  /** SIGKILL: morte abrupta, sem chance de limpeza. */
  kill(): Promise<number>;
}

const ROOT = new URL('../../', import.meta.url).pathname;

export interface StartOptions {
  /** false: não espera o `live`. Usado quando o processo deve morrer durante o boot (falha injetada). */
  awaitLive?: boolean;
}

export async function startAppProcess(port: number, env: Record<string, string> = {}, options: StartOptions = {}): Promise<AppProcess> {
  const chunks: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_NAME: TEST_DB_NAME,
      WAGER_CONSUMER_ENABLED: '0',
      PENDING_REFERENCE_POLL_MS: '0',
      OUTBOX_POLL_MS: '0',
      SHUTDOWN_GRACE_MS: '3000',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void drain(proc.stdout, chunks);
  void drain(proc.stderr, chunks);

  const base = `http://127.0.0.1:${port}`;
  if (options.awaitLive !== false) {
    await waitFor(async () => (await fetch(`${base}/health/live`).catch(() => undefined))?.status === 200, 30_000, () => chunks.join(''));
  }

  return {
    port,
    base,
    pid: proc.pid,
    output: () => chunks.join(''),
    exited: proc.exited,
    terminate: async () => {
      proc.kill('SIGTERM');
      return proc.exited;
    },
    kill: async () => {
      proc.kill('SIGKILL');
      return proc.exited;
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array> | null | undefined, into: string[]): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    into.push(decoder.decode(value));
  }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, diagnostics: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condição não atingida em ${timeoutMs}ms. Saída do processo:\n${diagnostics().slice(-2000)}`);
}

/** Porta livre aleatória na faixa de testes. */
export function randomPort(): number {
  return 4000 + Math.floor(Math.random() * 2000);
}
