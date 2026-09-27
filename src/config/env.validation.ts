import { Logger } from '@nestjs/common';
import { plainToInstance, Transform } from 'class-transformer';
import { IsIn, IsOptional, Matches, validateSync } from 'class-validator';
import { ENV_FLAG_VALUES, isOptInFlagEnabled, isOptOutFlagEnabled } from './env-flags';
import {
  ELINTYS_ENVIRONMENTS,
  ElintysEnvironment,
  isStrictElintysEnvironment,
  resolveElintysEnvironment,
} from './elintys-environment';

/**
 * Validation fail-fast de l'environnement au démarrage (ConfigModule.forRoot).
 *
 * Principes :
 *  - uat / prod : toute variable requise absente, invalide ou laissée à une
 *    valeur `__SET_ME__…` empêche le démarrage ;
 *  - dev : seuls MONGODB_URI (base `elintys-dev`) et les secrets JWT sont
 *    bloquants, le reste produit des avertissements (le déploiement Render dev
 *    existant ne doit pas casser) ;
 *  - local / ci : permissif, mais jamais de base distante implicite ;
 *  - AUCUNE valeur n'est jamais écrite dans un message : uniquement des NOMS
 *    de variables et la raison du refus.
 */

export const PLACEHOLDER_PREFIX = '__SET_ME__';
export const MIN_JWT_SECRET_LENGTH = 32;
export const UAT_DATABASE_NAME = 'elintys-uat';
export const DEV_DATABASE_NAME = 'elintys-dev';
export const CI_DATABASE_NAME = 'elintys-test';
export const CLOUDINARY_FOLDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const FORBIDDEN_PROD_DATABASE_PATTERN = /dev|uat|test|local/i;
const FORBIDDEN_PROD_FOLDER_PATTERN = /dev|uat|test|local|ci/i;
const LOCAL_HOST_PATTERN =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|[a-z0-9-]+\.localhost)$/i;
/** Hôtes MongoDB considérés locaux (poste, conteneur de service CI, docker). */
const LOCAL_MONGO_HOST_PATTERN =
  /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|mongo|mongodb|host\.docker\.internal)$/i;

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Contraintes de FORMAT, indépendantes de l'environnement. */
export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(ELINTYS_ENVIRONMENTS)
  ELINTYS_ENV?: string;

  @IsOptional()
  // Valeur canonique exacte : même lecture qu'à l'exécution (env-flags.ts).
  @IsIn(ENV_FLAG_VALUES)
  EMAIL_DELIVERY_ENABLED?: string;

  @IsOptional()
  // Valeur canonique exacte : même lecture qu'à l'exécution (env-flags.ts).
  @IsIn(ENV_FLAG_VALUES)
  PAYPAL_PROVIDER_ENABLED?: string;

  @IsOptional()
  @Transform(trimLower)
  @IsIn(['sandbox', 'live'])
  PAYPAL_ENV?: string;

  @IsOptional()
  // Valeur canonique exacte : même lecture qu'à l'exécution (env-flags.ts).
  @IsIn(ENV_FLAG_VALUES)
  PAID_CHECKOUT_ENABLED?: string;

  @IsOptional()
  // Valeur canonique exacte : même lecture qu'à l'exécution (env-flags.ts).
  @IsIn(ENV_FLAG_VALUES)
  TEST_PAYMENT_PROVIDER_ENABLED?: string;

  @IsOptional()
  @Matches(/^\d{1,5}$/)
  PORT?: string;

  @IsOptional()
  @Matches(/^\d{1,2}$/)
  TRUSTED_PROXY_HOPS?: string;

  @IsOptional()
  @Matches(CLOUDINARY_FOLDER_PATTERN)
  CLOUDINARY_FOLDER?: string;
}

export interface EnvironmentFinding {
  variable: string;
  reason: string;
}

export interface EnvironmentReport {
  elintysEnv: ElintysEnvironment | null;
  errors: EnvironmentFinding[];
  warnings: EnvironmentFinding[];
}

type RawEnvironment = Record<string, unknown>;

