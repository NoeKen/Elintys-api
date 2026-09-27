import { formatSafeError } from './lib/environment-guard';
import { runGuardedMigration } from './lib/migration-runner';
import { reviewMigration } from './migrate-s4-wave-j-reviews';
import { venueMigration } from './migrate-s4-wave-j-venues';

/**
 * Wave J complète : salles puis avis, avec les MÊMES drapeaux pour les deux
 * (chaque étape refait sa garde, son backup et son rapport). Arrêt à la
 * première erreur : les avis ne sont jamais migrés si les salles ont échoué.
 *
 *   npm run migrate:uat:wave-j -- --env-file=.env.uat.local
 *   npm run migrate:uat:wave-j -- --env-file=.env.uat.local --apply --backup-path=<dir>
 */
async function main(argv: readonly string[]): Promise<void> {
  for (const definition of [venueMigration, reviewMigration]) {
    await runGuardedMigration(definition, argv);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[wave-j] ÉCHEC ${formatSafeError(error)} — aucune restauration automatique (rapport écrit à côté du backup s'il a été créé).`);
  process.exitCode = 1;
});
