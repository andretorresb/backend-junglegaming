import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, validate, ValidateNested } from 'class-validator';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction';

/** Mensagem da fila `wager-transactions.fifo` (seção 10 do enunciado). */
class MoneyBody {
  @IsString()
  @Matches(/^-?\d+(\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

class WagerRequestedData {
  @IsString() @IsNotEmpty() providerId!: string;
  @IsString() @IsNotEmpty() externalTransactionId!: string;
  @IsString() @IsNotEmpty() idempotencyKey!: string;
  @IsUUID('all') playerId!: string;
  @IsUUID('all') walletId!: string;
  @IsString() @IsNotEmpty() roundId!: string;
  @IsString() @IsNotEmpty() gameId!: string;
  @IsEnum(WagerTransactionKind) kind!: WagerTransactionKind;
  @ValidateNested() @Type(() => MoneyBody) money!: MoneyBody;
  /** Obrigatório para REFUND e ROLLBACK. Extensão do corpo do enunciado para as reversões. */
  @IsOptional() @IsString() referenceExternalTransactionId?: string;
}

class WagerRequestedMessage {
  @IsString() @IsNotEmpty() messageId!: string;
  @IsIn(['WagerTransactionRequested']) type!: string;
  @IsISO8601() occurredAt!: string;
  @ValidateNested() @Type(() => WagerRequestedData) data!: WagerRequestedData;
}

export type ParsedWagerMessage = {
  messageId: string;
  data: WagerRequestedData;
};

export type ParseResult = { ok: true; value: ParsedWagerMessage } | { ok: false; reason: string };

/** Valida o corpo. Qualquer problema de formato é erro permanente (vai para a DLQ). */
export async function parseWagerMessage(body: string): Promise<ParseResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'corpo não é JSON' };
  }
  const message = plainToInstance(WagerRequestedMessage, raw);
  const errors = await validate(message, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    return { ok: false, reason: `schema inválido: ${errors.map((e) => e.property).join(', ')}` };
  }
  return { ok: true, value: { messageId: message.messageId, data: message.data } };
}

/** Grupo FIFO: uma wallet por grupo, para que operações da mesma wallet fiquem em ordem. */
export function groupIdOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { data?: { walletId?: unknown } };
    const walletId = parsed.data?.walletId;
    return typeof walletId === 'string' && walletId !== '' ? walletId : 'invalid';
  } catch {
    return 'invalid';
  }
}