function readString(env: RawEnvironment, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isPlaceholder(value: string | undefined): boolean {
  return value !== undefined && value.startsWith(PLACEHOLDER_PREFIX);
}

interface ParsedMongoUri {
  srv: boolean;
  hosts: string[];
  databaseName: string;
}

/** Analyse minimale d'une URI MongoDB (multi-hôtes compris), sans la journaliser. */
export function parseMongoUri(uri: string): ParsedMongoUri | null {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(uri);
  if (!match) return null;
  const authority = match[2];
  const hostList = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const hosts = hostList
    .split(',')
    .map((host) => host.trim().replace(/:\d+$/, '').toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) return null;
  let databaseName = '';
  try {
    databaseName = decodeURIComponent((match[3] ?? '').replace(/^\//, ''));
  } catch {
    return null;
  }
  return { srv: match[1] === 'mongodb+srv', hosts, databaseName };
}

function isLocalMongo(parsed: ParsedMongoUri): boolean {
  return !parsed.srv && parsed.hosts.every((host) => LOCAL_MONGO_HOST_PATTERN.test(host));
}

/**
 * Retourne une raison de refus, ou null si la valeur est une origine https
 * publique. Même exigence d'origine exacte que `normalizeAllowedOrigins`
 * (main.ts), qui reçoit FRONTEND_URL et CORS_ORIGINS.
 */
function publicHttpsOriginProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid absolute URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (LOCAL_HOST_PATTERN.test(url.hostname)) return 'must not target localhost or a private network';
  if (url.origin !== value) {
    return 'must be a bare origin (https://host[:port]) without path or trailing slash';
  }
  return null;
}

class Collector {
  readonly errors: EnvironmentFinding[] = [];
  readonly warnings: EnvironmentFinding[] = [];

  add(blocking: boolean, variable: string, reason: string): void {
    (blocking ? this.errors : this.warnings).push({ variable, reason });
  }
}

/**
 * Lit une variable « requise » : l'absence ou un placeholder est signalé
 * (bloquant ou avertissement selon `blocking`). Retourne la valeur utilisable.
 */
function required(
  env: RawEnvironment,
  name: string,
  blocking: boolean,
  out: Collector,
): string | undefined {
  const value = readString(env, name);
  if (value === undefined) {
    out.add(blocking, name, 'is required');
    return undefined;
  }
  if (isPlaceholder(value)) {
    out.add(blocking, name, `is not configured (placeholder ${PLACEHOLDER_PREFIX} value)`);
    return undefined;
  }
  return value;
}

function checkMongo(env: RawEnvironment, elintysEnv: ElintysEnvironment, out: Collector): void {
  // L'URI est indispensable partout : il n'existe AUCUN repli implicite.
  const uri = required(env, 'MONGODB_URI', true, out);
  if (!uri) return;
  const parsed = parseMongoUri(uri);
  if (!parsed) {
    out.add(true, 'MONGODB_URI', 'is not a valid mongodb:// or mongodb+srv:// URI');
    return;
  }
  const dbName = parsed.databaseName;

  switch (elintysEnv) {
    case 'uat':
      if (dbName !== UAT_DATABASE_NAME) {
        out.add(true, 'MONGODB_URI', `database name must be exactly "${UAT_DATABASE_NAME}" when ELINTYS_ENV=uat`);
      }
      break;
    case 'prod':
      if (!dbName) {
        out.add(true, 'MONGODB_URI', 'must name the production database explicitly (no implicit "test" database)');
      } else if (FORBIDDEN_PROD_DATABASE_PATTERN.test(dbName)) {
        out.add(true, 'MONGODB_URI', 'database name must not contain dev, uat, test or local when ELINTYS_ENV=prod');
      }
      break;
    case 'dev':
      if (dbName !== DEV_DATABASE_NAME) {
        out.add(true, 'MONGODB_URI', `database name must be exactly "${DEV_DATABASE_NAME}" when ELINTYS_ENV=dev`);
      }
      break;
    case 'ci':
      if (!isLocalMongo(parsed)) {
        out.add(true, 'MONGODB_URI', 'must target a local/ephemeral MongoDB in CI (never Atlas or a remote cluster)');
      } else if (dbName !== CI_DATABASE_NAME) {
        out.add(false, 'MONGODB_URI', `database name should be "${CI_DATABASE_NAME}" in CI`);
      }
      break;
    case 'local':
      if (!isLocalMongo(parsed)) {
        if (dbName !== DEV_DATABASE_NAME) {
          out.add(true, 'MONGODB_URI', `a remote database is only allowed locally when it is "${DEV_DATABASE_NAME}"`);
        } else {
          out.add(false, 'MONGODB_URI', `local instance is connected to the remote "${DEV_DATABASE_NAME}" database`);
        }
      }
      break;
  }
}

function checkJwt(env: RawEnvironment, elintysEnv: ElintysEnvironment, out: Collector): void {
  const strict = isStrictElintysEnvironment(elintysEnv);
  const deployed = strict || elintysEnv === 'dev';
  const names = ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;

  const values = names.map((name) => {
    if (deployed) return required(env, name, true, out);
    const value = readString(env, name);
    if (isPlaceholder(value)) {
      out.add(false, name, `is not configured (placeholder ${PLACEHOLDER_PREFIX} value)`);
      return undefined;
    }
    return value;
  });

  values.forEach((value, index) => {
    if (value !== undefined && value.length < MIN_JWT_SECRET_LENGTH) {
      out.add(strict, names[index], `must be at least ${MIN_JWT_SECRET_LENGTH} characters long`);
    }
  });
  if (values[0] !== undefined && values[0] === values[1]) {
    out.add(strict, 'JWT_REFRESH_SECRET', 'must differ from JWT_SECRET');
  }
}

function checkPublicUrls(
  env: RawEnvironment,
  elintysEnv: ElintysEnvironment,
  nodeEnv: string,
  out: Collector,
): void {
  const strict = isStrictElintysEnvironment(elintysEnv);
  const deployed = strict || elintysEnv === 'dev';

  // FRONTEND_URL n'a plus de repli localhost sous NODE_ENV=production.
  const frontendUrl =
    deployed || nodeEnv === 'production'
      ? required(env, 'FRONTEND_URL', strict || nodeEnv === 'production', out)
      : readString(env, 'FRONTEND_URL');
  if (deployed && frontendUrl) {
    const problem = publicHttpsOriginProblem(frontendUrl);
    if (problem) out.add(strict, 'FRONTEND_URL', problem);
  }

  if (!deployed) return;
  const rawOrigins = required(env, 'CORS_ORIGINS', strict, out);
  if (rawOrigins === undefined) return;
  const origins = rawOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    out.add(strict, 'CORS_ORIGINS', 'must list at least one origin');
    return;
  }
  origins.forEach((origin, index) => {
    const problem = origin === '*' ? 'must not contain a wildcard' : publicHttpsOriginProblem(origin);
    if (problem) out.add(strict, 'CORS_ORIGINS', `entry #${index + 1} ${problem}`);
  });
}

function checkPayments(env: RawEnvironment, elintysEnv: ElintysEnvironment, out: Collector): void {
  const paypalEnv = readString(env, 'PAYPAL_ENV')?.toLowerCase();
  const paypalEnabled = isOptInFlagEnabled(env.PAYPAL_PROVIDER_ENABLED);

  if (paypalEnv === 'live' && elintysEnv !== 'prod') {
    out.add(true, 'PAYPAL_ENV', 'live PayPal is only allowed when ELINTYS_ENV=prod');
  }
  if (elintysEnv === 'uat' && paypalEnv !== 'sandbox') {
    out.add(true, 'PAYPAL_ENV', 'must be explicitly set to "sandbox" when ELINTYS_ENV=uat');
  }
  if (elintysEnv === 'prod' && paypalEnabled && paypalEnv !== 'live') {
    out.add(true, 'PAYPAL_ENV', 'must be "live" when PAYPAL_PROVIDER_ENABLED=true and ELINTYS_ENV=prod');
  }
  if (
    isOptInFlagEnabled(env.TEST_PAYMENT_PROVIDER_ENABLED) &&
    isStrictElintysEnvironment(elintysEnv)
  ) {
    out.add(true, 'TEST_PAYMENT_PROVIDER_ENABLED', `must not be enabled when ELINTYS_ENV=${elintysEnv}`);
  }
}

function checkEmail(env: RawEnvironment, elintysEnv: ElintysEnvironment, out: Collector): void {
  const strict = isStrictElintysEnvironment(elintysEnv);
  if (!strict && elintysEnv !== 'dev') return;
  // Lecture partagée avec configuration.ts : absent ⇒ envoi actif ; seule la
  // valeur exacte `false` désactive (toute variante est refusée au format).
  const enabled = isOptOutFlagEnabled(env.EMAIL_DELIVERY_ENABLED);
  if (!enabled) return;
  required(env, 'RESEND_API_KEY', strict, out);
  required(env, 'EMAIL_FROM', strict, out);
}

function checkRuntimeHardening(
  env: RawEnvironment,
  elintysEnv: ElintysEnvironment,
  nodeEnv: string,
  out: Collector,
): void {
  if (isStrictElintysEnvironment(elintysEnv) && nodeEnv !== 'production') {
    // Garantit cookies Secure, CORS sans réseau local et proxy de confiance.
    out.add(true, 'NODE_ENV', `must be "production" when ELINTYS_ENV=${elintysEnv}`);
  }

  const folder = readString(env, 'CLOUDINARY_FOLDER');
  if (folder !== undefined && !isPlaceholder(folder)) {
    if (elintysEnv === 'uat' && folder !== 'uat') {
      out.add(true, 'CLOUDINARY_FOLDER', 'must be "uat" (or omitted) when ELINTYS_ENV=uat');
    }
    if (elintysEnv === 'prod' && FORBIDDEN_PROD_FOLDER_PATTERN.test(folder)) {
      out.add(true, 'CLOUDINARY_FOLDER', 'must not reference a non-production environment when ELINTYS_ENV=prod');
    }
    if (elintysEnv === 'dev' && folder !== 'dev') {
      out.add(false, 'CLOUDINARY_FOLDER', 'differs from "dev" while ELINTYS_ENV=dev');
    }
  }

  if (isStrictElintysEnvironment(elintysEnv)) {
    for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
      required(env, name, false, out);
    }
  }
}

