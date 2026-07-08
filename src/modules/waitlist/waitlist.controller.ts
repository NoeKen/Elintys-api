import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { WaitlistService } from './waitlist.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';

@ApiTags('Waitlist')
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlistService: WaitlistService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @Post()
  @ApiOperation({ summary: "Rejoindre la liste d'attente" })
  @ApiResponse({ status: 201, description: 'Inscription confirmée' })
  async join(@Body() dto: CreateWaitlistEntryDto) {
    const { alreadyExists } = await this.waitlistService.join(dto);
    return { success: true, alreadyExists };
  }

  @Public()
  @Get('count')
  @ApiOperation({ summary: "Nombre d'inscrits à la liste d'attente" })
  @ApiResponse({ status: 200, description: 'Total des inscrits' })
  async count() {
    const count = await this.waitlistService.count();
    return { count };
  }
}
