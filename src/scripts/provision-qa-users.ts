import 'reflect-metadata';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import mongoose, { Model } from 'mongoose';
import { User, UserRole, UserSchema } from '../modules/auth/user.schema';
import { resolveElintysEnvironment } from '../config/elintys-environment';

/**
 * provision-qa-users.ts — Lot 0 (audit remediation)
 *
 * Crée/réinitialise DEUX comptes QA dans l'environnement **dev uniquement** :
 *   - un organisateur PROPRIÉTAIRE (E2E_TEST_EMAIL)
 *   - un organisateur TIERS non-propriétaire (E2E_TEST_EMAIL_SECONDARY) pour les tests IDOR
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

  const qaUsers: QaUser[] = [
    { email: ownerEmail, fullName: 'QA Organisateur Propriétaire' },
    { email: secondaryEmail, fullName: 'QA Organisateur Tiers' },
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
          roles: [UserRole.ORGANISATEUR],
          password: passwordHash,
          isEmailVerified: true,
          onboardingCompleted: true,
          onboardingByRole: { [UserRole.ORGANISATEUR]: true },
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
    console.log(`✓ Compte QA prêt : ${input.email} [organisateur, vérifié]`);
  }

  await mongoose.disconnect();
  console.log(`\nProvisioning terminé sur "${REQUIRED_DEV_DB}" (2 comptes, mot de passe masqué).`);
}

provision().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('ÉCHEC provision QA:', message);
  process.exitCode = 1;
});
