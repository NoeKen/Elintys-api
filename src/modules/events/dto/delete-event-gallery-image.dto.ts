import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteEventGalleryImageDto {
  @ApiProperty({
    example: 'Elintys/dev/events/64f0.../gallery/550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  publicId!: string;
}
