import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from '../../shared/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Créer un nouveau compte' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: 'Compte créé avec succès', schema: { example: { userId: '664f1a2b3c4d5e6f7a8b9c0d' } } })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 409, description: 'Courriel déjà utilisé' })
  register(@Body() dto: RegisterDto): Promise<{ userId: string }> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Se connecter et obtenir un access token' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Connexion réussie — cookie refresh_token défini', schema: { example: { accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' } } })
  @ApiResponse({ status: 401, description: 'Identifiants invalides' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const { accessToken, refreshToken } = await this.authService.login(dto);
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return { accessToken };
  }

  @ApiBearerAuth('access-token')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Se déconnecter et invalider le refresh token' })
  @ApiResponse({ status: 204, description: 'Déconnexion réussie' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout(user.sub);
    res.clearCookie('refresh_token');
  }

  @ApiBearerAuth('access-token')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renouveler l\'access token via le refresh token' })
  @ApiResponse({ status: 200, description: 'Nouveau access token émis', schema: { example: { accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' } } })
  @ApiResponse({ status: 401, description: 'Refresh token invalide ou expiré' })
  async refresh(
    @CurrentUser() user: JwtPayload,
    @Body('refreshToken') refreshToken: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.authService.refresh(user.sub, refreshToken);
    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return { accessToken: tokens.accessToken };
  }
}
