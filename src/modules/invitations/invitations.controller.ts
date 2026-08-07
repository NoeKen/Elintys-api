import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_TIERS } from '../../config/throttle.config';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  create(
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.invitationsService.sendInvitation(user.sub, dto);
  }

  @Get('me')
  findMine(@CurrentUser() user: JwtPayload) {
    return this.invitationsService.getMyInvitations(user.sub);
  }

  @Public()
  @Post('accept/:token')
  @Throttle({ default: THROTTLE_TIERS.INVITATION_ACCEPT })
  accept(@Param('token') token: string) {
    return this.invitationsService.acceptInvitation(token);
  }
}
