# Cookies d'authentification et observabilité HTTP

## Domaines apparentés

L'API conserve les jetons dans des cookies `HttpOnly`, `SameSite=Lax` et
`Secure` dès qu'elle est déployée (`NODE_ENV=production`) ou qu'un domaine de
cookie est configuré.

| Environnement | Frontend | API | `COOKIE_DOMAIN` |
| --- | --- | --- | --- |
| Développement hébergé | `https://app.dev.elintys.app` | `https://api.dev.elintys.app` | `.dev.elintys.app` |
| Production | `https://app.elintys.com` | `https://api.elintys.com` | `.elintys.com` |

`COOKIE_DOMAIN` doit commencer par un point, être un nom DNS valide et être un
domaine parent de l'hôte défini par `FRONTEND_URL`. L'API refuse de démarrer si
une valeur configurée ne respecte pas ces contraintes. `ELINTYS_ENV=dev`
impose `.dev.elintys.app`, tandis que `ELINTYS_ENV=prod` impose `.elintys.com`.
Les domaines enregistrables distincts empêchent un hôte de développement de
recevoir ou d'émettre les cookies de production.
Dans un runtime déployé (`NODE_ENV=production`), `ELINTYS_ENV` et
`COOKIE_DOMAIN` sont obligatoires. En local, la variable de domaine doit être
omise pour utiliser un cookie limité à l'hôte.

La suppression des cookies réutilise exactement le même domaine, chemin et les
mêmes attributs de sécurité que leur création.

## Protection des requêtes d'écriture

CORS est limité aux origines exactes définies par `FRONTEND_URL` et
`CORS_ORIGINS`. En complément, les requêtes navigateur `POST`, `PUT`, `PATCH`
et `DELETE` dont l'en-tête `Origin` ne correspond pas à cette liste sont
refusées avec un statut 403. Ce contrôle évite qu'un site tiers déclenche une
écriture authentifiée sans pouvoir lire la réponse. Les lectures, les
pré-requêtes `OPTIONS` et les clients serveur ou natifs sans en-tête `Origin`
restent autorisés.

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
