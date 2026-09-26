import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_EMAIL_KEY = 'allowUnverifiedEmail';

/**
 * Exception explicite à la règle « courriel non vérifié = lecture seule ».
 *
 * Par défaut, toute requête authentifiée mutante (POST/PUT/PATCH/DELETE…)
 * d'un compte dont `isEmailVerified === false` est refusée en 403
 * `EMAIL_NOT_VERIFIED` (cf. `EmailVerifiedGuard`, appliqué par `JwtAuthGuard`).
 *
 * N'appliquer ce décorateur (sur un handler ou un controller) qu'aux routes
 * justifiées : cycle de vie de l'authentification, vérification du courriel,
 * sécurité du compte, retrait de consentement / suppression de compte
 * (Loi 25). Chaque usage doit figurer dans la matrice d'exceptions documentée.
 */
export const AllowUnverifiedEmail = () => SetMetadata(ALLOW_UNVERIFIED_EMAIL_KEY, true);
