import { isAllowedHost } from './host-matching';

const SANDBOX_HOSTS = ['sandbox.paypal.com', 'www.sandbox.paypal.com'];
const LIVE_HOSTS = ['paypal.com', 'www.paypal.com'];

describe('isAllowedHost', () => {
  it('devrait accepter un hôte listé', () => {
    expect(isAllowedHost('www.paypal.com', LIVE_HOSTS)).toBe(true);
    expect(isAllowedHost('www.sandbox.paypal.com', SANDBOX_HOSTS)).toBe(true);
  });

  it.each([
    'paypal.com.attacker.tld',
    'sandbox.paypal.com.attacker.tld',
    'fakepaypal.com',
    'notpaypal.com',
    'xpaypal.com',
    'paypal.com.evil',
  ])('devrait refuser le domaine sosie %p', (hostname) => {
    expect(isAllowedHost(hostname, LIVE_HOSTS)).toBe(false);
    expect(isAllowedHost(hostname, SANDBOX_HOSTS)).toBe(false);
  });

  it('devrait cloisonner Sandbox et Live', () => {
    // `www.sandbox.paypal.com` EST un sous-domaine de `paypal.com` : une
    // comparaison par domaine l'accepterait en Live. La comparaison exacte
    // est ce qui empêche la confusion d'environnement.
    expect(isAllowedHost('www.sandbox.paypal.com', LIVE_HOSTS)).toBe(false);
    expect(isAllowedHost('www.paypal.com', SANDBOX_HOSTS)).toBe(false);
  });

  it('devrait refuser un sous-domaine non listé', () => {
    expect(isAllowedHost('evil.paypal.com', LIVE_HOSTS)).toBe(false);
  });

  it('devrait ignorer la casse et le point final absolu', () => {
    expect(isAllowedHost('WWW.PayPal.COM.', LIVE_HOSTS)).toBe(true);
  });

  it('devrait refuser des entrées vides', () => {
    expect(isAllowedHost('', LIVE_HOSTS)).toBe(false);
    expect(isAllowedHost('www.paypal.com', [])).toBe(false);
    expect(isAllowedHost('www.paypal.com', ['', '   '])).toBe(false);
  });
});
