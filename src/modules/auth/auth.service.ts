import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { User, UserDocument, UserRole } from './user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SaveOnboardingDto } from './dto/save-onboarding.dto';
import { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ErrorCodes } from '../../shared/constants/error-codes';
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
  onboardingCompleted: boolean;
  onboardingByRole: Record<string, boolean>;
  onboardingData: Record<string, SavedOnboardingData>;
};

type OnboardingRole = UserRole.ORGANISATEUR | UserRole.PRESTATAIRE | UserRole.GESTIONNAIRE_SALLE;
type OnboardingValue = string | string[] | number;
type SavedOnboardingData = Record<string, OnboardingValue>;
type SaveOnboardingField = keyof SaveOnboardingDto;
type UserProfile = {
  _id: Types.ObjectId;
  fullName: string;
  email: string;
  roles: string[];
  isEmailVerified: boolean;
  subscriptions: object[];
  createdAt?: Date;
  updatedAt?: Date;
  onboardingCompleted?: boolean;
  onboardingByRole?: Record<string, boolean>;
  onboardingData?: unknown;
};

const ONBOARDING_FIELDS_BY_ROLE: Record<OnboardingRole, SaveOnboardingField[]> = {
  [UserRole.ORGANISATEUR]: ['eventTypes', 'frequency', 'avatar', 'displayName', 'city'],
  [UserRole.PRESTATAIRE]: ['category', 'logo', 'description', 'serviceArea', 'rate'],
  [UserRole.GESTIONNAIRE_SALLE]: ['venueName', 'venueType', 'capacity', 'address', 'photo', 'availability'],
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
    if (exists) {
      throw new ConflictException({
        code: ErrorCodes.EMAIL_TAKEN,
        message: 'Un compte existe déjà avec cette adresse courriel. Connectez-vous ou utilisez une autre adresse.',
      });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const user = await this.userModel.create({
      fullName: dto.fullName,
      email: dto.email,
      password: dto.password,
      roles: dto.roles,
      emailVerificationToken: await bcrypt.hash(verificationToken, 12),
      emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
        onboardingCompleted: user.onboardingCompleted,
        onboardingByRole: user.onboardingByRole,
        onboardingData: this.normalizeSavedOnboardingData(user.onboardingData),
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
    if (!user || !isMatch) throw new UnauthorizedException(ErrorCodes.INVALID_CREDENTIALS);

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
        onboardingCompleted: user.onboardingCompleted ?? false,
        onboardingByRole: user.onboardingByRole ?? {},
        onboardingData: this.normalizeSavedOnboardingData(user.onboardingData),
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
      throw new UnauthorizedException(ErrorCodes.REFRESH_TOKEN_INVALID);
    }

    const user = await this.userModel
      .findById(payload.sub)
      .select('+refreshToken')
      .lean();

    if (!user?.refreshToken) throw new UnauthorizedException(ErrorCodes.REFRESH_TOKEN_INVALID);

    const isMatch = await bcrypt.compare(cookieToken, user.refreshToken as string);
    if (!isMatch) throw new UnauthorizedException(ErrorCodes.REFRESH_TOKEN_INVALID);

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
    onboardingCompleted: boolean;
    onboardingByRole: Record<string, boolean>;
    onboardingData: Record<string, SavedOnboardingData>;
  }> {
    const user = await this.userModel
      .findById(userId)
      .lean()
      .select('_id fullName email roles isEmailVerified subscriptions createdAt updatedAt onboardingCompleted onboardingByRole onboardingData');

    if (!user) throw new NotFoundException(ErrorCodes.ACCOUNT_NOT_FOUND);
    const profile = user as unknown as UserProfile;

    return {
      _id: profile._id,
      fullName: profile.fullName,
      email: profile.email,
      roles: profile.roles,
      isEmailVerified: profile.isEmailVerified,
      subscriptions: profile.subscriptions,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      onboardingCompleted: profile.onboardingCompleted ?? false,
      onboardingByRole: profile.onboardingByRole ?? {},
      onboardingData: this.normalizeSavedOnboardingData(profile.onboardingData),
    };
  }

  async saveOnboarding(userId: string, roleParam: string, dto: SaveOnboardingDto): Promise<PublicUser> {
    const role = this.normalizeOnboardingRole(roleParam);
    const user = await this.userModel
      .findById(userId)
      .lean()
      .select('_id fullName email roles isEmailVerified onboardingByRole onboardingData');

    if (!user) throw new NotFoundException(ErrorCodes.ACCOUNT_NOT_FOUND);
    if (!user.roles.includes(role)) {
      throw new ForbiddenException('Ce rôle n’est pas actif sur votre compte.');
    }

    const onboardingData = this.pickOnboardingData(role, dto);

    const updatedUser = await this.userModel
      .findByIdAndUpdate(
        user._id,
        {
          $set: {
            [`onboardingByRole.${role}`]: true,
            [`onboardingData.${role}`]: onboardingData,
            onboardingCompleted: true,
          },
        },
        { new: true },
      )
      .lean()
      .select('_id fullName email roles isEmailVerified onboardingCompleted onboardingByRole onboardingData');

    if (!updatedUser) throw new NotFoundException(ErrorCodes.ACCOUNT_NOT_FOUND);

    return {
      _id: (updatedUser._id as Types.ObjectId).toString(),
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      roles: updatedUser.roles,
      isEmailVerified: updatedUser.isEmailVerified,
      onboardingCompleted: updatedUser.onboardingCompleted ?? false,
      onboardingByRole: updatedUser.onboardingByRole ?? {},
      onboardingData: this.normalizeSavedOnboardingData(updatedUser.onboardingData),
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
      throw new BadRequestException(ErrorCodes.INVALID_RESET_TOKEN);
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
      .find({
        isEmailVerified: false,
        emailVerificationExpiresAt: { $gt: new Date() },
      })
      .select('+emailVerificationToken +emailVerificationExpiresAt')
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
      throw new BadRequestException(ErrorCodes.INVALID_VERIFICATION_TOKEN);
    }

    await this.userModel.findByIdAndUpdate(matchedUser._id, {
      isEmailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiresAt: null,
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
      emailVerificationToken: await bcrypt.hash(verificationToken, 12),
      emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
      algorithm: 'HS256',
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      expiresIn: refreshTokenExpiresIn,
      algorithm: 'HS256',
    });

    return { accessToken, refreshToken };
  }

  private normalizeOnboardingRole(role: string): OnboardingRole {
    if (role === 'gestionnaire') return UserRole.GESTIONNAIRE_SALLE;
    if (
      role === UserRole.ORGANISATEUR ||
      role === UserRole.PRESTATAIRE ||
      role === UserRole.GESTIONNAIRE_SALLE
    ) {
      return role;
    }

    throw new BadRequestException('Rôle d’onboarding invalide.');
  }

  private pickOnboardingData(role: OnboardingRole, dto: SaveOnboardingDto): SavedOnboardingData {
    const candidates: Record<SaveOnboardingField, OnboardingValue | undefined> = {
      eventTypes: dto.eventTypes,
      frequency: dto.frequency,
      avatar: dto.avatar,
      displayName: dto.displayName,
      city: dto.city,
      category: dto.category,
      logo: dto.logo,
      description: dto.description,
      serviceArea: dto.serviceArea,
      rate: dto.rate,
      venueName: dto.venueName,
      venueType: dto.venueType,
      capacity: dto.capacity,
      address: dto.address,
      photo: dto.photo,
      availability: dto.availability,
    };

    return ONBOARDING_FIELDS_BY_ROLE[role].reduce<SavedOnboardingData>((acc, field) => {
      const value = candidates[field];
      if (value === undefined) return acc;
      if (typeof value === 'string' && value.length === 0) return acc;
      if (Array.isArray(value) && value.length === 0) return acc;
      acc[field] = value;
      return acc;
    }, {});
  }

  private normalizeSavedOnboardingData(input: unknown): Record<string, SavedOnboardingData> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

    return Object.entries(input as Record<string, unknown>).reduce<Record<string, SavedOnboardingData>>(
      (roles, [role, data]) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return roles;

        const safeData = Object.entries(data as Record<string, unknown>).reduce<SavedOnboardingData>(
          (fields, [field, value]) => {
            if (typeof value === 'string' || typeof value === 'number') {
              fields[field] = value;
            } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
              fields[field] = value;
            }
            return fields;
          },
          {},
        );

        roles[role] = safeData;
        return roles;
      },
      {},
    );
  }
}
