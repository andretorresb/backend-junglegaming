import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { OpenWallet } from '../../../application/wallets/open-wallet.use-case';
import type { WalletQueries } from '../../../infrastructure/persistence/wallet.queries';
import { MoneyDto } from '../wagering/wagering.dto';
import { OPEN_WALLET, WALLET_QUERIES } from '../wagering/wagering.tokens';
import { decodeCursor, encodeCursor } from './cursor';

class OpenWalletDto {
  @IsUUID('all')
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWallet,
    @Inject(WALLET_QUERIES) private readonly queries: WalletQueries,
  ) {}

  /** 201 com a wallet criada. Saldo inicial > 0 gera OPENING e lançamento CREDIT. */
  @Post()
  @HttpCode(201)
  async open(@Body() dto: OpenWalletDto) {
    return this.openWallet.execute({
      playerId: dto.playerId,
      initialBalance: { amount: dto.initialBalance.amount, currency: dto.initialBalance.currency },
      correlationId: randomUUID(),
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.findWallet(requireUuid(walletId));
    if (!wallet) throw new NotFoundException({ code: 'NOT_FOUND', message: 'wallet não encontrada' });
    return wallet;
  }

  /** Ledger em ordem cronológica. `nextCursor` é null na última página. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const size = parseLimit(limit);
    const after = decodeCursor(cursor);
    const page = await this.queries.listLedger(requireUuid(walletId), after, size);
    if (!page) throw new NotFoundException({ code: 'NOT_FOUND', message: 'wallet não encontrada' });
    return {
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    };
  }

  /**
   * Reconciliação. O servidor calcula os saldos a partir do ledger. Saldos enviados pelo cliente
   * são ignorados: não há corpo nesta rota.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const result = await this.queries.reconcile(requireUuid(walletId));
    if (!result) throw new NotFoundException({ code: 'NOT_FOUND', message: 'wallet não encontrada' });
    return result;
  }
}

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'wallet não encontrada' });
  }
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `limit deve ser inteiro entre 1 e ${MAX_LIMIT}` });
  }
  return value;
}
