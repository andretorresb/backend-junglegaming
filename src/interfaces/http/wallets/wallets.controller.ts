import { Body, Controller, Inject, Post, HttpCode } from '@nestjs/common';
import { IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { OpenWallet } from '../../../application/wallets/open-wallet.use-case';
import { MoneyDto } from '../wagering/wagering.dto';
import { OPEN_WALLET } from '../wagering/wagering.tokens';
import { randomUUID } from 'node:crypto';

class OpenWalletDto {
  @IsUUID('all')
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

@Controller('wallets')
export class WalletController {
  constructor(@Inject(OPEN_WALLET) private readonly openWallet: OpenWallet) {}

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
}
