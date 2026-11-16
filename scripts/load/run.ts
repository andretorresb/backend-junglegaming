/**
 * Teste de carga (diferencial da seção 14 do enunciado). Uso: bun run test:load
 *
 * Pré-requisitos: docker compose up -d && bun run localstack:init
 *
 * O que faz:
 *   1. prepara um banco dedicado (junglegaming_load), aplica migrations e limpa os dados;
 *   2. sobe N processos da aplicação (padrão 3), com o publisher da outbox ligado;
 *   3. cria wallets pela API e roda cada cenário com usuários virtuais em laço fechado;
 *   4. mede latência, status, conflitos de lock e lag da outbox;
 *   5. depois da carga, espera a outbox drenar e verifica saldo == ledger em todas as wallets.
 *
 * Parâmetros (variáveis de ambiente): LOAD_PROCESSES, LOAD_VUS, LOAD_DURATION_S, LOAD_WARMUP_S,
 * LOAD_WALLETS, LOAD_DUPLICATE_RATIO. O resultado vai para stdout (markdown) e para
 * docs/load-test-results.json.
 */
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { loadEnv } from '../../src/config/env';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueSettingsFromEnv, queueUrl } from '../../src/infrastructure/messaging/queues';

const DB_NAME = 'junglegaming_load';
const PROCESSES = int('LOAD_PROCESSES', 3);
const VUS = int('LOAD_VUS', 64);
const DURATION_S = int('LOAD_DURATION_S', 30);
const WARMUP_S = int('LOAD_WARMUP_S', 5);
const WALLETS = int('LOAD_WALLETS', 100);
const DUPLICATE_RATIO = Number(process.env['LOAD_DUPLICATE_RATIO'] ?? '0.05');
const BASE_PORT = 5100;
const ROOT = new URL('../../', import.meta.url).pathname;

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
}

// ---------------------------------------------------------------------------
// Infraestrutura
// ---------------------------------------------------------------------------

const env = loadEnv();
const pgConn = { host: env.database.host, port: env.database.port, user: env.database.user, password: env.database.password };

async function prepareDatabase(): Promise<Client> {
  const admin = new Client({ ...pgConn, database: 'postgres' });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();

  const orm = await MikroORM.init({ ...config, dbName: DB_NAME });
  await orm.getMigrator().up();
  await orm.close();

  const client = new Client({ ...pgConn, database: DB_NAME });
  await client.connect();
  await client.query('TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages CASCADE');
  return client;
}

interface AppProcess {
  base: string;
  stop(): Promise<void>;
}

async function startProcess(port: number): Promise<AppProcess> {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_NAME,
      WAGER_CONSUMER_ENABLED: '0',
      PENDING_REFERENCE_POLL_MS: '0',
      OUTBOX_POLL_MS: '200',
      OUTBOX_BATCH_SIZE: '100',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`${base}/health/live`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`processo na porta ${port} não subiu`);
    await sleep(200);
  }
  return {
    base,
    stop: async () => {
      proc.kill('SIGTERM');
      await proc.exited;
    },
  };
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

interface Wallet {
  walletId: string;
  playerId: string;
}

interface Sample {
  ms: number;
  status: number;
  replay: boolean;
}

interface ScenarioResult {
  name: string;
  description: string;
  vus: number;
  durationS: number;
  requests: number;
  throughput: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  status: Record<string, number>;
  replays: number;
  errorRate: number;
  conflictRate: number;
  businessRejections: number;
  lockConflicts: number;
  outbox: { maxLagS: number; pendingAtEnd: number; drainS: number };
  consistency: { walletsChecked: number; inconsistent: number };
}

