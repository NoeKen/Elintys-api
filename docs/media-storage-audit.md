# Audit interne — stockage média des événements

Date : 2026-07-29

## État observé

- Le frontend de l’étape 5 valide uniquement le type MIME déclaré et la taille, puis crée une URL `blob:` avec `URL.createObjectURL`.
- Aucun fichier n’est envoyé au backend. Le message `uploadGap` documente explicitement cette limite dans l’interface.
- Le payload JSON de l’étape 5 ne contient que la description, la visibilité, les règles d’accès et la progression.
- Le backend Event stocke actuellement `coverImage?: string`. Il ne possède ni champ galerie, ni contrôleur multipart, ni service de stockage média.
- La configuration Cloudinary existait déjà sous `cloudinary.*`, mais le `cloud_name` local était une valeur de démonstration refusée avec HTTP 401. L’environnement local a depuis été relié au compte Cloudinary `elintys`; les secrets restent exclusivement dans `.env`.
- Les endpoints Event sont protégés par JWT, rôles organisateur/admin et une vérification d’appartenance dans le service.
- Le throttling global est de 100 requêtes par minute. Aucun quota spécifique aux uploads n’existe encore.
- La suppression d’un événement est un hard delete MongoDB.
- La pile frontend possède déjà TanStack Query, le client API cookie/httpOnly et un système de toast.
- `next/image` n’autorise actuellement que `images.unsplash.com`.

## Données existantes

Lecture non destructive de la collection locale :

- 8 événements ;
- 6 événements avec `coverImage` de type chaîne ;
- 0 événement avec `coverImage` objet ;
- 0 événement avec un champ `gallery`.

Les six anciennes couvertures pointent vers Unsplash. Elles ne possèdent donc ni `publicId` Cloudinary, ni dimensions persistées et ne doivent jamais être transmises à l’API de destruction Cloudinary.

## Risques identifiés

1. Faire confiance au seul MIME du navigateur permettrait de téléverser un contenu déguisé.
2. Un remplacement Cloudinary avec un `publicId` écrasé en place pourrait désynchroniser la base si la persistance MongoDB échoue.
3. Supprimer l’ancien média avant la mise à jour MongoDB pourrait faire perdre une couverture valide.
4. Une suppression Cloudinary avant MongoDB pourrait laisser l’interface pointer vers un actif absent.
5. Une galerie sans limite atomique pourrait dépasser dix images en cas de requêtes concurrentes.
6. Des secrets Cloudinary exposés au navigateur permettraient des opérations non autorisées.
7. Une migration silencieuse des URLs externes vers de faux `publicId` créerait un risque de suppression arbitraire.

## Architecture retenue

- Module backend `MediaModule` indépendant du domaine Event.
- Contrat `MediaStorage` injecté via un token, implémenté par `CloudinaryMediaStorageService`.
- Validation serveur en mémoire : limite Multer, signature binaire JPG/PNG/WebP, décodage complet et normalisation avec Sharp, limite de pixels.
- Orchestration métier dans `EventMediaService` :
  - autorisation propriétaire avant toute opération distante ;
  - upload versionné dans un dossier propre à l’événement ;
  - persistance MongoDB ;
  - nettoyage compensatoire du nouvel actif si MongoDB échoue ;
  - suppression de l’ancien actif seulement après la nouvelle persistance.
- Suppression fonctionnelle : MongoDB d’abord, Cloudinary ensuite, avec résultat idempotent et journalisation si le nettoyage distant échoue.
- Un seul champ source `coverImage`, au format objet après migration, plus `gallery: MediaImage[]`.
- Migration dédiée pour les anciennes URLs externes : téléchargement borné et décodé, upload vers Cloudinary, puis remplacement atomique du champ. Tant que la migration n’est pas exécutée, une couche de compatibilité en lecture normalise les anciennes chaînes sans leur attribuer un `publicId` supprimable.
- Frontend : service multipart dédié, mutations TanStack Query, aperçu local immédiat, états par média, retry, révocation des URLs `blob:`, et blocage de la navigation pendant un transfert.

## Décision de nommage Cloudinary

Pour garantir un remplacement sans perte, la couverture est versionnée sous :

`Elintys/{dev|prod}/events/{eventId}/cover/{uuid}`

La galerie utilise :

`Elintys/{dev|prod}/events/{eventId}/gallery/{uuid}`

Le segment logique `cover` reste stable, mais l’actif final reçoit une version unique. Cette variante est nécessaire pour respecter l’ordre sûr « upload → base → suppression de l’ancien » : un écrasement du même `publicId` modifierait l’ancien actif avant la confirmation MongoDB.

## UX de l’étape 5

L’étape devient « identité publique » dans cet ordre :

1. image de couverture dominante ;
2. galerie éditoriale ;
3. description complète ;
4. visibilité et règles d’accès.

La composition reprend les tokens Épure Événementielle : surfaces chaudes, bleu pétrole, or parcimonieux, DM Serif Display, Inter, rayons 24 px, ombres diffuses et densité réduite.
