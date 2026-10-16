import {
  ConfigurationParameterImpactSchema,
  getBannerFloorRule,
  getEffectiveBannerFloor,
} from '@bid/shared';
import type { ConfigurationParameterImpact, PrebidConfiguration } from '@bid/shared';

/** Resolve only the declared client-side banner profile; no code is read from stored JSON. */
export function resolvePrebidAuction(profile: PrebidConfiguration, adUnitCode: string) {
  if (profile.setConfig.ttlBuffer >= 60)
    throw new Error('DATA_INVALID: the controlled offer TTL must exceed its buffer');
  const unit = profile.adUnits.find((entry) => entry.code === adUnitCode);
  if (!unit) throw new Error('DATA_INVALID: selected ad unit is not configured');
  const adapters = unit.bids.map((bid) =>
    profile.mockAdapters.find((entry) => entry.bidder === bid.bidder),
  );
  if (
    adapters.some((adapter) => !adapter) ||
    new Set(adapters.map((adapter) => adapter!.origin)).size !== adapters.length
  ) {
    throw new Error('DATA_INVALID: this profile requires registered independent mock origins');
  }
  return {
    unit,
    size: unit.mediaTypes.banner.sizes[0]!,
    configuredTimeoutMs: profile.setConfig.bidderTimeout,
    effectiveTimeoutMs: profile.requestBids.timeout ?? profile.setConfig.bidderTimeout,
    currency: profile.setConfig.currency.adServerCurrency,
    floorCpm: getEffectiveBannerFloor(profile, adUnitCode),
    floorRule: getBannerFloorRule(profile, adUnitCode),
    ttlBufferSeconds: profile.setConfig.ttlBuffer,
  };
}