async function createWallets(procs: AppProcess[], count: number, balance: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let i = 0; i < count; i++) {
    const playerId = randomUUID();
    const res = await fetch(`${procs[i % procs.length]!.base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
    });
    const body = (await res.json()) as { id: string };
    wallets.push({ walletId: body.id, playerId });
  }
  return wallets;
}

/** Corpo de uma operação: 60% BET, 30% WIN, 10% LOSS, valores pequenos para não esgotar o saldo. */
function operation(wallet: Wallet): { key: string; body: string } {
  const r = Math.random();
  const kind = r < 0.6 ? 'BET' : r < 0.9 ? 'WIN' : 'LOSS';
  const ext = `load-${randomUUID()}`;
  const amount = (1 + Math.floor(Math.random() * 10)).toFixed(2);
  return {
    key: `provider-load:${ext}`,
    body: JSON.stringify({
      providerId: 'provider-load',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: `round-${Math.floor(Math.random() * 1000)}`,
      gameId: 'load-game',
      kind,
      money: { amount, currency: 'BRL' },
    }),
  };
}

async function scrapeMetric(procs: AppProcess[], name: string, reduce: 'sum' | 'max'): Promise<number> {
  const values = await Promise.all(
    procs.map(async (p) => {
      const text = await fetch(`${p.base}/metrics`).then((r) => r.text()).catch(() => '');
      const line = text.split('\n').find((l) => l.startsWith(`${name} `));
      return line ? Number(line.split(' ')[1]) : 0;
    }),
  );
  return reduce === 'sum' ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
}

async function runScenario(
  name: string,
  description: string,
  procs: AppProcess[],
  wallets: Wallet[],
  db: Client,
): Promise<ScenarioResult> {
  const samples: Sample[] = [];
  const sent: Array<{ key: string; body: string }> = [];
  let measuring = false;
  let stop = false;
  const lockBefore = await scrapeMetric(procs, 'lock_conflicts_total', 'sum');

  // amostragem do lag da outbox a cada segundo, durante a janela medida
  let maxLag = 0;
  const lagSampler = (async () => {
    while (!stop) {
      if (measuring) maxLag = Math.max(maxLag, await scrapeMetric(procs, 'outbox_lag_seconds', 'max'));
      await sleep(1000);
    }
  })();

  const vu = async (id: number) => {
    let i = id;
    while (!stop) {
      const proc = procs[i % procs.length]!;
      const duplicate = sent.length > 0 && Math.random() < DUPLICATE_RATIO;
      const op = duplicate ? sent[Math.floor(Math.random() * sent.length)]! : operation(wallets[Math.floor(Math.random() * wallets.length)]!);
      const started = performance.now();
      let status = 0;
      let replay = false;
      try {
        const res = await fetch(`${proc.base}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': op.key },
          body: op.body,
        });
        status = res.status;
        const body = (await res.json().catch(() => ({}))) as { idempotentReplay?: boolean };
        replay = body.idempotentReplay === true;
      } catch {
        status = -1; // erro de rede
      }
      const ms = performance.now() - started;
      if (measuring) samples.push({ ms, status, replay });
      if (!duplicate && sent.length < 5000) sent.push(op);
      i += 1;
    }
  };

  const runners = Array.from({ length: VUS }, (_, id) => vu(id));
  await sleep(WARMUP_S * 1000);
  measuring = true;
  const measureStart = performance.now();
  await sleep(DURATION_S * 1000);
  measuring = false;
  const elapsedS = (performance.now() - measureStart) / 1000;
  stop = true;
  await Promise.all(runners);
  await lagSampler;

  const lockAfter = await scrapeMetric(procs, 'lock_conflicts_total', 'sum');

  // drenagem da outbox depois da carga
  const pendingAtEnd = await pendingOutbox(db);
  const drainStart = performance.now();
  while ((await pendingOutbox(db)) > 0 && performance.now() - drainStart < 120_000) await sleep(250);
  const drainS = (performance.now() - drainStart) / 1000;

  const consistency = await checkConsistency(db, wallets);
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const status: Record<string, number> = {};
  for (const s of samples) status[String(s.status)] = (status[String(s.status)] ?? 0) + 1;
  const count = (pred: (code: number) => boolean) => samples.filter((s) => pred(s.status)).length;
  // erro = rede, 5xx exceto 503 (conflito transitório, contado à parte) e 4xx exceto 422 (rejeição de negócio).
  // 409 conta como erro: as repetições reenviam o mesmo corpo, então um conflito indicaria defeito.
  const errors = count((c) => c === -1 || (c >= 500 && c !== 503) || (c >= 400 && c < 500 && c !== 422));

  return {
    name,
    description,
    vus: VUS,
    durationS: Math.round(elapsedS),
    requests: samples.length,
    throughput: round(samples.length / elapsedS),
    latencyMs: {
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99)),
      max: round(latencies[latencies.length - 1] ?? 0),
      mean: round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)),
    },
    status,
    replays: samples.filter((s) => s.replay).length,
    errorRate: round((errors / Math.max(1, samples.length)) * 100, 3),
    conflictRate: round((count((c) => c === 503) / Math.max(1, samples.length)) * 100, 3),
    businessRejections: count((c) => c === 422),
    lockConflicts: lockAfter - lockBefore,
    outbox: { maxLagS: round(maxLag), pendingAtEnd, drainS: round(drainS) },
    consistency,
  };
}

