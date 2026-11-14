/**
 * Runner de migrations via API programática do MikroORM.
 *
 * Uso:
 *   bun scripts/migrate.ts up               # aplica pendentes
 *   bun scripts/migrate.ts down             # reverte a última
 *   bun scripts/migrate.ts reset            # reverte todas
 *   bun scripts/migrate.ts status           # lista executadas e pendentes
 *   bun scripts/migrate.ts create <nome>    # cria arquivo de migration vazio
 *
 * Por que não a CLI `mikro-orm`: na v6, com config em TypeScript executado pelo Bun,
 * `migration:up` termina com código 0 sem aplicar nada (migrations não descobertas).
 */
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

const [command = 'status', ...rest] = process.argv.slice(2);

const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const done = await migrator.up();
      console.log(`aplicadas: ${done.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'down': {
      const done = await migrator.down();
      console.log(`revertidas: ${done.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'reset': {
      const done = await migrator.down({ to: 0 });
      console.log(`revertidas: ${done.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'status': {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(`executadas: ${executed.map((m) => m.name).join(', ') || 'nenhuma'}`);
      console.log(`pendentes:  ${pending.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'create': {
      const name = rest[0];
      if (!name) throw new Error('informe o nome: bun scripts/migrate.ts create <nome>');
      const file = await migrator.createMigration(undefined, false, false, name);
      console.log(`criada: ${file.fileName}`);
      break;
    }
    default:
      throw new Error(`comando desconhecido: ${command}`);
  }
} finally {
  await orm.close();
}
