import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { Model } from 'mongoose';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { User, UserDocument } from '../user.schema';

function extractJwtFromAccessCookie(request: Request): string | null {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.access_token ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        extractJwtFromAccessCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
      algorithms: ['HS256'],
    });
  }

  /**
   * La même lecture (lean, deux champs) vérifie l'existence du compte ET
   * rapporte `isEmailVerified` depuis la base : un JWT émis avant la
   * vérification resterait sinon « non vérifié » jusqu'à son expiration, et
   * inversement le JWT ne peut jamais servir à contourner la règle.
   * Toute valeur éventuellement présente dans le payload est écrasée.
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const user = await this.userModel
      .findById(payload.sub)
      .lean()
      .select('_id isEmailVerified');
    if (!user) throw new UnauthorizedException('Utilisateur introuvable.');
    return { ...payload, isEmailVerified: user.isEmailVerified === true };
  }
}