async function pendingOutbox(db: Client): Promise<number> {
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL');
  return Number(r.rows[0]?.n ?? 0);
}

/** Saldo armazenado == soma do ledger, para cada wallet do cenário. */
async function checkConsistency(db: Client, wallets: Wallet[]): Promise<{ walletsChecked: number; inconsistent: number }> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT w.id
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id, w.balance
       HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
     ) AS diverging`,
    [wallets.map((w) => w.walletId)],
  );
  return { walletsChecked: wallets.length, inconsistent: Number(r.rows[0]?.n ?? 0) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const sqs = createSqsClient(env);
await ensureQueues(sqs, queueSettingsFromEnv(env));
await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(sqs, env.outbox.queueName) })).catch(() => undefined);

const db = await prepareDatabase();
const procs: AppProcess[] = [];
for (let i = 0; i < PROCESSES; i++) procs.push(await startProcess(BASE_PORT + i));

try {
  const distributedWallets = await createWallets(procs, WALLETS, '1000000.00');
  const hotWallet = await createWallets(procs, 1, '100000000.00');

  const results = [
    await runScenario('distributed', `${WALLETS} wallets, operações aleatórias distribuídas`, procs, distributedWallets, db),
    await runScenario('hot-wallet', '1 wallet recebendo todas as operações (pior caso do lock por wallet)', procs, hotWallet, db),
  ];

  const environment = {
    machine: `${cpus()[0]?.model ?? 'desconhecido'} · ${cpus().length} núcleos · ${round(totalmem() / 1024 ** 3)} GB`,
    os: `${platform()} ${release()}`,
    bun: Bun.version,
    postgres: (await db.query<{ v: string }>('SHOW server_version')).rows[0]?.v ?? '?',
    processes: PROCESSES,
    vus: VUS,
    warmupS: WARMUP_S,
    durationS: DURATION_S,
    duplicateRatio: DUPLICATE_RATIO,
    generator: 'mesmo host da aplicação e do banco (Bun fetch, laço fechado)',
  };

  writeFileSync(`${ROOT}docs/load-test-results.json`, `${JSON.stringify({ environment, results, ranAt: new Date().toISOString() }, null, 2)}\n`);

  console.log('\n## Ambiente');
  console.log(JSON.stringify(environment, null, 2));
  console.log('\n## Resultados');
  console.log('| Cenário | Req | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro % | 503 % | 422 | Replays | Lock conflicts | Lag máx s | Drenagem s | Wallets inconsistentes |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.requests} | ${r.throughput} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.errorRate} | ${r.conflictRate} | ${r.businessRejections} | ${r.replays} | ${r.lockConflicts} | ${r.outbox.maxLagS} | ${r.outbox.drainS} | ${r.consistency.inconsistent}/${r.consistency.walletsChecked} |`,
    );
  }
  for (const r of results) console.log(`status ${r.name}: ${JSON.stringify(r.status)}`);
} finally {
  for (const p of procs) await p.stop();
  await db.end();
  // não deixa os eventos da carga na fila de eventos (os testes de integração drenam essa fila)
  await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(sqs, env.outbox.queueName) })).catch(() => undefined);
  sqs.destroy();
}
