# API de développement sur Render

Le fichier `render.yaml` décrit le service `elintys-api-dev` :

- dépôt `NoeKen/Elintys-api`, branche `dev`;
- déploiement automatique à chaque commit;
- build reproductible sous Node.js 22 avec installation des outils de
  compilation, puis suppression des dépendances de développement;
- démarrage avec `npm run start:prod`;
- contrôle de santé sur `/api/v1/health`.

Les secrets sont déclarés avec `sync: false` et doivent être fournis dans
Render. Ils ne sont jamais stockés dans Git. `NODE_ENV=production` reste requis
sur l'API de développement afin d'activer les cookies `Secure` et les autres
protections de production; `ELINTYS_ENV=dev` isole les données et les médias.

Le frontend de développement est `https://dev.elintys.com` et l'API est
exposée par `https://api.dev.elintys.com`. `FRONTEND_URL` vaut donc exactement
`https://dev.elintys.com`. `COOKIE_DOMAIN` doit rester omis afin que les
cookies d'authentification restent limités à l'hôte API.
`CORS_ORIGINS` accepte une liste séparée par des virgules pour les autres
origines Preview explicitement autorisées.
