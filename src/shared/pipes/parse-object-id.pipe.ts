import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';

/**
 * Valide qu'un paramètre de route est un ObjectId MongoDB (finding F-033).
 *
 * Sans ce pipe, un identifiant malformé atteint Mongoose et provoque une
 * `CastError` non gérée → **500**. On renvoie désormais un **400** structuré,
 * sans exposer de détail interne.
 */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException('INVALID_OBJECT_ID');
    }
    // `isValid` accepte aussi les chaînes de 12 caractères : on exige la forme
    // hexadécimale canonique de 24 caractères pour éviter les faux positifs.
    if (!/^[0-9a-fA-F]{24}$/.test(value)) {
      throw new BadRequestException('INVALID_OBJECT_ID');
    }
    return value;
  }
}
