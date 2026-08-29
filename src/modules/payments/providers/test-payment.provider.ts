import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreatePaymentInput,
  PaymentHandle,
  PaymentProvider,
  PAYMENT_PROVIDER_TOKENS,
  ProviderPaymentStatus,
} from './payment-provider.interface';

/**
 * Scénarios de simulation déterministes.
 *
 * `DUPLICATE_CALLBACK` se comporte exactement comme `SUCCESS` : la duplication
 * n'est pas une propriété du fournisseur mais du transport. Elle s'exerce en
 * appelant deux fois la synchronisation de la commande, ce qui doit produire
 * un seul effet métier.
 */
export enum TestPaymentScenario {
  SUCCESS = 'SUCCESS',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
  TIMEOUT = 'TIMEOUT',
  DELAYED_SUCCESS = 'DELAYED_SUCCESS',
  DUPLICATE_CALLBACK = 'DUPLICATE_CALLBACK',
}

export const TEST_PAYMENT_SCENARIOS = Object.values(TestPaymentScenario);

/** Délai avant que DELAYED_SUCCESS bascule de PENDING à SUCCEEDED. */
export const DELAYED_SUCCESS_DELAY_MS = 2_000;

const REFERENCE_PREFIX = 'testpay';
/** `:` — les noms de scénarios contiennent des `_` (DELAYED_SUCCESS). */
const REFERENCE_SEPARATOR = ':';

export const TEST_PAYMENT_PROVIDER_DISABLED = 'TEST_PAYMENT_PROVIDER_DISABLED';
export const TEST_PAYMENT_REFERENCE_INVALID = 'TEST_PAYMENT_REFERENCE_INVALID';

/**
 * Fournisseur de paiement simulé — DÉVELOPPEMENT ET TESTS UNIQUEMENT.
 *
 * SÉCURITÉ
 * --------
 * Ce fournisseur peut faire passer une commande à PAID sans paiement réel.
 * Trois protections indépendantes l'encadrent :
 *
 *   1. La configuration refuse de démarrer si l'activation est demandée hors
 *      `ELINTYS_ENV=dev` (`resolveTestPaymentProviderEnabled`).
 *   2. Chaque appel revérifie l'autorisation (`assertEnabled`) — défense en
 *      profondeur si l'instance est réutilisée par erreur.
 *   3. Aucun endpoint n'accepte de statut de paiement venant du client : le
 *      serveur interroge toujours `getPaymentStatus`.
 *
 * DÉTERMINISME
 * ------------
 * Le fournisseur est SANS ÉTAT PERSISTANT : le scénario et l'horodatage de
 * création sont encodés dans la référence. Deux instances API différentes
 * calculent donc exactement le même statut pour la même référence, sans
 * collection dédiée ni mémoire de processus.
 */
@Injectable()
export class TestPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDER_TOKENS.TEST;

  constructor(private readonly configService: ConfigService) {}

  get enabled(): boolean {
    return this.configService.get<boolean>('ticketing.testPaymentProviderEnabled') === true;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(TEST_PAYMENT_PROVIDER_DISABLED);
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentHandle> {
    this.assertEnabled();
    const scenario = normalizeScenario(input.scenario);
    const reference = buildTestReference(scenario, input.orderId, Date.now());
    return {
      provider: this.name,
      reference,
      status: computeStatus(reference, Date.now()),
      // Aucune page de paiement : rien ne doit ressembler à un vrai paiement.
      checkoutUrl: null,
    };
  }

  async getPaymentStatus(reference: string): Promise<ProviderPaymentStatus> {
    this.assertEnabled();
    return computeStatus(reference, Date.now());
  }

  async cancelPayment(reference: string): Promise<void> {
    this.assertEnabled();
    // Idempotent : on valide seulement que la référence nous appartient.
    parseTestReference(reference);
  }
}

export function normalizeScenario(raw: string | undefined): TestPaymentScenario {
  if (raw === undefined) return TestPaymentScenario.SUCCESS;
  const candidate = raw.trim().toUpperCase();
  const match = TEST_PAYMENT_SCENARIOS.find((scenario) => scenario === candidate);
  if (!match) {
    throw new ServiceUnavailableException(TEST_PAYMENT_REFERENCE_INVALID);
  }
  return match;
}

export function buildTestReference(
  scenario: TestPaymentScenario,
  orderId: string,
  createdAtMs: number,
): string {
  return [REFERENCE_PREFIX, scenario, orderId, createdAtMs].join(REFERENCE_SEPARATOR);
}

export function parseTestReference(reference: string): {
  scenario: TestPaymentScenario;
  orderId: string;
  createdAtMs: number;
} {
  const parts = reference.split(REFERENCE_SEPARATOR);
  if (parts.length !== 4 || parts[0] !== REFERENCE_PREFIX) {
    throw new ServiceUnavailableException(TEST_PAYMENT_REFERENCE_INVALID);
  }
  const scenario = TEST_PAYMENT_SCENARIOS.find((value) => value === parts[1]);
  const createdAtMs = Number(parts[3]);
  if (!scenario || !parts[2] || !Number.isInteger(createdAtMs)) {
    throw new ServiceUnavailableException(TEST_PAYMENT_REFERENCE_INVALID);
  }
  return { scenario, orderId: parts[2], createdAtMs };
}

export function computeStatus(reference: string, nowMs: number): ProviderPaymentStatus {
  const { scenario, createdAtMs } = parseTestReference(reference);
  switch (scenario) {
    case TestPaymentScenario.SUCCESS:
    case TestPaymentScenario.DUPLICATE_CALLBACK:
      return ProviderPaymentStatus.SUCCEEDED;
    case TestPaymentScenario.DECLINED:
      return ProviderPaymentStatus.FAILED;
    case TestPaymentScenario.CANCELLED:
      return ProviderPaymentStatus.CANCELLED;
    case TestPaymentScenario.TIMEOUT:
      // Ne bascule jamais : la commande doit expirer par le mécanisme d'expiration.
      return ProviderPaymentStatus.PENDING;
    case TestPaymentScenario.DELAYED_SUCCESS:
      return nowMs - createdAtMs >= DELAYED_SUCCESS_DELAY_MS
        ? ProviderPaymentStatus.SUCCEEDED
        : ProviderPaymentStatus.PENDING;
  }
}
