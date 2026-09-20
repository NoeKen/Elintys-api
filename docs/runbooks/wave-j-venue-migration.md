# Wave J — migration des profils gestionnaires et lieux

Statut : procédure en cours de validation. Ne pas appliquer en production.

## Avant

`venueprofiles` contient les lieux physiques. `user_1` impose un lieu par compte. Les événements, réservations, favoris et avis utilisent les IDs de ces lieux.

## Après

`venuemanagerprofiles` contient le profil professionnel unique par utilisateur. Chaque lieu conserve son ID, son champ historique `user`, son adresse, ses médias et toutes ses autres propriétés. Le nouveau champ `managerProfile` relie le lieu à son propriétaire métier. Les autorisations utilisent ce lien. L'index propriétaire des lieux devient non unique, tandis que le profil gestionnaire conserve une unicité par utilisateur.

## Exécution contrôlée

1. Arrêter les writers/API de test pendant la bascule. Vérifier `ELINTYS_ENV=dev` et base exactement `elintys-dev`.
2. Exécuter le script sans `--apply` pour obtenir les volumes et anomalies. Aucun document n'est modifié par ce mode.
3. Sauvegarder la base avec le provisionneur de backup existant, vers un répertoire privé hors Git. Le script de migration sauvegarde également les documents et index concernés avant écriture.
4. Vérifier sauvegarde, volumes, absence de liens incohérents et propriétaires manquants.
5. Exécuter `npx ts-node src/scripts/migrate-s4-wave-j-venues.ts --apply --backup-dir <répertoire-privé>` seulement après revue du préflight.
6. Rejouer le dry-run : zéro lien manquant et ancien index unique absent. Vérifier les IDs, références et propriétés existantes avant/après.
7. Démarrer exclusivement la nouvelle version API, puis tester deux créations de lieux, lecture, édition, ownership et réservations.

La procédure ne convertit pas l'adresse libre de l'onboarding en adresse de lieu. Elle ne crée aucun lieu et ne remplace aucune relation Event/Booking.

## Rollback

Avant création d'un deuxième lieu par utilisateur, il est possible de revenir à l'ancienne application en recréant l'index unique `user_1` après contrôle des doublons. Les champs et profils ajoutés peuvent rester en place : l'ancienne version les ignore. Ne pas supprimer automatiquement les profils ni les liens.

Après création de plusieurs lieux pour un même utilisateur, le rollback vers l'ancien modèle 1:1 n'est plus compatible. Suspendre les mutations et corriger en avant. Ne jamais supprimer un lieu pour rendre l'ancien index recréable. Les sauvegardes servent à une restauration contrôlée, pas à écraser silencieusement des écritures ultérieures.

Toute anomalie d'intégrité arrête l'exécution. Une reprise doit commencer par un nouveau dry-run et l'inspection des backups.
