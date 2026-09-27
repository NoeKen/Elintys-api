# Vérification du courriel — « non vérifié = lecture seule »

## Règle

Un utilisateur **authentifié** dont `isEmailVerified !== true` peut lire,
mais toute requête **mutante** (toute méthode autre que `GET`, `HEAD`,
`OPTIONS`) est refusée, sauf exception explicite. Le serveur fait autorité ;
le web ne fait qu'afficher l'état et guider l'utilisateur.

Réponse de refus (enveloppe standard `AllExceptionsFilter`) :

```json
{
  "statusCode": 403,
  "message": "Veuillez vérifier votre adresse courriel avant d’effectuer cette action.",
  "code": "EMAIL_NOT_VERIFIED",
  "requestId": "…",
  "timestamp": "…",
  "path": "/api/v1/…"
}
```

## Implémentation

| Élément | Fichier |
| --- | --- |
| Guard | `src/shared/guards/email-verified.guard.ts` (`EmailVerifiedGuard`) |
| Point d'application | `src/shared/guards/jwt-auth.guard.ts` : exécuté **dans** `JwtAuthGuard`, juste après l'authentification Passport (garantit que `req.user` est peuplé, sans dépendre de l'ordre des guards) |
| Exception | `src/shared/decorators/allow-unverified-email.decorator.ts` (`@AllowUnverifiedEmail()`, sur handler ou controller) |
| Code d'erreur | `ErrorCodes.EMAIL_NOT_VERIFIED` (`src/shared/constants/error-codes.ts`) |
| Tests | `src/shared/guards/email-verified.guard.spec.ts`, `src/shared/guards/jwt-auth.guard.spec.ts`, `test/email-verification-read-only.e2e-spec.ts` |

Propriétés :

- `isEmailVerified` est **relu en base** par `JwtStrategy.validate` à chaque
  requête, jamais depuis le JWT : un utilisateur qui vient de vérifier son
  adresse est débloqué sans nouveau jeton (test e2e dédié).
- Fail-closed : seul `true` laisse passer une mutation.
- Routes `@Public()` : `JwtAuthGuard` ne peuple pas `req.user`, la règle ne
  s'applique pas (une requête mutante non authentifiée vers une route
  protégée reste un **401**, pas un 403).
- Ajouter une exception exige de la documenter dans la matrice ci-dessous.

## Matrice des exceptions (`@AllowUnverifiedEmail()`)

Relevé exhaustif (`grep -rn AllowUnverifiedEmail src`) au 2026-09-26 :

| Route | Public | Justification |
| --- | --- | --- |
| `POST /auth/register` | oui | cycle de vie de l'authentification |
| `POST /auth/login` | oui | idem |
| `POST /auth/refresh` | oui | idem |
| `POST /auth/logout` | oui | idem |
| `POST /auth/forgot-password` | oui | sécurité du compte |
| `POST /auth/reset-password` | oui | sécurité du compte |
| `POST /auth/verify-email` | oui | vérification du courriel |
| `POST /auth/resend-verification` | oui | vérification du courriel |
| `POST /auth/me/resend-verification` | non | vérification du courriel (adresse authentifiée) |
| `POST /auth/me/change-password` | non | sécurité du compte |
| `PATCH /auth/me/notification-preferences` | non | retrait de consentement aux courriels (Loi 25) |
| `PATCH /auth/onboarding/:role` | non | finalisation de l'onboarding du rôle |
| `PATCH /notifications/:id/read` | non | état de lecture d'une notification personnelle |
| `PATCH /notifications/read-all` | non | idem |

Sur les routes publiques, le décorateur est défensif (sans effet tant que la
route reste `@Public()`) : il garantit que l'exception survit si la route
devenait authentifiée.

Pas d'exception, donc **refusées** tant que l'adresse n'est pas vérifiée
(exemples couverts par l'e2e) : `PATCH /auth/me/profile`,
`POST /auth/me/roles`, `POST /ticket-orders`, `POST /ticket-orders/:id/cancel`,
`POST /event-registrations`, `POST /favorites`, `POST /reviews`,
`POST /events`, `PUT /events/:id`, `PATCH /events/:id/publish`,
`DELETE /events/:id`, `POST /vendors`, `PUT /vendors/me`,
`POST /vendors/:id/requests`, `PATCH /vendors/requests/:id/respond`,
`POST /venues`, `PUT /venues/me`, `POST /venues/:id/bookings`,
`PATCH /venues/bookings/:id/respond`.

Lectures autorisées vérifiées par l'e2e : `GET /auth/me`,
`GET /ticket-orders/me`, `GET /favorites`, `GET /event-registrations/me`,
`GET /events/my`, `GET /events/:id`, `GET /vendors/me`,
`GET /vendors/requests/my`, `GET /venues/mine`, `GET /venues/bookings/my`.

### Écarts à connaître

- **Suppression de compte** : la règle produit l'autorise pour un compte non
  vérifié (droit légal), mais **aucune route de suppression de compte
  n'existe** dans l'API actuelle. À ajouter à la matrice le jour où elle sera
  créée.
- Routes publiques mutantes non concernées par la règle (aucun utilisateur
  attaché) : `POST /waitlist`, `POST /events/:id/access/code/verify`,
  `POST /invitations/accept/:token`, webhooks `POST /payments/webhook`
  (Stripe) et `POST /payments/paypal/webhook`.

## Achats invités

Les achats effectués en invité avec une adresse ne sont rattachés au compte
portant cette adresse **qu'après** `POST /auth/verify-email` (preuve de
propriété de l'adresse), et non plus à l'inscription
(`AuthService`, appel `ticketsService.linkGuestPurchases`).

## Côté web

`src/features/auth/email-verification/` : bannière pour les comptes non
vérifiés (adresse affichée, renvoi avec délai de 60 s
`RESEND_COOLDOWN_SECONDS`, confirmation, déconnexion) ; toute réponse
403 `EMAIL_NOT_VERIFIED` d'une mutation ouvre la boîte de dialogue de
vérification via le client API partagé (`src/shared/lib/api.ts`) — jamais
d'échec silencieux. Parcours couvert par `e2e/smoke/email-verification.spec.ts`.