const CONFIG = 'https://docs.prebid.org/dev-docs/publisher-api-reference/setConfig.html';
const FLOORS = 'https://docs.prebid.org/dev-docs/modules/floors.html';
const ADUNITS = 'https://docs.prebid.org/dev-docs/adunit-reference.html';
const REQUEST = 'https://docs.prebid.org/dev-docs/publisher-api-reference/requestBids.html';
const CURRENCY = 'https://docs.prebid.org/dev-docs/modules/currency.html';
const ENTRIES: ConfigurationParameterImpact[] = [
  {
    path: 'setConfig.bidderTimeout / requestBids.timeout',
    support: 'modeled',
    description:
      'Milliseconds allowed for the auction; a per-request timeout overrides the global value. The auction can finish early once every adapter completes.',
    publisherImpact:
      'A longer open auction may admit slower demand; it does not guarantee higher estimated revenue.',
    visitorImpact:
      'A longer budget can delay ad availability. Recorded auction wait is synthetic, not measured page performance.',
    source: REQUEST,
  },
  {
    path: 'setConfig.bidderSequence',
    support: 'validated-inactive',
    description:
      'Fixed ordering in this reproducible profile. Independent origins and no contention mean order is not assigned an economic premium.',
    publisherImpact:
      'Order can matter under actual resource contention; this dataset does not model that contention.',
    visitorImpact: 'No extra waiting effect is invented for changing an inactive order setting.',
    source: CONFIG,
  },
  {
    path: 'setConfig.maxRequestsPerOrigin',
    support: 'validated-inactive',
    description:
      'Per-origin concurrency limit, not a maximum number of bidders. Baseline mock origins are independent and do not reach the limit.',
    publisherImpact:
      'Real queueing could delay dispatch and exclude offers; unsupported shared-origin simulation is refused.',
    visitorImpact:
      'Concurrency can trade network pressure against deferred ads; there is no fabricated measurement here.',
    source: CONFIG,
  },
  {
    path: 'setConfig.floors.enabled / enforcement.enforceJS / enforceBidders',
    support: 'modeled',
    description:
      'Controls floor signaling and client-side enforcement separately. Enforced offers strictly below the matched floor are rejected; equality passes.',
    publisherImpact:
      'More restrictive eligibility can reduce fill and competition even while winning CPM increases.',
    visitorImpact: 'Less fill can leave an ad opportunity unfilled.',
    source: FLOORS,
  },
  {
    path: 'setConfig.floors.data.schema / values / default / currency',
    support: 'modeled',
    description:
      'The global banner rule sets USD CPM eligibility. Optional adUnitCode|mediaType rules select an exact slot override before *|banner in the same native package; zero is a valid override. Legacy mediaType-only rules remain supported.',
    publisherImpact:
      'Higher matched floors can trade winning prices for fewer eligible offers. The net revenue direction must be observed.',
    visitorImpact:
      'A higher floor can reduce the number of filled ad opportunities; it does not measure viewability.',
    source: FLOORS,
  },
  {
    path: 'setConfig.floors.skipRate',
    support: 'modeled',
    description:
      'Percentage of auctions bypassing floor logic, drawn reproducibly and recorded once per auction. Baseline is zero.',
    publisherImpact:
      'Bypass cohorts allow a controlled eligibility comparison; changing skipRate does not create offers by itself.',
    visitorImpact:
      'Bypassed floors can allow more opportunities to fill without changing request timing.',
    source: FLOORS,
  },
  {
    path: 'setConfig.floors.enforcement.bidAdjustment',
    support: 'validated-inactive',
    description:
      'Controls inverse adjustment of the floor signaled to adapters. Response adjustment is separate. Baseline has no adjustment functions.',
    publisherImpact: 'There is no adjustment-driven economic effect in the fixed-price baseline.',
    visitorImpact: 'No visitor measurement or identity effect is implied.',
    source: FLOORS,
  },
  {
    path: 'adUnits[].code / mediaTypes.banner.sizes',
    support: 'modeled',
    description:
      'Defines configured slot identity and banner dimensions. Requested-size membership is an explicit simulator/publisher policy, not a universal native validation rule.',
    publisherImpact:
      'Slot selection and dimension compatibility determine which opportunities and creatives are eligible.',
    visitorImpact:
      'Dimensions affect ad layout; this dataset does not claim measured layout shift or render performance.',
    source: ADUNITS,
  },
  {
    path: 'adUnits[].bids[].bidder / params',
    support: 'modeled',
    description:
      'Bidder entries determine requests. placementId is the registered mock adapter contract, not a universal production adapter parameter.',
    publisherImpact:
      'Removing an adapter removes its requests and competition, not just its winning count.',
    visitorImpact:
      'Real bidder additions can add network work; these adapters are offline synthetic demand.',
    source: ADUNITS,
  },
  {
    path: 'requestBids.adUnitCodes / auctionId',
    support: 'modeled',
    description:
      'Concrete selected code and stable auction ID are recorded on each auction; the stored template contains only optional timeout overrides.',
    publisherImpact:
      'Only the selected configured unit solicits bids. Renaming an identity does not by itself change estimated revenue.',
    visitorImpact: 'Selecting no valid slot would leave the intended ad opportunity unrequested.',
    source: REQUEST,
  },
  {
    path: 'setConfig.priceGranularity',
    support: 'modeled',
    description:
      'Buckets CPM for ad-server targeting. Medium uses 0.10 increments up to 20.00; bucketed hb_pb is not the original bid CPM.',
    publisherImpact:
      'Changes targeting output, not underlying offered CPM; no competing ad-server line items are simulated here.',
    visitorImpact: 'No direct visitor-speed effect is assigned to a price bucket change.',
    source: CONFIG,
  },
  {
    path: 'setConfig.enableSendAllBids',
    support: 'modeled',
    description:
      'Controls inclusion of bidder-specific targeting keys, not whether bidders are requested.',
    publisherImpact:
      'Changes targeting transparency/payload. The isolated render model does not manufacture a revenue change from this flag.',
    visitorImpact:
      'Real targeting payload may grow with more bidders; actual network/page measurements are not seeded.',
    source: CONFIG,
  },
  {
    path: 'setConfig.currency',
    support: 'validated-inactive',
    description:
      'Fixed USD ad-server currency, USD-to-USD rate 1 and bucket multiplier 1. No remote rate fetch or mixed-currency conversion is supported.',
    publisherImpact:
      'All prices/floors share comparable units. Unsupported currencies are refused rather than summed.',
    visitorImpact: 'The fixed local rates create no currency-fetch delay.',
    source: CURRENCY,
  },
  {
    path: 'setConfig.ttlBuffer / useBidCache',
    support: 'modeled',
    description:
      'Offers expire after TTL minus buffer; candidates must still be unexpired at targeting/render. Baseline disables cross-auction reuse.',
    publisherImpact:
      'Expired offers cannot generate a successful seeded render; cache reuse is not modeled.',
    visitorImpact:
      'Expired targeting could cause missing creatives in real deployments; the successful render here is controlled.',
    source: CONFIG,
  },
  {
    path: 'setConfig.deviceAccess / userSync / debug',
    support: 'validated-inactive',
    description:
      'Storage access, syncing and debugging are disabled. No real identifiers, sync calls or inferred identity price premiums are present.',
    publisherImpact: 'Flags alone do not justify a fabricated demand/revenue improvement.',
    visitorImpact:
      'No identity exposure or sync traffic is seeded; absence of a CMP is not a legal-compliance claim.',
    source: CONFIG,
  },
  {
    path: 'bidderSettings / optional modules and overrides',
    support: 'excluded',
    description:
      'No arbitrary functions, deals, PBS, dynamic floors, consent/user-ID modules, video/native or competing real ad-server line items. bidderSettings is empty.',
    publisherImpact:
      'These capabilities need their own policies/models before making optimization claims.',
    visitorImpact:
      'No privacy, consent, video, real network or payment behavior is invented for excluded capabilities.',
    source: CONFIG,
  },
];

/** Public generic explanations only; contains no seeded anomaly dates or expected answers. */
export const PREBID_PARAMETER_IMPACTS = ENTRIES.map((entry) =>
  ConfigurationParameterImpactSchema.parse(entry),
);
