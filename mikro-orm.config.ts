import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadEnv } from './src/config/env';
import { PERSISTENCE_ENTITIES } from './src/infrastructure/persistence/entities/records';

const env = loadEnv();

/**
 * Configuração do MikroORM (usada pela aplicação e pela CLI `mikro-orm`).
 */
export default defineConfig({
  host: env.database.host,
  port: env.database.port,
  user: env.database.user,
  password: env.database.password,
  dbName: env.database.name,
  entities: PERSISTENCE_ENTITIES,
  discovery: { warnWhenNoEntities: true },
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
