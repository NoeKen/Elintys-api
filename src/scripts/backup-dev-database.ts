import 'dotenv/config';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { EJSON } from 'bson';

/**
 * backup-dev-database.ts — sauvegarde complète de la base **dev** (Lot 3, phase A).
 *
 * Écrit un dump EJSON par collection + un manifeste avec checksums SHA-256.
 * Lecture seule sur la base : aucune écriture MongoDB.
 *
 * Sécurité : REFUSE toute base qui n'est pas exactement `elintys-dev`.
 *
 * Usage   : npm run backup:dev -- [répertoire de sortie]
 * Restaure: npm run restore:dev -- <répertoire de backup>   (script séparé, non destructif
 *           par défaut — voir docs/audits/lot-3-event-access-v2-dry-run.md)
 */

const REQUIRED_DEV_DB = 'elintys-dev';

interface CollectionReport {
  collection: string;
  documents: number;
  bytes: number;
  sha256: string;
  file: string;
}

async function backup(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('BACKUP_REFUSED: MONGODB_URI requis.');

  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(mongoUri).pathname.slice(1));
  } catch {
    throw new Error('BACKUP_REFUSED: MONGODB_URI invalide.');
  }
  if (dbName !== REQUIRED_DEV_DB) {
    throw new Error(
      `BACKUP_REFUSED: la base doit être exactement "${REQUIRED_DEV_DB}" (reçu "${dbName}").`,
    );
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== REQUIRED_DEV_DB) {
    await mongoose.disconnect();
    throw new Error(
      `BACKUP_REFUSED: base connectée "${db?.databaseName}" != "${REQUIRED_DEV_DB}".`,
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = process.argv[2] ?? join(process.cwd(), 'backups');
  const outDir = join(baseDir, `${REQUIRED_DEV_DB}-${timestamp}`);
  mkdirSync(outDir, { recursive: true });

  const collections = await db.listCollections().toArray();
  const reports: CollectionReport[] = [];

  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const docs = await db.collection(name).find({}).toArray();
    // EJSON préserve les types BSON (ObjectId, Date) pour une restauration fidèle.
    const payload = EJSON.stringify(docs, undefined, 2, { relaxed: false });
    const file = `${name}.json`;
    writeFileSync(join(outDir, file), payload, 'utf8');
    reports.push({
      collection: name,
      documents: docs.length,
      bytes: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'),
      file,
    });
  }

  const indexes: Record<string, unknown[]> = {};
  for (const { name } of collections) {
    indexes[name] = await db.collection(name).indexes();
  }

  const manifest = {
    database: REQUIRED_DEV_DB,
    createdAt: new Date().toISOString(),
    cluster: new URL(mongoUri).host, // hôte seulement, jamais les identifiants
    tool: 'backup-dev-database.ts (EJSON, driver Node)',
    totalDocuments: reports.reduce((n, r) => n + r.documents, 0),
    collections: reports,
    indexes,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(outDir, 'manifest.json'), manifestJson, 'utf8');
  writeFileSync(
    join(outDir, 'manifest.sha256'),
    `${createHash('sha256').update(manifestJson).digest('hex')}  manifest.json\n`,
    'utf8',
  );

  await mongoose.disconnect();

  console.log(`✓ Backup "${REQUIRED_DEV_DB}" → ${outDir}`);
  console.table(
    reports.map((r) => ({
      collection: r.collection,
      documents: r.documents,
      sha256: `${r.sha256.slice(0, 16)}…`,
    })),
  );
  console.log(`Total: ${manifest.totalDocuments} documents dans ${reports.length} collections.`);
}

backup().catch((error: unknown) => {
  console.error('ÉCHEC backup:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
