import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { QueryVendorDto } from './dto/query-vendor.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post()
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVendorDto) {
    return this.vendorsService.create(user.sub, dto);
  }

  @Public()
  @Get()
  findAll(@Query() query: QueryVendorDto) {
    return this.vendorsService.findAll(query);
  }

  @Get('me')
  @Roles(Role.PRESTATAIRE)
  myProfile(@CurrentUser() user: JwtPayload) {
    return this.vendorsService.findMyProfile(user.sub);
  }

  @Public()
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vendorsService.findOne(id);
  }

  @Put(':id')
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVendorDto) {
    return this.vendorsService.update(id, user.sub, dto);
  }
}
