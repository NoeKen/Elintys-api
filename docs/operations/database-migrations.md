# Migrations de base de données — contrat d'exploitation

Code de référence : `src/scripts/lib/migration-runner.ts`,
`src/scripts/lib/environment-guard.ts`, `src/scripts/lib/script-cli.ts`,
`src/scripts/lib/database-backup.ts`, scripts `npm run …` de `package.json`.

> Règle absolue : aucune migration n'est lancée depuis la CI ni au démarrage
> de l'API. Une migration est toujours une action humaine, explicite, sur un
> environnement nommé, précédée d'un dry-run.

## Scripts concernés

### Contrat explicite (`--environment`) — à utiliser

| Script npm | Fichier | Rollback |
| --- | --- | --- |
| `sprint3-wave4:migrate` | `migrate-sprint3-wave4-indexes.ts` | oui (`--rollback`) |
| `sprint3-wave5:migrate` | `migrate-sprint3-wave5-indexes.ts` | oui (`--rollback`, index seulement) |
| `sprint3-wave6:migrate` | `migrate-sprint3-wave6-indexes.ts` | oui (`--rollback`) |
| `wave-j:venues:migrate` | `migrate-s4-wave-j-venues.ts` | non |
| `wave-j:reviews:migrate` | `migrate-s4-wave-j-reviews.ts` | non |
| `wave-j:migrate` | `migrate-s4-wave-j.ts` (salles puis avis, mêmes drapeaux) | non |
| `migrate:uat:wave-j` | alias de `wave-j:migrate -- --environment=uat` | non |
| `backup:db` | `backup-database.ts` (lecture seule) | — |
| `seed:uat` / `reset:uat` | `seed-uat.ts` / `reset-uat.ts` (garde UAT stricte, voir plus bas) | — |

### Contrat historique (dev uniquement) — ne pas utiliser hors dev

`event-access:migrate`, `media:migrate`, `invitation-index:migrate`,
`invitation-dedup:migrate`, `seed:dev`, `qa:provision`, `backup:dev` et les
scripts `*:concurrency` refusent tout ce qui n'est pas `ELINTYS_ENV=dev` avec
la base `elintys-dev` (drapeaux `--execute` + drapeau de confirmation propre à
chaque script). Ils ne sont pas couverts par ce contrat.

## Syntaxe

```bash
npm run <migration> -- --environment=<dev|uat|prod> [--env-file=<fichier>]
                       [--apply | --rollback] [--backup-path=<dir>]
                       [--confirm-database=<nom>]
```

Analyse stricte (`script-cli.ts`) : seules les formes `--nom` et
`--nom=valeur` sont acceptées ; drapeau inconnu (`UNKNOWN_FLAG`), dupliqué
(`DUPLICATE_FLAG`) ou argument positionnel (`UNEXPECTED_ARGUMENT`) ⇒ refus.
`--rollback` n'est accepté que par les migrations qui le déclarent.
`--apply` et `--rollback` sont mutuellement exclusifs.

| Drapeau | Effet |
| --- | --- |
| *(aucun mode)* | **dry-run** : préflight en lecture seule, aucune écriture |
| `--apply` | applique la migration (exige `--backup-path`) |
| `--rollback` | annulation ciblée (exige `--backup-path`) |
| `--environment=` | obligatoire, doit être **égal** à `ELINTYS_ENV` |
| `--env-file=` | charge ce fichier (et lui seul) ; ses valeurs remplacent celles du shell. Un nom contenant `prod` est refusé hors `--environment=prod`. Sans ce drapeau, aucun fichier n'est lu |
| `--backup-path=` | répertoire du backup complet pré-écriture ; hors du dépôt, ou sous `backups/` (ignoré par Git) |
| `--confirm-database=` | si fourni, doit être exactement le nom de la base ciblée ; obligatoire en prod |

## Validation de la cible

Avant toute connexion :

1. `MONGODB_URI` présent (`MONGODB_URI_REQUIRED`) et nommant explicitement
   la base (`DATABASE_NAME_MISSING`).
2. `--environment` présent et valide, égal à `ELINTYS_ENV`
   (`ENVIRONMENT_MISMATCH`).
3. Base attendue : `dev` → `elintys-dev`, `uat` → `elintys-uat`
   (`DATABASE_MISMATCH`).
4. Écriture sans `--backup-path` → `BACKUP_PATH_REQUIRED`.
5. La cible est affichée : `environnement=… cluster=<hôte sans identifiants> base=… mode=…`.
   L'URI complète n'est **jamais** affichée.

Après connexion : la base réellement ouverte doit être la cible
(`CONNECTED_DATABASE_MISMATCH`).

## Déroulé d'une exécution en écriture

