import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';
import { Favorite, FavoriteSchema } from './favorite.schema';
import { Event, EventSchema } from '../events/event.schema';
import { VendorProfile, VendorProfileSchema } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileSchema } from '../venues/venue.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Favorite.name, schema: FavoriteSchema },
      // Lecture seule : vérification d'existence de la cible et enrichissement
      // de la liste. Aucune écriture sur ces collections depuis ce module.
      { name: Event.name, schema: EventSchema },
      { name: VendorProfile.name, schema: VendorProfileSchema },
      { name: VenueProfile.name, schema: VenueProfileSchema },
    ]),
  ],
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
