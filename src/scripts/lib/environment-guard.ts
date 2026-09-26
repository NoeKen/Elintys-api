/**
 * environment-guard.ts — garde d'environnement partagée des scripts opérationnels.
 *
 * Deux contrats coexistent :
 *
 * 1. Contrat historique (dev uniquement) — `assertEnvironmentGuards` :
 *    `ELINTYS_ENV === 'dev'` ET base connectée `elintys-dev`. Conservé tel quel
 *    pour les scripts de vérification de concurrence et ré-exporté depuis
 *    `migrate-sprint3-wave4-indexes.ts` pour la compatibilité.
 *
 * 2. Contrat explicite (migrations, backup, seed/reset UAT) —
 *    `resolveGuardedTarget` :
 *      - `--environment=<dev|uat|prod>` obligatoire et égal à `ELINTYS_ENV` ;
 *      - base attendue : dev → `elintys-dev`, uat → `elintys-uat` ;
 *      - toute écriture exige un chemin de backup ;
 *      - prod est BLOQUÉ sauf si TOUTES les confirmations sont réunies :
 *        `--environment=prod`, `ELINTYS_ENV=prod`,
 *        `--confirm-database=<nom exact>`,
 *        `ELINTYS_ALLOW_PRODUCTION_MIGRATION=I_HAVE_A_VERIFIED_BACKUP`,
 *        un chemin de backup, et un nom de base sans `dev|uat|test`.
 *
 * Aucune fonction de ce module ne lit ni n'affiche l'URI complète : seul
 * l'hôte du cluster (sans identifiants) et le nom de base sont exposés.
 */

export class ScriptGuardError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ScriptGuardError';
  }
}

// ── Contrat historique (dev uniquement) ─────────────────────────────────────

export const REQUIRED_ELINTYS_ENV = 'dev';
export const REQUIRED_DB_NAME = 'elintys-dev';

export function assertEnvironmentGuards(
  elintysEnv: string | undefined,
  dbName: string | undefined,
): void {
  if (elintysEnv !== REQUIRED_ELINTYS_ENV) {
    throw new Error(
      `ENV_GUARD_FAILED: ELINTYS_ENV doit être exactement '${REQUIRED_ELINTYS_ENV}' (reçu: '${elintysEnv ?? 'undefined'}')`,
    );
  }
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `DB_GUARD_FAILED: la base connectée doit être exactement '${REQUIRED_DB_NAME}' (reçu: '${dbName ?? 'undefined'}')`,
    );
  }
}

// ── Contrat explicite ───────────────────────────────────────────────────────

export const TARGET_ENVIRONMENTS = ['dev', 'uat', 'prod'] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

export const ENVIRONMENT_DATABASES: Readonly<Record<Exclude<TargetEnvironment, 'prod'>, string>> = {
  dev: 'elintys-dev',
  uat: 'elintys-uat',
};

export const UAT_DATABASE_NAME = ENVIRONMENT_DATABASES.uat;
export const PRODUCTION_ACK_ENV = 'ELINTYS_ALLOW_PRODUCTION_MIGRATION';
export const PRODUCTION_ACK_VALUE = 'I_HAVE_A_VERIFIED_BACKUP';

/** Un nom de base de production ne doit jamais ressembler à un environnement de test. */
const NON_PRODUCTION_DATABASE_MARKER = /dev|uat|test/i;

export interface GuardedTarget {
  readonly environment: TargetEnvironment;
  readonly databaseName: string;
  /** Vrai uniquement si la garde production complète a été franchie. */
  readonly productionConfirmed: boolean;
}

export interface GuardInput {
  cliEnvironment: string | undefined;
  elintysEnv: string | undefined;
  databaseName: string | undefined;
  /** Vrai pour --apply, --rollback, reset : toute opération qui écrit. */
  writes: boolean;
  backupPath: string | undefined;
  confirmDatabase: string | undefined;
  productionAck: string | undefined;
}

function isTargetEnvironment(value: string): value is TargetEnvironment {
  return (TARGET_ENVIRONMENTS as readonly string[]).includes(value);
}

