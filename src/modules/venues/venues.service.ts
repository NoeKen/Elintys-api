import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { VenueProfile, VenueProfileDocument } from './venue.schema';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class VenuesService {
  constructor(
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
  ) {}

  async create(userId: string, dto: CreateVenueDto): Promise<VenueProfile> {
    const exists = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (exists) throw new ConflictException('Un profil de salle existe déjà pour ce compte.');

    const venue = await this.venueModel.create({ ...dto, user: new Types.ObjectId(userId) });
    return venue.toObject();
  }

  async findAll(page = 1, limit = 20): Promise<PaginatedResult<VenueProfile>> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.venueModel.find({ isActive: true }).skip(skip).limit(limit).sort({ rating: -1 }).lean().select('-__v'),
      this.venueModel.countDocuments({ isActive: true }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<VenueProfile> {
    const venue = await this.venueModel.findById(id).lean().select('-__v');
    if (!venue) throw new NotFoundException('Salle introuvable.');
    return venue;
  }

  async update(id: string, userId: string, dto: UpdateVenueDto): Promise<VenueProfile> {
    const venue = await this.venueModel.findById(id).lean().select('user');
    if (!venue) throw new NotFoundException('Salle introuvable.');
    if (venue.user.toString() !== userId) throw new ForbiddenException('Accès refusé.');

    const updated = await this.venueModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    return updated!;
  }
}
