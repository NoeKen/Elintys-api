import { PickType } from '@nestjs/swagger';
import { QueryVenueDto } from './query-venue.dto';

export class QueryMyVenuesDto extends PickType(QueryVenueDto, ['page', 'limit'] as const) {}