function checkFormats(env: RawEnvironment, blocking: boolean, out: Collector): void {
  // Les placeholders sont signalés par les contrôles de présence : on ne
  // valide pas leur format (message trompeur sinon).
  const candidate = Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value.trim()),
    ),
  );
  const instance = plainToInstance(EnvironmentVariables, candidate, { excludeExtraneousValues: false });
  for (const error of validateSync(instance, { skipMissingProperties: false })) {
    // Les messages class-validator par défaut ne contiennent jamais la valeur.
    const reasons = Object.values(error.constraints ?? {}).map((message) =>
      message.replace(new RegExp(`^${error.property}\\s*`), ''),
    );
    const blockingForVariable = blocking || error.property === 'ELINTYS_ENV';
    out.add(blockingForVariable, error.property, reasons.join('; ') || 'has an invalid format');
  }
}

/** Évalue l'environnement sans effet de bord (testable). */
export function evaluateEnvironment(env: RawEnvironment): EnvironmentReport {
  const out = new Collector();
  const nodeEnv = readString(env, 'NODE_ENV') ?? 'development';

  let elintysEnv: ElintysEnvironment;
  try {
    elintysEnv = resolveElintysEnvironment(readString(env, 'ELINTYS_ENV'), nodeEnv);
  } catch (error) {
    out.add(true, 'ELINTYS_ENV', (error as Error).message.replace(/^ELINTYS_ENV\s*/, ''));
    return { elintysEnv: null, errors: out.errors, warnings: out.warnings };
  }

  checkFormats(env, isStrictElintysEnvironment(elintysEnv), out);
  checkRuntimeHardening(env, elintysEnv, nodeEnv, out);
  checkMongo(env, elintysEnv, out);
  checkJwt(env, elintysEnv, out);
  checkPublicUrls(env, elintysEnv, nodeEnv, out);
  checkPayments(env, elintysEnv, out);
  checkEmail(env, elintysEnv, out);

  return { elintysEnv, errors: out.errors, warnings: out.warnings };
}

export function formatFindings(findings: EnvironmentFinding[]): string {
  return findings.map(({ variable, reason }) => `  - ${variable} ${reason}`).join('\n');
}

/**
 * `validate` de ConfigModule.forRoot : lève au démarrage si l'environnement
 * est invalide, journalise les avertissements (noms uniquement), et retourne
 * la configuration INCHANGÉE (aucune variable n'est filtrée ni réécrite).
 */
export function validateEnvironment(
  config: RawEnvironment,
  logger: Pick<Logger, 'warn'> = new Logger('EnvironmentValidation'),
): RawEnvironment {
  const report = evaluateEnvironment(config);
  const label = report.elintysEnv ?? 'unknown';

  if (report.errors.length > 0) {
    throw new Error(
      `Invalid environment configuration (ELINTYS_ENV=${label}) — refusing to start:\n${formatFindings(report.errors)}`,
    );
  }
  for (const warning of report.warnings) {
    logger.warn(`[ELINTYS_ENV=${label}] ${warning.variable} ${warning.reason}`);
  }
  return config;
}
