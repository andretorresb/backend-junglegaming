import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { HealthController } from './interfaces/http/health/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [HealthController],
})
export class AppModule {}
