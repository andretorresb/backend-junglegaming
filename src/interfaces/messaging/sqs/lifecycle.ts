/** Estado de ciclo de vida compartilhado. `draining` fica verdadeiro durante o shutdown. */
export interface ConsumerLifecycle {
  draining: boolean;
}
