import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { EventAccessRequestStatus } from '../event-access-request.schema';

export class VerifyEventAccessCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  code!: string;
}

export class ReviewEventAccessRequestDto {
  @IsIn([EventAccessRequestStatus.APPROVED, EventAccessRequestStatus.REJECTED])
  status!: EventAccessRequestStatus.APPROVED | EventAccessRequestStatus.REJECTED;
}
