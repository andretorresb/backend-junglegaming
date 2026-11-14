import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { HealthController } from './interfaces/http/health/health.controller';
import { WagerModule } from './interfaces/http/wagering/wagering.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WagerModule],
  controllers: [HealthController],
})
export class AppModule {}
