# Cookies d'authentification et observabilité HTTP

## Domaines apparentés

L'API conserve les jetons dans des cookies host-only `HttpOnly`,
`SameSite=Lax` et `Secure` dès qu'elle est déployée
(`NODE_ENV=production`). Aucun attribut `Domain` n'est émis.

| Environnement | Frontend | API | `COOKIE_DOMAIN` |
| --- | --- | --- | --- |
| Développement hébergé | `https://dev.elintys.com` | `https://api.dev.elintys.com` | omis |
| Production | `https://app.elintys.com` | `https://api.elintys.com` | omis |

`COOKIE_DOMAIN` doit rester vide dans tous les environnements. L'API refuse de
démarrer si une valeur est définie. Le navigateur limite ainsi les cookies à
l'hôte API qui les a émis: `api.dev.elintys.com` en développement et
`api.elintys.com` en production. `ELINTYS_ENV` reste obligatoire dans un
runtime déployé afin d'isoler la base de données et les médias.

La suppression des cookies réutilise exactement le même domaine, chemin et les
mêmes attributs de sécurité que leur création.

## Protection des requêtes d'écriture

CORS est limité aux origines exactes définies par `FRONTEND_URL` et
`CORS_ORIGINS`. En complément, les requêtes navigateur `POST`, `PUT`, `PATCH`
et `DELETE` dont l'en-tête `Origin` ne correspond pas à cette liste sont
refusées avec un statut 403. Une écriture sans `Origin` est également refusée
si elle transporte un cookie d'authentification. Ce contrôle évite qu'un site
tiers déclenche une écriture authentifiée sans pouvoir lire la réponse. Les
lectures, les pré-requêtes `OPTIONS` et les clients serveur ou natifs sans
cookie restent autorisés.

## Corrélation et logs réseau

L'API accepte un en-tête `x-request-id` composé de 1 à 128 caractères
alphanumériques ou parmi `._:-`. Une valeur absente ou invalide est remplacée
par un UUID généré côté API. Le même identifiant est renvoyé dans la réponse.

Chaque réponse terminée produit une ligne JSON sur la sortie standard :

```json
{
  "event": "http_request",
  "service": "elintys-api",
  "environment": "dev",
  "requestId": "01J...",
  "method": "GET",
  "route": "/api/v1/events",
  "status": 200,
  "durationMs": 42.17
}
```

Les erreurs serveur produisent un événement `http_exception` corrélé. Les logs
n'incluent ni corps, ni paramètres de requête, ni chaîne de requête, ni
en-têtes, ni cookies, ni jetons. Render collecte ces lignes depuis la sortie
standard; aucune collection MongoDB n'est utilisée pour les logs réseau.
