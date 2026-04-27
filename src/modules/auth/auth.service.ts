import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { SignOptions } from 'jsonwebtoken';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserDocument } from './user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { EmailsService } from '../emails/emails.service';
import { TicketsService } from '../tickets/tickets.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type JwtExpiresIn = SignOptions['expiresIn'];

type PublicUser = {
  _id: string;
  fullName: string;
  email: string;
  roles: string[];
  isEmailVerified: boolean;
};

// Hash bcrypt pré-calculé utilisé comme leurre pour égaliser le temps de réponse
// quand un courriel n'existe pas — empêche l'énumération par timing side-channel
const DUMMY_BCRYPT_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewkJmIdw5MNmveOW';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailsService: EmailsService,
    private readonly ticketsService: TicketsService,
  ) {}

  async register(dto: RegisterDto): Promise<{ accessToken: string; refreshToken: string; user: PublicUser }> {
    const exists = await this.userModel.findOne({ email: dto.email }).lean().select('_id');
    if (exists) throw new ConflictException('Un compte existe déjà avec cet courriel.');

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const user = await this.userModel.create({
      fullName: dto.fullName,
      email: dto.email,
      password: dto.password,
      roles: dto.roles,
      emailVerificationToken: await bcrypt.hash(verificationToken, 10),
    });

    const userId = (user._id as Types.ObjectId).toString();
    const tokens = this.generateTokens({ sub: userId, email: user.email, roles: user.roles });

    await this.userModel.findByIdAndUpdate(user._id, {
      refreshToken: await bcrypt.hash(tokens.refreshToken, 12),
    });

    await Promise.all([
      this.emailsService.sendEmailVerification(user.email, {
        fullName: user.fullName,
        token: verificationToken,
      }).catch((err: unknown) => {
        this.logger.error(`Échec envoi courriel vérification à ${user.email}: ${String(err)}`);
      }),
      this.ticketsService.linkGuestPurchases(user.email, userId),
    ]);

    return {
      accessToken:  tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        _id:             userId,
        fullName:        user.fullName,
        email:           user.email,
        roles:           user.roles,
        isEmailVerified: user.isEmailVerified,
      },
    };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string; refreshToken: string; user: PublicUser }> {
    const user = await this.userModel
      .findOne({ email: dto.email })
      .select('+password +refreshToken')
      .lean();

    // Compare toujours (dummy hash si user absent) pour neutraliser le timing side-channel
    const isMatch = await bcrypt.compare(
      dto.password,
      (user?.password as string | undefined) ?? DUMMY_BCRYPT_HASH,
    );
    if (!user || !isMatch) throw new UnauthorizedException('Courriel ou mot de passe invalide.');

    const userId = (user._id as Types.ObjectId).toString();
    const tokens = this.generateTokens({ sub: userId, email: user.email, roles: user.roles });

    await this.userModel.findByIdAndUpdate(user._id, {
      refreshToken: await bcrypt.hash(tokens.refreshToken, 12),
    });

    return {
      accessToken:  tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        _id:             userId,
        fullName:        user.fullName,
        email:           user.email,
        roles:           user.roles,
        isEmailVerified: user.isEmailVerified,
      },
    };
  }

  async refreshFromCookie(cookieToken: string): Promise<{ accessToken: string; newRefreshToken: string }> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(cookieToken, {
        secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré.');
    }

    const user = await this.userModel
      .findById(payload.sub)
      .select('+refreshToken')
      .lean();

    if (!user?.refreshToken) throw new UnauthorizedException('Session expirée.');

    const isMatch = await bcrypt.compare(cookieToken, user.refreshToken as string);
    if (!isMatch) throw new UnauthorizedException('Refresh token invalide.');

    const tokens = this.generateTokens({
      sub: (user._id as Types.ObjectId).toString(),
      email: user.email,
      roles: user.roles,
    });

    await this.userModel.findByIdAndUpdate(user._id, {
      refreshToken: await bcrypt.hash(tokens.refreshToken, 12),
    });

    return { accessToken: tokens.accessToken, newRefreshToken: tokens.refreshToken };
  }

  async logoutFromCookie(cookieToken: string | undefined): Promise<void> {
    if (!cookieToken) return;
    try {
      const payload = this.jwtService.verify<JwtPayload>(cookieToken, {
        secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
        algorithms: ['HS256'],
      });
      await this.userModel.findByIdAndUpdate(payload.sub, { refreshToken: null });
    } catch {
      // Token expiré ou invalide — rien à révoquer
    }
  }

  async getMe(userId: string): Promise<{
    _id: Types.ObjectId;
    fullName: string;
    email: string;
    roles: string[];
    isEmailVerified: boolean;
    subscriptions: object[];
    createdAt?: Date;
    updatedAt?: Date;
  }> {
    const user = await this.userModel
      .findById(userId)
      .lean()
      .select('_id fullName email roles isEmailVerified subscriptions createdAt updatedAt');

    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user as {
      _id: Types.ObjectId;
      fullName: string;
      email: string;
      roles: string[];
      isEmailVerified: boolean;
      subscriptions: object[];
      createdAt?: Date;
      updatedAt?: Date;
    };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.userModel.findOne({ email }).select('_id email fullName').lean();

    // Réponse identique que l'utilisateur existe ou non — empêche l'énumération de courriels
    if (!user) return;

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 heure

    await this.userModel.findByIdAndUpdate(user._id, {
      passwordResetToken: await bcrypt.hash(resetToken, 10),
      passwordResetExpires: expires,
    });

    // Absorber les erreurs d'envoi — la réponse reste 200 (neutralité de sécurité)
    try {
      await this.emailsService.sendPasswordReset(email, {
        fullName: user.fullName,
        token: resetToken,
      });
    } catch (err) {
      this.logger.error(`Échec envoi courriel réinitialisation à ${email}: ${String(err)}`);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Chercher tous les utilisateurs ayant un token non expiré
    const users = await this.userModel
      .find({
        passwordResetExpires: { $gt: new Date() },
      })
      .select('+passwordResetToken passwordResetExpires')
      .lean();

    let matchedUser: (typeof users)[number] | null = null;
    for (const user of users) {
      if (!user.passwordResetToken) continue;
      const isMatch = await bcrypt.compare(token, user.passwordResetToken as string);
      if (isMatch) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      throw new BadRequestException('Lien de réinitialisation invalide ou expiré.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.userModel.findByIdAndUpdate(matchedUser._id, {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
      refreshToken: null, // invalider toutes les sessions existantes
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const users = await this.userModel
      .find({ isEmailVerified: false })
      .select('+emailVerificationToken')
      .lean();

    let matchedUser: (typeof users)[number] | null = null;
    for (const user of users) {
      if (!user.emailVerificationToken) continue;
      const isMatch = await bcrypt.compare(token, user.emailVerificationToken as string);
      if (isMatch) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      throw new BadRequestException('Lien de vérification invalide ou déjà utilisé.');
    }

    await this.userModel.findByIdAndUpdate(matchedUser._id, {
      isEmailVerified: true,
      emailVerificationToken: null,
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.userModel
      .findOne({ email, isEmailVerified: false })
      .select('_id email fullName')
      .lean();

    // Silencieux si non trouvé ou déjà vérifié
    if (!user) return;

    const verificationToken = crypto.randomBytes(32).toString('hex');

    await this.userModel.findByIdAndUpdate(user._id, {
      emailVerificationToken: await bcrypt.hash(verificationToken, 10),
    });

    try {
      await this.emailsService.sendEmailVerification(email, {
        fullName: user.fullName,
        token: verificationToken,
      });
    } catch (err) {
      this.logger.error(`Échec envoi courriel vérification à ${email}: ${String(err)}`);
    }
  }

  private generateTokens(payload: JwtPayload): TokenPair {
    const accessTokenExpiresIn = this.configService.getOrThrow('jwt.expiresIn') as JwtExpiresIn;
    const refreshTokenExpiresIn = this.configService.getOrThrow('jwt.refreshExpiresIn') as JwtExpiresIn;

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('jwt.secret'),
      expiresIn: accessTokenExpiresIn,
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      expiresIn: refreshTokenExpiresIn,
    });

    return { accessToken, refreshToken };
  }
}
