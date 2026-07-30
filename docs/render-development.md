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
sur l'API de développement afin d'activer les cookies HTTPS inter-domaines;
l'environnement fonctionnel reste identifié par la branche Render `dev`.

`FRONTEND_URL` désigne l'URL Vercel stable de la branche `dev`.
`CORS_ORIGINS` accepte une liste séparée par des virgules pour les autres
origines Preview explicitement autorisées.
