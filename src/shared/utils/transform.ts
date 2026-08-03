import type { TransformFnParams } from 'class-transformer';

/**
 * Transforms de DTO **type-safe** (finding F-017).
 *
 * L'ancien pattern (trim direct sur `value`) s'exécutait AVANT la validation ;
 * sur une entrée non-string (objet, tableau…), la méthode `trim` n'existe pas
 * → TypeError → 500 non géré (vecteur DoS). Ces helpers ne transforment que les
 * chaînes et laissent passer le reste tel quel, pour que class-validator
 * produise un 400 structuré plutôt qu'un 500.
 */
export function trimValue({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function trimLowerValue({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
