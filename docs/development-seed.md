# Données de démonstration — développement

La commande suivante ajoute ou met à jour les données de démonstration sans
supprimer les données existantes :

```bash
npm run seed:dev
```

Elle refuse de démarrer sauf si :

- `ELINTYS_ENV=dev` (garde-fou métier indépendant de `NODE_ENV`);
- `MONGODB_URI` cible une base nommée exactement `elintys-dev`.

Elle est idempotente : les utilisateurs sont identifiés par courriel, les
profils par utilisateur et les événements par slug. Elle ne fait aucun
`deleteMany`, `dropDatabase` ou remplacement global.

## Comptes de démonstration

Ces identifiants sont publics et réservés exclusivement à la base dev :

| Rôle | Courriel |
| --- | --- |
| Organisateur | `organisateur@demo.elintys.com` |
| Prestataire | `prestataire@demo.elintys.com` |
| Gestionnaire de lieu | `gestionnaire@demo.elintys.com` |
| Participant | `participant@demo.elintys.com` |

Mot de passe commun : `Elintys-Dev-2026!`

Ne jamais réutiliser ce mot de passe pour un compte réel. Le seed garantit au
moins dix prestataires actifs, dix lieux actifs et dix événements publics,
ainsi qu'un brouillon, afin de tester les catalogues et le tableau de bord.
Chaque profil possède un utilisateur de démonstration vérifié; la collection
des utilisateurs contient donc plus de dix entrées.
