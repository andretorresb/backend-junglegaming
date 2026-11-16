import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (seção 2 do enunciado).
 *
 * Decisão registrada em ARCHITECTURE.md: esta etapa não integra um IdP. O guard é um no-op
 * que deixa passar todas as requisições. A troca por validação real de token (Keycloak ou
 * Zitadel) acontece aqui, sem mudar os controllers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
