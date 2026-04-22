import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from '../../shared/decorators/current-user.decorator';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<{ userId: string }> {
    const exists = await this.userModel.findOne({ email: dto.email }).lean().select('_id');
    if (exists) throw new ConflictException('Un compte existe déjà avec cet courriel.');

    const user = await this.userModel.create({
      fullName: dto.fullName,
      email: dto.email,
      password: dto.password,
      roles: [dto.role],
    });

    return { userId: (user._id as Types.ObjectId).toString() };
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.userModel
      .findOne({ email: dto.email })
      .select('+password +refreshToken')
      .lean();

    if (!user) throw new UnauthorizedException('Courriel ou mot de passe invalide.');

    const isMatch = await bcrypt.compare(dto.password, user.password as string);
    if (!isMatch) throw new UnauthorizedException('Courriel ou mot de passe invalide.');

    const tokens = this.generateTokens({
      sub: (user._id as Types.ObjectId).toString(),
      email: user.email,
      roles: user.roles,
    });

    await this.userModel.findByIdAndUpdate(user._id, {
      refreshToken: await bcrypt.hash(tokens.refreshToken, 12),
    });

    return tokens;
  }

  async refresh(userId: string, incomingRefreshToken: string): Promise<TokenPair> {
    const user = await this.userModel
      .findById(userId)
      .select('+refreshToken')
      .lean();

    if (!user?.refreshToken) throw new UnauthorizedException('Session expirée.');

    const isMatch = await bcrypt.compare(incomingRefreshToken, user.refreshToken as string);
    if (!isMatch) throw new UnauthorizedException('Refresh token invalide.');

    const tokens = this.generateTokens({
      sub: (user._id as Types.ObjectId).toString(),
      email: user.email,
      roles: user.roles,
    });

    await this.userModel.findByIdAndUpdate(user._id, {
      refreshToken: await bcrypt.hash(tokens.refreshToken, 12),
    });

    return tokens;
  }

  async logout(userId: string): Promise<void> {
    const user = await this.userModel.findById(userId).lean().select('_id');
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    await this.userModel.findByIdAndUpdate(userId, { $unset: { refreshToken: 1 } });
  }

  private generateTokens(payload: JwtPayload): TokenPair {
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('jwt.secret'),
      expiresIn: this.configService.getOrThrow<string>('jwt.expiresIn'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiresIn'),
    });

    return { accessToken, refreshToken };
  }
}
