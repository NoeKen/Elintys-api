import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';
import { THROTTLE_TIERS } from '../../config/throttle.config';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { SaveOnboardingDto } from './dto/save-onboarding.dto';
import { Public } from '../../shared/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private get sharedCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.configService.getOrThrow<boolean>('authCookie.secure'),
      sameSite: 'lax',
      path: '/',
    };
  }

  private get refreshCookieOptions(): CookieOptions {
    return {
      ...this.sharedCookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
  }

  private get accessCookieOptions(): CookieOptions {
    return {
      ...this.sharedCookieOptions,
      maxAge: 15 * 60 * 1000,
    };
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie('access_token', accessToken, this.accessCookieOptions);
    res.cookie('refresh_token', refreshToken, this.refreshCookieOptions);
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un nouveau compte' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: 'Compte créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 409, description: 'Courriel déjà utilisé' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: object }> {
    const { accessToken, refreshToken, user } = await this.authService.register(dto);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { user };
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Se connecter et obtenir un access token' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Connexion réussie — cookies access_token et refresh_token définis' })
  @ApiResponse({ status: 401, description: 'Identifiants invalides' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: object }> {
    const { accessToken, refreshToken, user } = await this.authService.login(dto);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Renouveler la session via le cookie refresh_token httpOnly" })
  @ApiResponse({ status: 200, description: 'Nouveaux cookies access_token et refresh_token émis' })
  @ApiResponse({ status: 401, description: 'Cookie absent ou refresh token invalide' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const cookieToken = (req.cookies as Record<string, string>)?.refresh_token;

    if (!cookieToken) {
      throw new UnauthorizedException('Aucun refresh token fourni.');
    }

    const { accessToken, newRefreshToken } = await this.authService.refreshFromCookie(cookieToken);

    this.setAuthCookies(res, accessToken, newRefreshToken);
    return { message: 'Session renouvelée.' };
  }

  @ApiBearerAuth('access-token')
  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Récupérer le profil de l'utilisateur connecté" })
  @ApiResponse({ status: 200, description: 'Profil utilisateur' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  async getMe(@CurrentUser() user: JwtPayload) {
    return this.authService.getMe(user.sub);
  }

  @Patch('onboarding/:role')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "Sauvegarder l'onboarding du rôle connecté" })
  @ApiBody({ type: SaveOnboardingDto })
  @ApiResponse({ status: 200, description: 'Onboarding sauvegardé' })
  @ApiResponse({ status: 400, description: 'Rôle ou données invalides' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: "Le compte ne possède pas ce rôle" })
  async saveOnboarding(
    @CurrentUser() user: JwtPayload,
    @Param('role') role: string,
    @Body() dto: SaveOnboardingDto,
  ): Promise<{ user: object }> {
    const updatedUser = await this.authService.saveOnboarding(user.sub, role, dto);
    return { user: updatedUser };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Se déconnecter — efface le cookie et révoque la session en base' })
  @ApiResponse({ status: 200, description: 'Déconnecté avec succès' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const cookieToken = (req.cookies as Record<string, string>)?.refresh_token;
    await this.authService.logoutFromCookie(cookieToken);
    res.clearCookie('access_token', this.sharedCookieOptions);
    res.clearCookie('refresh_token', this.sharedCookieOptions);
    return { message: 'Déconnecté avec succès' };
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.FORGOT_PASSWORD })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Demander un lien de réinitialisation de mot de passe' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, description: 'Lien envoyé si le courriel existe (toujours 200)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto.email);
    return { message: 'Si un compte existe avec cet courriel, un lien a été envoyé.' };
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réinitialiser le mot de passe avec le token reçu par courriel' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, description: 'Mot de passe réinitialisé avec succès' })
  @ApiResponse({ status: 400, description: 'Token invalide ou expiré' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: 'Mot de passe réinitialisé avec succès.' };
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Vérifier l'adresse courriel avec le token reçu" })
  @ApiBody({ type: VerifyEmailDto })
  @ApiResponse({ status: 200, description: 'Courriel vérifié avec succès' })
  @ApiResponse({ status: 400, description: 'Token invalide ou déjà utilisé' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    await this.authService.verifyEmail(dto.token);
    return { message: 'Adresse courriel vérifiée avec succès.' };
  }

  @Public()
  @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Renvoyer le courriel de vérification d'adresse" })
  @ApiBody({ type: ResendVerificationDto })
  @ApiResponse({ status: 200, description: 'Courriel renvoyé si le compte existe et non vérifié (toujours 200)' })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    await this.authService.resendVerification(dto.email);
    return { message: 'Si un compte non vérifié existe avec cet courriel, un lien a été renvoyé.' };
  }
}
