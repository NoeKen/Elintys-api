# Stockage média ELINTYS

## Vue d’ensemble

Les images sont stockées dans Cloudinary. MongoDB ne conserve que les métadonnées nécessaires :

```ts
interface MediaImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
}
```

Le modèle Event utilise :

```ts
coverImage?: MediaImage;
gallery: MediaImage[];
```

Le fichier binaire, le base64 et les transformations dérivées ne sont jamais stockés dans MongoDB.

## Configuration locale

Ajouter les valeurs dans `Elintys-api/.env` :

```dotenv
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Ne jamais utiliser de variable `NEXT_PUBLIC_*` pour la clé ou le secret. Le navigateur envoie uniquement un multipart au backend authentifié.

Le backend peut démarrer sans Cloudinary afin de ne pas bloquer les fonctions non média. Un appel média sans configuration retourne `503 MEDIA_STORAGE_NOT_CONFIGURED`.

## Architecture

- `MediaStorage` : contrat agnostique du domaine.
- `CloudinaryMediaStorageService` : implémentation du contrat.
- `ImageFileValidationService` : validation et normalisation sécurisées.
- `EventMediaService` : appartenance, transactions logiques et cohérence Event.
- `MediaCleanupService` : file MongoDB durable et retry périodique des suppressions distantes échouées.

`CloudinaryMediaStorageService` ne dépend jamais d’Event ni de Mongoose.

## Organisation Cloudinary

```text
Elintys/{dev|prod}/events/{eventId}/cover/{uuid}
Elintys/{dev|prod}/events/{eventId}/gallery/{uuid}
```

`ELINTYS_ENV` détermine strictement le segment `dev` ou `prod`. Le service
refuse l’upload si l’environnement applicatif est absent ou invalide.

La couverture est versionnée pour respecter l’ordre :

1. upload du nouvel actif ;
2. persistance MongoDB ;
3. suppression de l’ancien actif.

Écraser un `publicId` fixe modifierait le média existant avant la confirmation MongoDB et empêcherait un rollback propre.

## Endpoints

Tous les endpoints exigent JWT, rôle organisateur/admin et appartenance de l’événement.

### Couverture

```http
POST /api/v1/events/:eventId/cover
Content-Type: multipart/form-data
file: <binary>
```

```http
DELETE /api/v1/events/:eventId/cover
```

### Galerie

```http
POST /api/v1/events/:eventId/gallery
Content-Type: multipart/form-data
files: <binary[]>
```

```http
DELETE /api/v1/events/:eventId/gallery
Content-Type: application/json

{ "publicId": "Elintys/dev/events/..." }
```

La réponse commune est :

```json
{
  "coverImage": {
    "url": "https://res.cloudinary.com/...",
    "publicId": "Elintys/dev/events/.../cover/...",
    "width": 1920,
    "height": 1080
  },
  "gallery": []
}
```

## Validation et limites

- JPG, PNG ou WebP uniquement ;
- 10 Mo maximum par fichier ;
- dix images maximum dans la galerie ;
- MIME déclaré vérifié ;
- signature binaire vérifiée ;
- décodage complet et réencodage avec Sharp ;
- images animées refusées ;
- limite de 25 mégapixels, alignée sur la limite du compte Cloudinary et protégeant contre les bombes de décompression ;
- stockage Multer en mémoire, avec nombre et taille bornés ;
- validation séquentielle et uploads Cloudinary limités à trois en parallèle ;
- 20 requêtes média par minute et par clé Throttler/IP sur les routes d’upload.

SVG, GIF et contenus corrompus sont refusés.

## Cohérence et erreurs

### Remplacement

- Si l’upload échoue, MongoDB reste inchangé.
- Si MongoDB échoue après upload, le nouvel actif est supprimé.
- Si ce nettoyage échoue, une tâche durable `media_cleanup_tasks` est créée.
- L’ancien actif n’est supprimé qu’après persistance du nouveau.

### Suppression

- La référence MongoDB est retirée en premier.
- La suppression Cloudinary vient ensuite.
- L’opération est idempotente.
- Un échec Cloudinary ne restaure pas une référence devenue invalide ; il est placé dans la file de cleanup.

### Suppression d’événement

Event utilise un hard delete. Après suppression MongoDB réussie, la couverture et la galerie gérées par ELINTYS sont supprimées ou placées dans la file de cleanup.

Les `publicId` sont vérifiés contre le préfixe de l’événement avant toute destruction, ce qui empêche la suppression d’un actif arbitraire.

## URLs de diffusion

La base conserve l’URL source. Le frontend ajoute les transformations Cloudinary à la lecture :

- couverture : `1920 × 1080`, `c_fill`, `g_auto`, `f_auto`, `q_auto` ;
- carte : `800 × 520` ;
- miniature : `360 × 240`.

Les anciennes URLs non Cloudinary sont rendues sans transformation.

## Migration héritée

La collection locale contenait six `coverImage` de type chaîne, toutes hébergées par Unsplash.

Dry-run :

```bash
npm run media:migrate
```

Exécution après configuration de Cloudinary :

```bash
npm run media:migrate -- --execute
```

La migration :

1. sélectionne uniquement les chaînes héritées ;
2. autorise seulement HTTPS sur `images.unsplash.com` ou `res.cloudinary.com` ;
3. refuse les redirections, applique un timeout et borne le flux à 10 Mo ;
4. valide et redécode l’image ;
5. l’upload dans le dossier de l’événement ;
6. remplace le champ avec une condition atomique sur l’ancienne valeur ;
7. supprime l’actif nouvellement créé si une modification concurrente est détectée.

Jusqu’à son exécution, le backend tolère la chaîne héritée en lecture et le frontend l’affiche. Une chaîne externe n’est jamais considérée comme un actif Cloudinary supprimable.

## Vérification

Automatique :

```bash
npm run build
npm test -- --runInBand
```

Manuelle avec de vrais identifiants Cloudinary :

1. téléverser une couverture ;
2. recharger la page et se reconnecter ;
3. remplacer la couverture ;
4. ajouter plusieurs images ;
5. supprimer une image ;
6. confirmer dans Cloudinary que l’ancien actif a disparu ;
7. confirmer dans MongoDB que seuls `url`, `publicId`, `width`, `height` sont présents ;
8. exécuter la migration héritée ;
9. supprimer un événement de test et confirmer le nettoyage du dossier logique.
