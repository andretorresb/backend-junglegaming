import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { JsonNestLogger } from './infrastructure/observability/nest-logger.adapter';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const jsonLogger = new JsonLogger(env.serviceName);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new JsonNestLogger(jsonLogger));
  app.enableShutdownHooks();

  await app.listen(env.port);
  Logger.log(`${env.serviceName} ouvindo na porta ${env.port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Bootstrap');
  process.exit(1);
});
