# AGENTS.md — Elintys-api

Consignes pour tout agent (Claude Code, Codex, autres) travaillant dans ce
dépôt. Elles complètent [`CLAUDE.md`](./CLAUDE.md) (règles de code) ; en cas
de contradiction sur l'infrastructure, **ce fichier et `docs/` font foi**.

## Architecture réelle

- NestJS 11 + TypeScript strict, Node **22** (`.nvmrc`), MongoDB/Mongoose 8.
- Auth JWT HS256 dans des cookies `httpOnly`, `SameSite=Lax`, **host-only**
  (`COOKIE_DOMAIN` interdit) ; Bearer accepté en repli.
- Courriel Resend, médias Cloudinary (`Elintys/<dossier>` par environnement),
  paiements PayPal Orders v2 (Stripe = code historique encore présent).
- Hébergement Render (API) / Vercel (web). Pas de Railway, PostgreSQL, Redis.
- Détails : [`docs/architecture/architecture-current.md`](./docs/architecture/architecture-current.md).
  La cible (PostgreSQL/Prisma, Workspaces, Redis/BullMQ…) est
  [non implémentée](./docs/architecture/architecture-target.md) : ne pas
  l'introduire sans décision explicite.

## Commandes

```bash
npm ci
npm run start:dev          # API locale (port 3001)
npm run lint
npm run typecheck
npm run build
npm test                   # Jest (unitaires, *.spec.ts colocalisés)
npm run test:e2e           # Supertest (test/*.e2e-spec.ts)
```

Portes à passer avant de déclarer une tâche terminée : `lint`, `typecheck`,
`build`, `test`, et `test:e2e` si le comportement HTTP change.

## Branches et PR

- `master` = production (ne pas renommer en `main`), `uat` = promotion,
  `dev` = intégration.
- Travail sur `feature/*` ou `fix/*` depuis `dev` → PR vers `dev` →
  promotion `dev → uat` → `uat → master`. Jamais de commit direct sur
  `uat`/`master`, jamais de force-push.
- Commits conventionnels courts (`feat:`, `fix:`, `test:`, `docs:`, `ci:`,
  `chore:`).
- Voir [`docs/operations/deployment.md`](./docs/operations/deployment.md) et
  [`docs/operations/bug-workflow.md`](./docs/operations/bug-workflow.md).

## CI

Workflow `.github/workflows/ci.yml`, jobs = checks requis : `quality`,
`unit`, `e2e`, `security`, `dependency-review` (PR). Ne pas renommer un job
sans mettre à jour la protection de branche. Aucun secret de dépôt : la CI
utilise un `mongo:7` éphémère (`elintys-test`) et des secrets JWT factices.
Détails : [`docs/operations/ci-cd.md`](./docs/operations/ci-cd.md).

## Environnements (`ELINTYS_ENV`)

`local` | `ci` | `dev` | `uat` | `prod` — dimension distincte de `NODE_ENV`
(qui vaut `production` sur dev, uat **et** prod). `src/config/env.validation.ts`
refuse le démarrage si la configuration ne correspond pas à l'environnement
(base `elintys-dev`/`elintys-uat`/prod, PayPal sandbox/live, secrets JWT,
CORS…). Toute nouvelle variable : l'ajouter à `.env.example` (placeholder),
à la validation si nécessaire, et à
[`docs/operations/environments.md`](./docs/operations/environments.md).

## Tests

- Unitaires Jest AAA, `'devrait …'`, mocks limités aux dépendances externes.
- Tout bug corrigé = test de non-régression ; toute mutation nouvelle doit
  respecter la règle « courriel non vérifié = lecture seule »
  ([`docs/security/email-verification.md`](./docs/security/email-verification.md)) :
  ne poser `@AllowUnverifiedEmail()` qu'avec justification ajoutée à la
  matrice.

## Contrat des migrations

```bash
npm run <migration> -- --environment=<dev|uat|prod> [--env-file=<f>] \
  [--apply|--rollback] [--backup-path=<dir>] [--confirm-database=<nom>]
```

Dry-run par défaut ; `--environment` = `ELINTYS_ENV` ; base imposée par
environnement ; backup complet + post-validation + rapport en écriture ;
production verrouillée par `ELINTYS_ALLOW_PRODUCTION_MIGRATION`,
`--confirm-database` et `--backup-path`. Référence :
[`docs/operations/database-migrations.md`](./docs/operations/database-migrations.md).

## Actions interdites aux agents

1. Écrire, afficher ou committer un secret (URI MongoDB, clés Resend,
   Cloudinary, PayPal, Stripe, secrets JWT, `UAT_SEED_PASSWORD`). `.env*`
   restent non versionnés, sauf `.env.example` (placeholders).
2. Toucher aux données ou services de production (Render `Elintys-api`, base
   prod), lancer une migration `--environment=prod`, poser
   `ELINTYS_ALLOW_PRODUCTION_MIGRATION`.
3. Lancer `reset:uat`, ou une migration `--apply` sur dev/uat, sans demande
   explicite de l'utilisateur.
4. Force-push, supprimer une branche protégée, pousser/merger sans demande.
5. Désactiver, ignorer (`.skip`) ou affaiblir un test pour obtenir une CI
   verte.
6. Migrer vers PostgreSQL/Prisma, ajouter Redis/BullMQ, ou refactorer hors du
   périmètre demandé.
7. Supprimer un index MongoDB existant hors migration documentée.
