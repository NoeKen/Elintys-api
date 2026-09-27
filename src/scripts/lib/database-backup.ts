import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import mongoose from 'mongoose';
import { GuardedTarget, ScriptGuardError } from './environment-guard';

/**
 * database-backup.ts — sauvegarde EJSON complète d'une base (lecture seule).
 *
 * Généralisation de `backup-dev-database.ts` : un fichier EJSON canonique
 * (types BSON préservés) par collection, les index de chaque collection et un
 * manifeste avec checksums SHA-256. Répertoire 0700, fichiers 0600, jamais
 * d'écrasement (`wx`).
 *
 * Refus :
 *   - production si la garde production complète n'a pas été franchie ;
 *   - base connectée différente de la cible gardée ;
 *   - répertoire de sortie à l'intérieur du dépôt hors `backups/` (ignoré par Git) :
 *     un dump contient des données personnelles et ne doit jamais être commité.
 */

export interface BackupCollection {
  find(filter: Record<string, never>): { toArray(): Promise<unknown[]> };
  indexes(): Promise<unknown[]>;
}

export interface BackupDb {
  databaseName: string;
  listCollections(): { toArray(): Promise<{ name: string; type?: string }[]> };
  collection(name: string): BackupCollection;
}

export interface BackupCollectionReport {
  collection: string;
  documents: number;
  bytes: number;
  sha256: string;
  file: string;
}

export interface BackupResult {
  directory: string;
  manifestPath: string;
  totalDocuments: number;
  collections: BackupCollectionReport[];
}

export interface BackupOptions {
  target: GuardedTarget;
  outputRoot: string;
  clusterHost: string;
  tool: string;
  /** Racine du dépôt, pour interdire un dump commitable. */
  repositoryRoot?: string;
  now?: Date;
}

export function assertBackupLocation(outputRoot: string, repositoryRoot: string): string {
  const root = resolve(outputRoot);
  const repo = resolve(repositoryRoot);
  const insideRepo = root === repo || root.startsWith(`${repo}${sep}`);
  if (!insideRepo) return root;
  const relativePath = relative(repo, root);
  if (relativePath === 'backups' || relativePath.startsWith(`backups${sep}`)) return root;
  throw new ScriptGuardError(
    'BACKUP_PATH_INSIDE_REPOSITORY',
    "le backup doit être hors du dépôt ou sous 'backups/' (ignoré par Git)",
  );
}

export async function backupDatabase(db: BackupDb, options: BackupOptions): Promise<BackupResult> {
  const { target } = options;
  if (target.environment === 'prod' && !target.productionConfirmed) {
    throw new ScriptGuardError('BACKUP_PRODUCTION_REFUSED', 'garde production non franchie');
  }
  if (db.databaseName !== target.databaseName) {
    throw new ScriptGuardError(
      'BACKUP_DATABASE_MISMATCH',
      `base connectée '${db.databaseName}' ≠ cible '${target.databaseName}'`,
    );
  }
  const root = assertBackupLocation(options.outputRoot, options.repositoryRoot ?? process.cwd());

  const createdAt = options.now ?? new Date();
  const timestamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const directory = join(root, `${target.databaseName}-${timestamp}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const collections = (await db.listCollections().toArray())
    .filter(({ name, type }) => !name.startsWith('system.') && type !== 'view')
    .sort((a, b) => a.name.localeCompare(b.name));

  const reports: BackupCollectionReport[] = [];
  const indexes: Record<string, unknown[]> = {};
  for (const { name } of collections) {
    const collection = db.collection(name);
    const documents = await collection.find({}).toArray();
    const payload = mongoose.mongo.BSON.EJSON.stringify(documents, undefined, 2, { relaxed: false });
    const file = `${name}.json`;
    await writeFile(join(directory, file), payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    reports.push({
      collection: name,
      documents: documents.length,
      bytes: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'),
      file,
    });
    indexes[name] = await collection.indexes();
  }

  const manifest = {
    database: target.databaseName,
    environment: target.environment,
    createdAt: createdAt.toISOString(),
    cluster: options.clusterHost,
    tool: options.tool,
    totalDocuments: reports.reduce((sum, report) => sum + report.documents, 0),
    collections: reports,
    indexes,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, manifestJson, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await writeFile(
    join(directory, 'manifest.sha256'),
    `${createHash('sha256').update(manifestJson).digest('hex')}  manifest.json\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  return { directory, manifestPath, totalDocuments: manifest.totalDocuments, collections: reports };
}
