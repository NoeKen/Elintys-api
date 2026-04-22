import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { VendorProfile, VendorProfileDocument } from './vendor.schema';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { QueryVendorDto } from './dto/query-vendor.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class VendorsService {
  constructor(
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
  ) {}

  async create(userId: string, dto: CreateVendorDto): Promise<VendorProfile> {
    const exists = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (exists) throw new ConflictException('Un profil prestataire existe déjà pour ce compte.');

    const vendor = await this.vendorModel.create({ ...dto, user: new Types.ObjectId(userId) });
    return vendor.toObject();
  }

  async findAll(query: QueryVendorDto): Promise<PaginatedResult<VendorProfile>> {
    const { page = 1, limit = 20, category } = query;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { isActive: true };
    if (category) filter['category'] = category;

    const [data, total] = await Promise.all([
      this.vendorModel.find(filter).skip(skip).limit(limit).sort({ rating: -1 }).lean().select('-__v'),
      this.vendorModel.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findById(id).lean().select('-__v');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    return vendor;
  }

  async findMyProfile(userId: string): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    return vendor;
  }

  async update(id: string, userId: string, dto: UpdateVendorDto): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findById(id).lean().select('user');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    if (vendor.user.toString() !== userId) throw new ForbiddenException('Accès refusé.');

    const updated = await this.vendorModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    return updated!;
  }
}
