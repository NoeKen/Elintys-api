# Architecture cible (TARGET) — NON IMPLÉMENTÉE

> **Statut : vision, rien de ce document n'est implémenté.**
> La mission de stabilisation en cours (UAT / CI-CD) interdit explicitement
> toute migration vers PostgreSQL/Prisma et tout ajout de Redis/BullMQ.
> Pour ce qui tourne réellement, voir
> [`architecture-current.md`](./architecture-current.md).
>
> Toute évolution vers la cible exige une décision produit/technique
> explicite, un plan dédié et une migration de données outillée.

## Sources

Les documents de référence de la cible sont conservés **hors des dépôts**,
dans le dossier `docs/` du poste de l'équipe :

- `Elintys_Analyse_Technique_Architecture_v7.0.pdf`
- `Elintys_Analyse_Technique_vNext2.pdf` (et versions `vNext`, `vNext1`)
- `Elintys_Analyse_Migration_PostgreSQL_Workspace_v1.pdf` / `.docx`
- `Elintys_Analyse_BD_API_v3.pdf`
- `Elintys_CDC_Produit_v7.0.pdf`

En cas d'écart, ces documents font foi pour la cible ; le présent fichier
n'en est qu'un résumé d'orientation.

## Grandes orientations (résumé)

| Domaine | Actuel | Cible envisagée |
| --- | --- | --- |
| Base de données | MongoDB + Mongoose | PostgreSQL + Prisma (transactions ACID, anti-survente) |
| Modèle de tenancy | comptes utilisateurs multi-rôles | Workspaces / Organizations |
| Cache, rate limiting | mémoire du processus | Redis |
| Traitements asynchrones | tâches `@nestjs/schedule` dans le processus API | BullMQ (worker séparé) : courriels, notifications, IA, purge |
| Recherche | requêtes MongoDB | PostgreSQL FTS, puis Meilisearch, puis recherche vectorielle |
| Observabilité | logs JSON structurés (`x-request-id`) | Sentry, analytics produit |
| Paiements | PayPal (Stripe historique en code) | à arbitrer dans les documents cibles |

## Préalables avant tout chantier cible

1. Baseline stable : CI verte et protégée, recette UAT fonctionnelle,
   production alignée sur `master` (voir
   [`../operations/deployment.md`](../operations/deployment.md)).
2. Décision écrite sur le périmètre (quels domaines migrent, dans quel ordre).
3. Stratégie de migration de données (double écriture ou bascule), avec
   backup, dry-run et vérification, dans l'esprit du contrat actuel
   ([`../operations/database-migrations.md`](../operations/database-migrations.md)).
