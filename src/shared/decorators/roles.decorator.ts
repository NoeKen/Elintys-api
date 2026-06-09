import { SetMetadata } from '@nestjs/common';

export enum Role {
  ADMIN = 'admin',
  ORGANISATEUR = 'organisateur',
  PRESTATAIRE = 'prestataire',
  PARTICIPANT = 'participant',
  GESTIONNAIRE_SALLE = 'gestionnaire_salle',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
