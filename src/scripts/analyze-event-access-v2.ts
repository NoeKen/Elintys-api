import 'dotenv/config';
import mongoose from 'mongoose';
import { planEventAccessMigration } from './migrate-event-access-v2';

/**
 * analyze-event-access-v2.ts — analyse **lecture seule** (Lot 3, phase A).
 *
 * Réutilise `planEventAccessMigration` (la logique de mapping réelle de la
 * migration) pour produire un classement détaillé par document, sans jamais
 * écrire en base. Aucune opération d'écriture n'est possible depuis ce script.
 *
 * Sécurité : REFUSE toute base qui n'est pas exactement `elintys-dev`.
 */

const REQUIRED_DEV_DB = 'elintys-dev';

type Classification =
  | 'DEJA_V2'
  | 'LEGACY_AUTO'
  | 'LEGACY_ADAPTE'
  | 'AMBIGU'
  | 'BLOQUE'
  | 'INCOHERENT';

interface EventDoc {
  _id: mongoose.Types.ObjectId;
  title?: string;
  status?: string;
  slug?: string;
  visibility?: string;
  discoverability?: string;
  accessPolicy?: Record<string, unknown>;
  accessRules?: Record<string, unknown>;
  admissionModes?: string[];
  accessModelVersion?: number;
}

function classify(
  event: EventDoc,
  plan: ReturnType<typeof planEventAccessMigration>,
): { classification: Classification; reason: string; risk: string } {
  if (event.accessModelVersion === 2) {
    return { classification: 'DEJA_V2', reason: 'accessModelVersion déjà = 2', risk: '—' };
  }
  if (plan.ambiguousReason) {
    return {
      classification: 'AMBIGU',
      reason: plan.ambiguousReason,
      risk: 'Intention d’accès indéterminable — intervention humaine requise',
    };
  }
  if (!plan.update) {
    return { classification: 'BLOQUE', reason: 'Aucun plan produit', risk: 'Migration impossible' };
  }
  // Incohérences détectables : champs V2 partiels alors que version ≠ 2
  const hasPartialV2 =
    event.discoverability !== undefined ||
    event.accessPolicy !== undefined ||
    (event.admissionModes !== undefined && event.admissionModes.length > 0);
  if (hasPartialV2) {
    return {
      classification: 'INCOHERENT',
      reason: 'Champs V2 déjà présents mais accessModelVersion ≠ 2',
      risk: 'La migration écrasera des valeurs V2 existantes — à vérifier avant exécution',
    };
  }
  // Adaptation = le mapping s’appuie sur accessRules (pas seulement visibility)
  const usedAccessRules =
    event.visibility !== 'public' &&
    event.visibility !== undefined &&
    event.visibility !== 'invite_only';
  if (usedAccessRules) {
    return {
      classification: 'LEGACY_ADAPTE',
      reason: 'Mapping dérivé de accessRules (domaine/approbation)',
      risk: 'Vérifier la sémantique métier du mapping',
    };
  }
  return {
    classification: 'LEGACY_AUTO',
    reason: `visibility="${event.visibility ?? '(absent)'}" → mapping direct`,
    risk: 'Faible',
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('ANALYSE_REFUSEE: MONGODB_URI requis.');
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(uri).pathname.slice(1));
  } catch {
    throw new Error('ANALYSE_REFUSEE: MONGODB_URI invalide.');
  }
  if (dbName !== REQUIRED_DEV_DB) {
    throw new Error(`ANALYSE_REFUSEE: base "${dbName}" != "${REQUIRED_DEV_DB}".`);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== REQUIRED_DEV_DB) {
    await mongoose.disconnect();
    throw new Error('ANALYSE_REFUSEE: base connectée inattendue.');
  }

  const events = (await db.collection('events').find({}).toArray()) as unknown as EventDoc[];
  const rows = events.map((event) => {
    const plan = planEventAccessMigration(event as never);
    const { classification, reason, risk } = classify(event, plan);
    const update = (plan.update ?? {}) as Record<string, unknown>;
    return {
      eventId: event._id.toString(),
      titre: (event.title ?? '(sans titre)').slice(0, 34),
      statut: event.status ?? '—',
      ancien_visibility: event.visibility ?? '(absent)',
      ancien_accessRules: event.accessRules ? JSON.stringify(event.accessRules) : '(absent)',
      version_actuelle: event.accessModelVersion ?? '(absent)',
      nouv_discoverability: (update.discoverability as string) ?? '—',
      nouv_accessPolicy: update.accessPolicy ? JSON.stringify(update.accessPolicy) : '—',
      nouv_admissionModes: update.admissionModes
        ? (update.admissionModes as string[]).join(',')
        : '—',
      nouv_version: (update.accessModelVersion as number) ?? '—',
      classification,
      raison: reason,
      risque: risk,
    };
  });

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.classification] = (acc[r.classification] ?? 0) + 1;
    return acc;
  }, {});

  console.log('=== CLASSEMENT ===');
  console.log(JSON.stringify(counts, null, 2));
  console.log('\n=== DÉTAIL PAR DOCUMENT ===');
  console.log(JSON.stringify(rows, null, 2));

  // Champs legacy encore présents
  const withVisibility = await db.collection('events').countDocuments({ visibility: { $exists: true } });
  const withAccessRules = await db.collection('events').countDocuments({ accessRules: { $exists: true } });
  const withV2Fields = await db.collection('events').countDocuments({ accessPolicy: { $exists: true } });
  console.log('\n=== CHAMPS ===');
  console.log(JSON.stringify({ withVisibility, withAccessRules, withAccessPolicy: withV2Fields, total: events.length }, null, 2));

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error('ÉCHEC analyse:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
