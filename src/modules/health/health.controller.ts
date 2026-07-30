import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: "Vérifier que l'API est disponible" })
  @ApiResponse({ status: 200, description: "L'API est opérationnelle" })
  check(): { status: 'ok'; service: 'elintys-api' } {
    return {
      status: 'ok',
      service: 'elintys-api',
    };
  }
}
