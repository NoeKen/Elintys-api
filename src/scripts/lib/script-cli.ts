import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ScriptGuardError } from './environment-guard';

/**
 * script-cli.ts — analyse stricte des arguments des scripts opérationnels.
 *
 * Seule la forme `--nom` ou `--nom=valeur` est acceptée. Tout drapeau inconnu,
 * dupliqué ou argument positionnel est refusé : une faute de frappe
 * (`--aply`) ne doit jamais retomber silencieusement sur un autre mode.
 */

export type CliFlags = ReadonlyMap<string, string | true>;

export function parseCliFlags(argv: readonly string[], allowed: readonly string[]): CliFlags {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new ScriptGuardError('UNEXPECTED_ARGUMENT', `argument positionnel refusé ('${arg}')`);
    }
    const separator = arg.indexOf('=');
    const name = separator < 0 ? arg.slice(2) : arg.slice(2, separator);
    if (!allowed.includes(name)) {
      throw new ScriptGuardError('UNKNOWN_FLAG', `--${name} (autorisés : ${allowed.map((flag) => `--${flag}`).join(', ')})`);
    }
    if (flags.has(name)) {
      throw new ScriptGuardError('DUPLICATE_FLAG', `--${name}`);
    }
    flags.set(name, separator < 0 ? true : arg.slice(separator + 1));
  }
  return flags;
}

export function flagValue(flags: CliFlags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || value.trim() === '') {
    throw new ScriptGuardError('FLAG_VALUE_REQUIRED', `--${name}=<valeur>`);
  }
  return value.trim();
}

export function flagEnabled(flags: CliFlags, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value !== true) {
    throw new ScriptGuardError('FLAG_TAKES_NO_VALUE', `--${name}`);
  }
  return true;
}

/**
 * Charge un fichier d'environnement CHOISI EXPLICITEMENT (`--env-file=…`).
 *
 * Aucun fichier n'est jamais lu implicitement : sans `--env-file`, seules les
 * variables déjà présentes dans le processus sont utilisées. Un fichier dont
 * le nom évoque la production est refusé hors `--environment=prod`.
 * Les valeurs du fichier remplacent celles du shell : le fichier choisi est
 * la source de vérité de l'exécution.
 */
export function loadExplicitEnvFile(
  envFile: string | undefined,
  environment: string | undefined,
  target: NodeJS.ProcessEnv = process.env,
): void {
  if (!envFile) return;
  if (/prod/i.test(basename(envFile)) && environment !== 'prod') {
    throw new ScriptGuardError('ENV_FILE_PRODUCTION_REFUSED', `'${basename(envFile)}' refusé hors --environment=prod`);
  }
  const path = resolve(envFile);
  if (!existsSync(path)) {
    throw new ScriptGuardError('ENV_FILE_NOT_FOUND', `'${basename(envFile)}' introuvable`);
  }
  const result = loadDotenv({ path, override: true, quiet: true, processEnv: target });
  if (result.error) {
    throw new ScriptGuardError('ENV_FILE_UNREADABLE', `'${basename(envFile)}'`);
  }
}

/** Variante stricte (seed/reset UAT) : le fichier d'environnement est obligatoire. */
export function requireExplicitEnvFile(
  envFile: string | undefined,
  environment: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  if (!envFile) {
    throw new ScriptGuardError('ENV_FILE_REQUIRED', '--env-file=<fichier> est obligatoire (ex. --env-file=.env.uat.local)');
  }
  loadExplicitEnvFile(envFile, environment, target);
}
