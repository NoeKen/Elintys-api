import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateGuestDto } from './create-guest.dto';
import { ApiProperty } from '@nestjs/swagger';

export class BulkCreateGuestDto {
  @ApiProperty({ type: [CreateGuestDto], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateGuestDto)
  guests!: CreateGuestDto[];
}
