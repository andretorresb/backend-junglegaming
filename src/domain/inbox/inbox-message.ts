export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | undefined;
}

/**
 * Registro de deduplicação de mensagens recebidas (seção 6.5 do enunciado).
 * Chave: (consumerName, messageId). Gravado na mesma transação do efeito de negócio.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; receivedAt: Date }): InboxMessage {
    if (props.messageId.trim() === '' || props.consumerName.trim() === '') {
      throw new Error('messageId e consumerName são obrigatórios');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new Error(`mensagem ${this.messageId} já marcada como processada`);
    }
    this._processedAt = at;
  }
}
