/**
 * Preload da suíte. Desliga os agendadores automáticos da aplicação: os testes dirigem
 * workers, publisher e consumidor diretamente, para que o momento de cada efeito seja determinístico.
 */
const defaults: Record<string, string> = {
  PENDING_REFERENCE_POLL_MS: '0',
  OUTBOX_POLL_MS: '0',
  WAGER_CONSUMER_ENABLED: '0',
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
