import 'reflect-metadata';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import mongoose, { Model } from 'mongoose';
import { User, UserRole, UserSchema } from '../modules/auth/user.schema';
import { resolveElintysEnvironment } from '../config/elintys-environment';

/**
 * provision-qa-users.ts — Lot 0 (audit remediation)
 *
 * Crée/réinitialise les comptes QA dans l'environnement **dev uniquement** :
 *   - un organisateur PROPRIÉTAIRE (E2E_TEST_EMAIL)
 *   - un organisateur TIERS non-propriétaire (E2E_TEST_EMAIL_SECONDARY) pour les tests IDOR
 *   - un PRESTATAIRE (E2E_TEST_EMAIL_VENDOR) — parcours profil + demandes
 *   - un GESTIONNAIRE DE SALLE (E2E_TEST_EMAIL_VENUE) — parcours fiche + réservations
 *   - un compte MULTI-RÔLES (E2E_TEST_EMAIL_MULTI) — priorité de rôle et
 *     débordement de la navigation mobile au-delà de quatre emplacements
 *
 * Les deux derniers sont créés SANS profil métier : c'est précisément l'état
 * qu'un utilisateur réel a après son onboarding, et que le parcours
 * « créer ma fiche » doit savoir traiter (F-05).
 *
 * Sécurité :
 *   - REFUSE toute base qui n'est pas exactement `elintys-dev` (garde anti-production).
 *   - REFUSE si ELINTYS_ENV !== 'dev'.
 *   - Le mot de passe vient de E2E_TEST_PASSWORD (jamais hardcodé, jamais loggé).
 *   - Rôle organisateur, email vérifié, AUCUNE permission admin.
 *
 * Rotation du mot de passe QA :
 *   1. Générer un nouveau mot de passe fort.
 *   2. Le placer dans Elintys-web/.env (E2E_TEST_PASSWORD) — jamais committé (.gitignore).
 *   3. Relancer `npm run qa:provision` (upsert idempotent : réécrit le hash).
 *   Les anciennes sessions restent valides jusqu'à expiration (15 min access / 7 j refresh).
 *
 * Usage : E2E_TEST_PASSWORD=... npm run qa:provision
 */

const REQUIRED_DEV_DB = 'elintys-dev';
const BCRYPT_ROUNDS = 12;

interface QaUser {
  email: string;
  fullName: string;
  /** Premier rôle = rôle dominant attendu par la politique de priorité. */
  roles: UserRole[];
}

async function provision(): Promise<void> {
  const elintysEnv = resolveElintysEnvironment(
    process.env.ELINTYS_ENV,
    process.env.NODE_ENV ?? 'development',
  );
  if (elintysEnv !== 'dev') {
    throw new Error('QA_PROVISION_REFUSED: ELINTYS_ENV doit valoir exactement "dev".');
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('QA_PROVISION_REFUSED: MONGODB_URI est requis.');
  }
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(mongoUri).pathname.slice(1));
  } catch {
    throw new Error('QA_PROVISION_REFUSED: MONGODB_URI invalide.');
  }
  if (dbName !== REQUIRED_DEV_DB) {
    throw new Error(
      `QA_PROVISION_REFUSED: la base doit être exactement "${REQUIRED_DEV_DB}" (reçu "${dbName}").`,
    );
  }

  const password = process.env.E2E_TEST_PASSWORD;
  if (!password || password.trim().length < 8) {
    throw new Error(
      'QA_PROVISION_REFUSED: E2E_TEST_PASSWORD (>= 8 caractères) doit être fourni via l\'environnement.',
    );
  }

  const ownerEmail = (process.env.E2E_TEST_EMAIL ?? 'qa-organisateur@demo.elintys.com')
    .trim()
    .toLowerCase();
  const secondaryEmail = (
    process.env.E2E_TEST_EMAIL_SECONDARY ?? 'qa-tiers@demo.elintys.com'
  )
    .trim()
    .toLowerCase();

  const vendorEmail = (process.env.E2E_TEST_EMAIL_VENDOR ?? 'qa-prestataire@demo.elintys.com')
    .trim()
    .toLowerCase();
  const venueEmail = (process.env.E2E_TEST_EMAIL_VENUE ?? 'qa-gestionnaire@demo.elintys.com')
    .trim()
    .toLowerCase();

  const multiEmail = (process.env.E2E_TEST_EMAIL_MULTI ?? 'qa-multi@demo.elintys.com')
    .trim()
    .toLowerCase();

  const qaUsers: QaUser[] = [
    { email: ownerEmail, fullName: 'QA Organisateur Propriétaire', roles: [UserRole.ORGANISATEUR] },
    { email: secondaryEmail, fullName: 'QA Organisateur Tiers', roles: [UserRole.ORGANISATEUR] },
    { email: vendorEmail, fullName: 'QA Prestataire', roles: [UserRole.PRESTATAIRE] },
    { email: venueEmail, fullName: 'QA Gestionnaire Salle', roles: [UserRole.GESTIONNAIRE_SALLE] },
    {
      email: multiEmail,
      fullName: 'QA Multi Rôles',
      roles: [UserRole.ORGANISATEUR, UserRole.PRESTATAIRE],
    },
  ];

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  // Double garde runtime : la base réellement connectée doit être elintys-dev.
  const connectedDb = mongoose.connection.db?.databaseName;
  if (connectedDb !== REQUIRED_DEV_DB) {
    await mongoose.disconnect();
    throw new Error(
      `QA_PROVISION_REFUSED: base connectée "${connectedDb}" != "${REQUIRED_DEV_DB}".`,
    );
  }

  const userModel: Model<User> = mongoose.model<User>(User.name, UserSchema);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  for (const input of qaUsers) {
    await userModel.findOneAndUpdate(
      { email: input.email },
      {
        $set: {
          fullName: input.fullName,
          roles: input.roles,
          password: passwordHash,
          isEmailVerified: true,
          onboardingCompleted: true,
          onboardingByRole: Object.fromEntries(input.roles.map((role) => [role, true])),
        },
        $setOnInsert: {
          referralBalance: 0,
          subscriptions: [],
          onboardingData: {},
        },
        $unset: {
          emailVerificationToken: 1,
          emailVerificationExpiresAt: 1,
          passwordResetToken: 1,
          passwordResetExpires: 1,
          refreshToken: 1,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    // Ne JAMAIS logger le mot de passe.
    console.log(`✓ Compte QA prêt : ${input.email} [${input.roles.join(', ')}, vérifié]`);
  }

  await mongoose.disconnect();
  console.log(
    `\nProvisioning terminé sur "${REQUIRED_DEV_DB}" (${qaUsers.length} comptes, mot de passe masqué).`,
  );
}

provision().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('ÉCHEC provision QA:', message);
  process.exitCode = 1;
});
