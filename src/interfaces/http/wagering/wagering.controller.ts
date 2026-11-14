import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ProcessWagerTransaction } from '../../../application/wagering/process-wager-transaction.use-case';
import type { WagerTransactionQueries } from '../../../infrastructure/persistence/wagering.queries';
import { PROCESS_WAGER_TRANSACTION, WAGER_TRANSACTION_QUERIES } from './wagering.tokens';
import { SubmitWagerTransactionDto } from './wagering.dto';

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

@Controller()
export class WagerController {
  constructor(
    @Inject(PROCESS_WAGER_TRANSACTION) private readonly process: ProcessWagerTransaction,
    @Inject(WAGER_TRANSACTION_QUERIES) private readonly queries: WagerTransactionQueries,
  ) {}

  /**
   * 200 quando a transação foi processada; 422 quando foi rejeitada por regra de negócio.
   * Um replay devolve o mesmo status HTTP da resposta original.
   */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'header Idempotency-Key é obrigatório' });
    }
    if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'Idempotency-Key excede 255 caracteres' });
    }

    const result = await this.process.execute({
      idempotencyKey,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: { amount: dto.money.amount, currency: dto.money.currency },
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      correlationId: idempotencyKey,
    });

    const status = result.status === 'REJECTED' ? 422 : 200;
    res.status(status);
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      failureCode: result.failureCode ?? null,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const view = await this.queries.findById(transactionId);
    if (!view) throw new NotFoundException({ code: 'NOT_FOUND' });
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const view = await this.queries.findByProviderExternalId(providerId, externalTransactionId);
    if (!view) throw new NotFoundException({ code: 'NOT_FOUND' });
    return view;
  }
}
