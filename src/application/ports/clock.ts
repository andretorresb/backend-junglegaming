/** Relógio injetável. Domínio e aplicação nunca chamam `new Date()` diretamente. */
export interface Clock {
  now(): Date;
}