export function resolveGuardedTarget(input: GuardInput): GuardedTarget {
  const { cliEnvironment, elintysEnv, databaseName, writes, backupPath, confirmDatabase } = input;

  if (!cliEnvironment) {
    throw new ScriptGuardError('ENVIRONMENT_FLAG_REQUIRED', '--environment=<dev|uat|prod> est obligatoire');
  }
  if (!isTargetEnvironment(cliEnvironment)) {
    throw new ScriptGuardError('ENVIRONMENT_FLAG_INVALID', `--environment doit valoir dev, uat ou prod (reçu '${cliEnvironment}')`);
  }
  if (elintysEnv !== cliEnvironment) {
    throw new ScriptGuardError(
      'ENVIRONMENT_MISMATCH',
      `--environment=${cliEnvironment} mais ELINTYS_ENV='${elintysEnv ?? 'undefined'}'`,
    );
  }
  if (!databaseName) {
    throw new ScriptGuardError('DATABASE_NAME_MISSING', "MONGODB_URI doit nommer explicitement la base (…/<nom>?…)");
  }
  if (confirmDatabase !== undefined && confirmDatabase !== databaseName) {
    throw new ScriptGuardError(
      'CONFIRM_DATABASE_MISMATCH',
      `--confirm-database='${confirmDatabase}' ne correspond pas à la base ciblée '${databaseName}'`,
    );
  }

  if (cliEnvironment === 'prod') {
    if (input.productionAck !== PRODUCTION_ACK_VALUE) {
      throw new ScriptGuardError(
        'PRODUCTION_ACK_REQUIRED',
        `${PRODUCTION_ACK_ENV}=${PRODUCTION_ACK_VALUE} est requis pour toute opération en production`,
      );
    }
    if (confirmDatabase === undefined) {
      throw new ScriptGuardError(
        'PRODUCTION_CONFIRM_DATABASE_REQUIRED',
        '--confirm-database=<nom exact de la base> est requis en production',
      );
    }
    if (NON_PRODUCTION_DATABASE_MARKER.test(databaseName)) {
      throw new ScriptGuardError(
        'PRODUCTION_DATABASE_NAME_FORBIDDEN',
        `la base de production ne peut pas contenir dev, uat ou test (reçu '${databaseName}')`,
      );
    }
    if (!backupPath) {
      throw new ScriptGuardError('PRODUCTION_BACKUP_PATH_REQUIRED', '--backup-path=<dir> est requis en production');
    }
    return { environment: 'prod', databaseName, productionConfirmed: true };
  }

  const expected = ENVIRONMENT_DATABASES[cliEnvironment];
  if (databaseName !== expected) {
    throw new ScriptGuardError(
      'DATABASE_MISMATCH',
      `environnement ${cliEnvironment} → base attendue '${expected}' (reçu '${databaseName}')`,
    );
  }
  if (writes && !backupPath) {
    throw new ScriptGuardError('BACKUP_PATH_REQUIRED', '--backup-path=<dir> est obligatoire avec --apply/--rollback');
  }
  return { environment: cliEnvironment, databaseName, productionConfirmed: false };
}

/** Deuxième garde, après connexion : la base réellement ouverte doit être la cible. */
export function assertConnectedDatabase(target: GuardedTarget, connectedName: string | undefined): void {
  if (connectedName !== target.databaseName) {
    throw new ScriptGuardError(
      'CONNECTED_DATABASE_MISMATCH',
      `base connectée '${connectedName ?? 'undefined'}' ≠ cible '${target.databaseName}'`,
    );
  }
}

/**
 * Garde stricte des scripts UAT (seed/reset) : UAT et UNIQUEMENT `elintys-uat`.
 * Refuse explicitement tout nom contenant `prod`, même si ELINTYS_ENV=uat.
 */
export function assertUatTarget(elintysEnv: string | undefined, databaseName: string | undefined): GuardedTarget {
  if (databaseName && /prod/i.test(databaseName)) {
    throw new ScriptGuardError('PRODUCTION_DATABASE_REFUSED', `base '${databaseName}' refusée`);
  }
  if (elintysEnv !== 'uat') {
    throw new ScriptGuardError('UAT_ENVIRONMENT_REQUIRED', `ELINTYS_ENV doit valoir 'uat' (reçu '${elintysEnv ?? 'undefined'}')`);
  }
  if (databaseName !== UAT_DATABASE_NAME) {
    throw new ScriptGuardError(
      'UAT_DATABASE_REQUIRED',
      `la base doit être exactement '${UAT_DATABASE_NAME}' (reçu '${databaseName ?? 'undefined'}')`,
    );
  }
  return { environment: 'uat', databaseName, productionConfirmed: false };
}

// ── Description sûre de l'URI ───────────────────────────────────────────────

export interface MongoTargetDescription {
  /** Hôte(s) du cluster, SANS identifiants ni paramètres. */
  clusterHost: string;
  databaseName: string | undefined;
}

const MONGO_URI_PATTERN = /^mongodb(?:\+srv)?:\/\/(?:[^/?#]*@)?([^/?#]+)(?:\/([^?#]*))?/;

export function describeMongoUri(uri: string): MongoTargetDescription {
  const match = MONGO_URI_PATTERN.exec(uri);
  if (!match) {
    throw new ScriptGuardError('MONGODB_URI_INVALID', 'schéma mongodb:// ou mongodb+srv:// attendu');
  }
  let databaseName: string | undefined;
  try {
    databaseName = match[2] ? decodeURIComponent(match[2]) : undefined;
  } catch {
    throw new ScriptGuardError('MONGODB_URI_INVALID', 'nom de base mal encodé');
  }
  return { clusterHost: match[1], databaseName: databaseName || undefined };
}

// ── Messages d'erreur imprimables ───────────────────────────────────────────

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const SAFE_CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,80}):/;

/**
 * Transforme une erreur en texte imprimable sans risque : nos gardes sont
 * affichées en entier ; pour toute autre erreur (driver MongoDB, réseau), on
 * n'imprime que le code en tête de message, jamais le reste (hôtes, URI…).
 */
export function formatSafeError(error: unknown): string {
  if (error instanceof ScriptGuardError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (SAFE_CODE.test(message)) return message;
  const prefixed = SAFE_CODE_PREFIX.exec(message);
  return prefixed ? prefixed[1] : 'DATABASE_OR_UNEXPECTED_ERROR';
}
