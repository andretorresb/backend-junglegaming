import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadEnv } from './src/config/env';

const env = loadEnv();

/**
 * Configuração do MikroORM (usada pela aplicação e pela CLI `mikro-orm`).
 * Entidades de persistência serão adicionadas na Etapa 2.
 */
export default defineConfig({
  host: env.database.host,
  port: env.database.port,
  user: env.database.user,
  password: env.database.password,
  dbName: env.database.name,
  entities: [],
  entitiesTs: ['src/**/*.entity.ts'],
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
  debug: false,
  strict: true,
});
