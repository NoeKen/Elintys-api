# Elintys-api — Workflows Claude Code

Ces workflows définissent l'ordre exact des opérations à suivre.
Chaque étape marquée `[Skill]` requiert d'invoquer le skill via l'outil `Skill`.

---

## Workflow : Nouveau module NestJS

> Exemple : PaymentsModule, AiModule, NotificationsModule

1. Lire `CLAUDE.md` racine
2. `[Skill: superpowers:writing-plans]` — produire le plan complet avant tout code
   - Définir : schema → DTOs → service → controller → module → tests
3. Créer le schema Mongoose (`<nom>.schema.ts`)
4. Créer les DTOs (`create-<nom>.dto.ts`, `update-<nom>.dto.ts`, `query-<nom>.dto.ts`)
5. `[Skill: superpowers:test-driven-development]` — écrire les tests avant le service
6. Implémenter le service (`<nom>.service.ts`)
7. Implémenter le controller (`<nom>.controller.ts`)
8. Créer le module (`<nom>.module.ts`) et l'ajouter dans `app.module.ts`
9. `[Skill: vibesec:vibesec]` — scanner les endpoints créés
10. `[Skill: superpowers:verification-before-completion]` — `npm run lint && npx tsc --noEmit && npm test`
11. `[Skill: code-review:code-review]` — review avant livraison

---

## Workflow : Endpoint sensible
> Auth, paiements, webhook Stripe, scan QR, route @Public()

1. `[Skill: vibesec:vibesec]` — **en premier**, avant toute implémentation
2. Implémenter avec le guard approprié (`@Roles()`, vérifier l'absence de `@Public()` si protégé)
3. Pour webhook Stripe : vérifier HMAC dans `rawBody` avant tout traitement
4. Pour refresh token : vérifier JWT **et** bcrypt hash stocké en base
5. Écrire les tests : cas succès + UnauthorizedException + ForbiddenException
6. `[Skill: superpowers:verification-before-completion]` — tests doivent passer à 100%
7. `[Skill: code-review:code-review]` — review obligatoire

---

## Workflow : Débogage d'un bug ou test qui échoue

1. `[Skill: superpowers:systematic-debugging]` — avant toute hypothèse
2. Reproduire le bug avec un test minimal
3. Identifier la couche (DTO validation / Guard / Service / Mongoose)
4. Corriger sans modifier les tests existants qui passent
5. Vérifier que `npm test` est vert globalement

---

## Workflow : Livraison de sprint (Elintys-api)

1. `[Skill: code-review:code-review]` — review de tous les fichiers modifiés
2. `[Skill: vibesec:vibesec]` — scan sécurité global (focus : endpoints @Public, Stripe, auth)
3. `npm run lint && npx tsc --noEmit && npm test`
4. Vérifier coverage : `npm test -- --coverage` → cible 80% statements/functions
5. Mettre à jour `CLAUDE.md` si nouveau pattern établi
6. Commit avec Conventional Commits :
   - `feat(module):` pour nouveau module
   - `fix(module):` pour correction
   - `refactor(module):` pour restructuration sans changement fonctionnel

---

## Checklist qualité Elintys-api

- [ ] Zéro `any` TypeScript (`noImplicitAny: true`)
- [ ] `.lean()` sur toutes les lectures Mongoose
- [ ] Pagination sur tous les endpoints de liste (`page` + `limit`)
- [ ] Messages d'erreur en français québécois
- [ ] `ConfigService.getOrThrow()` — jamais `process.env.*`
- [ ] Guard présent sur toutes les routes non-`@Public()`
- [ ] Tests AAA avec `'devrait [comportement attendu]'`
- [ ] Aucun module Phase 2 (chat, agreements) sans validation explicite
