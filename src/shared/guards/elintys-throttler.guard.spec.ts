import { normalizeIp } from './elintys-throttler.guard';

describe('normalizeIp', () => {
  it('devrait ramener une IPv4 encapsulée en IPv6 à sa forme IPv4', () => {
    // Sans cela, un même client compterait deux fois selon la pile réseau
    // empruntée pour joindre l'API.
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('devrait laisser une IPv4 inchangée', () => {
    expect(normalizeIp('198.51.100.4')).toBe('198.51.100.4');
  });

  it('devrait normaliser la casse d’une IPv6', () => {
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('devrait retourner une valeur stable quand l’adresse est absente', () => {
    // Une clé vide regrouperait tous les appelants sans adresse dans un même
    // compteur ; une valeur explicite reste lisible en journal.
    expect(normalizeIp(undefined)).toBe('inconnue');
    expect(normalizeIp('')).toBe('inconnue');
  });
});