1. Garde + affichage de la cible.
2. **Backup complet** (`database-backup.ts`) : un fichier EJSON canonique par
   collection, les index, `manifest.json` (comptes, SHA-256 par fichier) et
   `manifest.sha256`, dans `<backup-path>/<base>-<horodatage>/`
   (répertoire 0700, fichiers 0600, jamais d'écrasement).
3. Migration.
4. **Post-validation** : si elle échoue ⇒ `POST_VALIDATION_FAILED`, code de
   sortie 1.
5. **Rapport** `migration-report.json` écrit dans le répertoire du backup
   (statut `succeeded` | `failed`, mode, environnement, base, hôte du cluster,
   horodatages, résumé du backup, résultat, erreur éventuelle — message
   « sûr », sans URI).

En dry-run, aucun backup ni rapport n'est écrit ; le préflight est imprimé
sur la sortie standard, suivi d'un résumé.

Aucune restauration automatique n'est tentée en cas d'échec : le message
d'erreur le rappelle.

## Procédure standard

```bash
# 1. Dry-run
npm run sprint3-wave5:migrate -- --environment=uat --env-file=.env.uat.local

# 2. Relire le préflight (volumes, doublons bloquants, index existants)

# 3. Application (backup automatique)
npm run sprint3-wave5:migrate -- --environment=uat --env-file=.env.uat.local \
  --apply --backup-path=$HOME/elintys-backups

# 4. Vérifier le résumé et migration-report.json (status: succeeded)
```

Backup seul (lecture seule) :

```bash
npm run backup:db -- --environment=uat --env-file=.env.uat.local --backup-path=$HOME/elintys-backups
```

## Rollback et restauration

- `--rollback` (vagues 4, 5, 6) supprime **uniquement** les index nommés par
  la migration ; il ne touche pas aux données (le backfill additif de la
  vague 5 n'est pas annulé). Il exige lui aussi `--backup-path`.
- Les migrations Wave J n'ont pas de rollback : le retour arrière passe par la
  restauration du backup (voir aussi
  [`../runbooks/wave-j-venue-migration.md`](../runbooks/wave-j-venue-migration.md)).
- **Il n'existe pas de script de restauration dans le dépôt.** La
  restauration est manuelle, à partir du répertoire de backup :
  1. vérifier l'intégrité : `shasum -a 256 -c manifest.sha256` puis comparer
     les SHA-256 de `manifest.json` aux fichiers de collection ;
  2. arrêter les écritures (suspendre le service Render concerné) ;
  3. réimporter chaque collection concernée depuis son fichier EJSON
     canonique (tableau JSON), par exemple avec `mongoimport --jsonArray
     --drop` vers la **même** base, puis recréer les index listés dans
     `manifest.json` ;
  4. relancer l'API, vérifier `GET /api/v1/health` et les parcours critiques.

  Cette procédure doit être **répétée sur UAT** avant d'être considérée
  comme fiable pour la production. Un outil de restauration gardé reste à
  écrire (question ouverte).

## Restrictions production

La production est bloquée tant que **toutes** ces conditions ne sont pas
réunies (`resolveGuardedTarget`) :

- `--environment=prod` **et** `ELINTYS_ENV=prod` ;
- `ELINTYS_ALLOW_PRODUCTION_MIGRATION=I_HAVE_A_VERIFIED_BACKUP` dans
  l'environnement du processus (`PRODUCTION_ACK_REQUIRED`) ;
- `--confirm-database=<nom exact>` (`PRODUCTION_CONFIRM_DATABASE_REQUIRED`) ;
- un nom de base ne contenant ni `dev`, ni `uat`, ni `test`
  (`PRODUCTION_DATABASE_NAME_FORBIDDEN`) ;
- `--backup-path` **même en dry-run** (`PRODUCTION_BACKUP_PATH_REQUIRED`).

Règles d'équipe en plus du code : jamais depuis un agent automatisé, jamais
sans backup vérifié et restauration répétée sur UAT, jamais sans fenêtre de
maintenance annoncée, toujours après une exécution identique réussie sur UAT.
Un fichier `--env-file` de production ne doit jamais être créé dans le dépôt.

## Première initialisation de la base UAT

Préalables (manuels) : base `elintys-uat` créée sur le cluster Atlas, avec un
utilisateur dédié `readWrite@elintys-uat` uniquement ; fichier local non
versionné `.env.uat.local` contenant au minimum `ELINTYS_ENV=uat`,
`MONGODB_URI` (base `elintys-uat`) et, pour le seed, `UAT_SEED_PASSWORD`
(≥ 12 caractères, ≤ 72 octets).

Les collections `autoIndex: false` reçoivent leurs index par les migrations :
elles doivent donc passer **avant** le seed.

```bash
B=$HOME/elintys-backups
E=--env-file=.env.uat.local

# Vagues 4, 5, 6 : dry-run puis application, dans cet ordre
npm run sprint3-wave4:migrate -- --environment=uat $E
npm run sprint3-wave4:migrate -- --environment=uat $E --apply --backup-path=$B
npm run sprint3-wave5:migrate -- --environment=uat $E
npm run sprint3-wave5:migrate -- --environment=uat $E --apply --backup-path=$B
npm run sprint3-wave6:migrate -- --environment=uat $E
npm run sprint3-wave6:migrate -- --environment=uat $E --apply --backup-path=$B

# Wave J (salles puis avis)
npm run migrate:uat:wave-j -- $E
npm run migrate:uat:wave-j -- $E --apply --backup-path=$B

# Données fictives
npm run seed:uat -- $E
```

## Seed et reset UAT

Garde stricte (`assertUatTarget`) : `ELINTYS_ENV=uat`, base exactement
`elintys-uat`, tout nom contenant `prod` refusé ; `--env-file` **obligatoire**.

```bash
npm run seed:uat -- --env-file=.env.uat.local
```

Idempotent (upsert par clé fonctionnelle). Comptes sur le domaine réservé
`uat.elintys.test`, mot de passe commun lu dans `UAT_SEED_PASSWORD`, jamais
affiché ; seul le hash bcrypt est stocké.

```bash
npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --backup-path=<dir> [--reseed]
npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --skip-backup [--reseed]
```

`reset:uat` exécute `deleteMany({})` sur chaque collection (hors `system.*` et
vues) : collections et index sont conservés, la base n'est jamais supprimée.
`--confirm=elintys-uat` est obligatoire ; backup obligatoire sauf
`--skip-backup` explicite ; avec `--reseed`, le mot de passe de seed est
vérifié **avant** toute suppression.
