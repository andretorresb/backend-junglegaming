import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOMAIN_DIR = join(import.meta.dir, '../../../src/domain');

/** Imports proibidos no domínio: frameworks, ORM, driver de banco e SDK AWS. */
const FORBIDDEN_IMPORTS = [/from ['"]@nestjs\//, /from ['"]@mikro-orm\//, /from ['"]pg['"]/, /from ['"]@aws-sdk\//, /from ['"]typeorm['"]/];

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listTsFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('Arquitetura — src/domain é puro', () => {
  const files = listTsFiles(DOMAIN_DIR);

  it('encontra arquivos de domínio', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${relative(DOMAIN_DIR, file)} não importa framework, ORM ou SDK`, () => {
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }

  it('nenhum arquivo de domínio usa number para valores monetários', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\b(amount|balance\w*|money\w*)\s*:\s*number\b/i);
    }
  });
});
