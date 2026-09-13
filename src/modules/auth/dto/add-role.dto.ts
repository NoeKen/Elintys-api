import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../user.schema';

const ADDABLE_ROLES = [
  UserRole.ORGANISATEUR,
  UserRole.PRESTATAIRE,
  UserRole.GESTIONNAIRE_SALLE,
] as const;

type AddableUserRole = (typeof ADDABLE_ROLES)[number];

export class AddRoleDto {
  @ApiProperty({ enum: ADDABLE_ROLES })
  @IsIn(ADDABLE_ROLES)
  role!: AddableUserRole;
}
