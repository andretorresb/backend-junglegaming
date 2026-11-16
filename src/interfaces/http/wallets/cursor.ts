import { BadRequestException } from '@nestjs/common';

/**
 * Cursor opaco do ledger: base64url de JSON com a posição do último item entregue.
 * O cliente não deve interpretá-lo. Cursor malformado ou adulterado é 400.
 */
export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): LedgerCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const candidate = parsed as { t?: unknown; i?: unknown };
  if (typeof candidate.t !== 'string' || typeof candidate.i !== 'string' || !UUID.test(candidate.i)) {
    throw invalidCursor();
  }
  const createdAt = new Date(candidate.t);
  if (Number.isNaN(createdAt.getTime())) throw invalidCursor();
  return { createdAt, id: candidate.i };
}

function invalidCursor(): BadRequestException {
  return new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'cursor inválido' });
}
