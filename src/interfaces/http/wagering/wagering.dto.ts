import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction';

/** Formato de contrato: string decimal com até 2 casas, sem notação científica. */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export class MoneyDto {
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: 'amount deve ser string decimal com até 2 casas' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency deve ser ISO-4217 (3 letras maiúsculas)' })
  currency!: string;
}

export class SubmitWagerTransactionDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  providerId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  externalTransactionId!: string;

  @IsUUID('all')
  playerId!: string;

  @IsUUID('all')
  walletId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  roundId!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  referenceExternalTransactionId?: string;
}
