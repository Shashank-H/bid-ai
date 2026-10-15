import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { targetingBucket } from '../../apps/api/dist/domain/aggregation.js';
import {
  PREBID_REFERENCE_PATH,
  PREBID_REFERENCE_SHA256,
  PREBID_REFERENCE_VERSION,
  verifyPrebidReference,
} from './fetch-prebid-reference.mjs';

// Preparation fetch is a separate command. The browser run has no network dependency.
const referencePath = process.env.PREBID_REFERENCE_PATH ?? PREBID_REFERENCE_PATH;
verifyPrebidReference(await readFile(referencePath));

const bidders = ['atlas', 'beacon', 'cedar', 'delta', 'ember'];
const baseConfig = {
  debug: false,
  bidderTimeout: 1000,
  bidderSequence: 'fixed',
  maxRequestsPerOrigin: 4,
  useBidCache: false,
  ttlBuffer: 1,
  priceGranularity: 'medium',
  enableSendAllBids: true,
  deviceAccess: false,
  userSync: { syncEnabled: false },
  currency: {
    adServerCurrency: 'USD',
    granularityMultiplier: 1,
    rates: { USD: { USD: 1 } },
  },
  floors: {
    enabled: true,
    skipRate: 0,
    enforcement: {
      enforceJS: true,
      enforceBidders: ['*'],
      enforcePBS: false,
      floorDeals: false,
      bidAdjustment: true,
    },
    data: {
      currency: 'USD',
      schema: { fields: ['mediaType'], delimiter: '|' },
      values: { banner: 0.8 },
      default: 0.8,
    },
  },
};

const browser = await chromium.launch({ headless: true });
const observations = [];

async function sample(name, options = {}) {
  const page = await browser.newPage();
  const forbiddenNetwork = [];
  const pageErrors = [];
  const consoleMessages = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.route('**/*', (route) => {
    forbiddenNetwork.push(route.request().url());
    return route.abort();
  });
  await page.clock.install({ time: new Date('2026-10-14T00:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-14T00:01:00.000Z'));

  try {
    const config = structuredClone(baseConfig);
    config.bidderTimeout = options.timeout ?? 1000;
    config.priceGranularity = options.granularity ?? 'medium';
    config.enableSendAllBids = options.sendAll ?? true;
    config.floors.skipRate = options.skipRate ?? 0;
    config.floors.enforcement.enforceJS = options.enforce ?? true;

    // Prebid binds window.fetch when its bundle loads: install this transport first.
    await page.evaluate(
      ({ bidders, offers }) => {
        window.__reference = { events: [], unexpectedFetch: [], requests: [], result: null };
        window.fetch = async (input, init = {}) => {
          const url = typeof input === 'string' ? input : input.url;
          const match = /^https:\/\/(atlas|beacon|cedar|delta|ember)\.mock\.test\/bids$/.exec(url);
          if (!match || !bidders.includes(match[1])) {
            window.__reference.unexpectedFetch.push(url);
            return Promise.reject(new Error(`Unexpected reference fetch: ${url}`));
          }
          const bidder = match[1];
          const offer = offers[bidder] ?? { delay: 60, cpm: null };
          const body = init.body ?? (await input.text());
          const signal = init.signal ?? input.signal;
          const ids = JSON.parse(body).ids;
          window.__reference.requests.push({ bidder, at: Date.now() });
          return new Promise((resolve, reject) => {
            let timer;
            const aborted = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (signal?.aborted) return aborted();
            signal?.addEventListener('abort', aborted, { once: true });
            timer = setTimeout(() => {
              signal?.removeEventListener('abort', aborted);
              const bids =
                offer.cpm === null
                  ? []
                  : ids.map((requestId) => ({
                      requestId,
                      cpm: offer.cpm,
                      currency: 'USD',
                      ttl: offer.ttl ?? 60,
                      creativeId: `creative-${bidder}`,
                      netRevenue: true,
                      mediaType: 'banner',
                      width: 300,
                      height: 250,
                      ad: `<div>Offline ${bidder} mock creative</div>`,
                    }));
              const body = JSON.stringify({ bids });
              const response = new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
              // Avoid stream-read wall-clock work; this remains a real Response object.
              response.text = () => Promise.resolve(body);
              resolve(response);
            }, offer.delay);
          });
        };
      },
      {
        bidders,
        offers: options.offers ?? {
          atlas: { delay: 40, cpm: 0.8 },
          beacon: { delay: 50, cpm: 0.79 },
        },
      },
    );
    await page.addScriptTag({ path: referencePath });

    await page.evaluate(
      ({ bidders, config }) => {
        pbjs.setConfig(config);
        for (const bidder of bidders) {
          pbjs.registerBidAdapter(undefined, bidder, {
            code: bidder,
            supportedMediaTypes: ['banner'],
            isBidRequestValid: (bid) => typeof bid.params.placementId === 'string',
            buildRequests: (bids) => ({
              method: 'POST',
              url: `https://${bidder}.mock.test/bids`,
              data: JSON.stringify({ ids: bids.map((bid) => bid.bidId) }),
              options: { contentType: 'application/json', withCredentials: false },
            }),
            interpretResponse: (response) => response.body.bids,
          });
        }
        for (const type of [
          'auctionInit',
          'auctionEnd',
          'bidRequested',
          'bidResponse',
          'bidRejected',
          'bidTimeout',
          'bidderDone',
          'bidWon',
          'adRenderSucceeded',
          'adRenderFailed',
        ]) {
          pbjs.onEvent(type, (args) => {
            window.__reference.events.push({
              type,
              at: Date.now(),
              bidder: args?.bidderCode ?? args?.bidder,
              cpm: args?.cpm,
              bidders: Array.isArray(args) ? args.map((bid) => bid.bidder) : undefined,
            });
          });
        }
        pbjs.addAdUnits([
          {
            code: 'reference-slot',
            mediaTypes: { banner: { sizes: [[300, 250]] } },
            bids: bidders.map((bidder) => ({ bidder, params: { placementId: 'reference-slot' } })),
          },
        ]);
        window.__reference.startedAt = Date.now();
        window.__reference.config = {
          bidderTimeout: pbjs.getConfig('bidderTimeout'),
          ttlBuffer: pbjs.getConfig('ttlBuffer'),
          priceGranularity: pbjs.getConfig('priceGranularity'),
          adServerCurrency: pbjs.getConfig('currency.adServerCurrency'),
          floor: pbjs.getConfig('floors.data.values.banner'),
        };
        pbjs.requestBids({
          auctionId: 'offline-reference-auction',
          adUnitCodes: ['reference-slot'],
          bidsBackHandler: (_bids, timedOut) => {
            const candidate = pbjs.getHighestCpmBids('reference-slot')[0];
            window.__reference.result = {
              at: Date.now(),
              timedOut,
              candidate: candidate
                ? { bidder: candidate.bidderCode, cpm: candidate.cpm, adId: candidate.adId }
                : null,
              targeting: pbjs.getAdserverTargetingForAdUnitCode('reference-slot'),
            };
          },
        });
      },
      { bidders, config },
    );

    // Flush promise jobs between controlled timer advances, never sleep on wall-clock auctions.
    const until = Math.max(
      config.bidderTimeout + 20,
      ...Object.values(options.offers ?? {}).map((x) => x.delay + 20),
    );
    for (let elapsed = 0; elapsed < until; elapsed += 20) {
      await page.clock.runFor(Math.min(20, until - elapsed));
      await page.evaluate(() => Promise.resolve());
    }

    if (options.expireAfterMs !== undefined) {
      await page.clock.runFor(options.expireAfterMs);
      await page.evaluate(() => {
        window.__reference.afterExpiry = pbjs.getAdserverTargetingForAdUnitCode('reference-slot');
      });
    }

    if (options.render !== false) {
      await page.evaluate(() => {
        const candidate = window.__reference.result?.candidate;
        if (candidate) {
          const frame = document.createElement('iframe');
          document.body.append(frame);
          pbjs.renderAd(frame.contentDocument, candidate.adId);
        }
      });
      await page.clock.runFor(5);
      await page.evaluate(() => Promise.resolve());
    }
    const observation = await page.evaluate(() => window.__reference);
    assert.deepEqual(forbiddenNetwork, [], `${name}: attempted real browser network`);
    assert.deepEqual(observation.unexpectedFetch, [], `${name}: unexpected mock transport URL`);
    assert.deepEqual(pageErrors, [], `${name}: browser script error`);
    assert.ok(observation.result, `${name}: no auction completion`);
    if (observation.requests.length !== 5)
      console.error(JSON.stringify({ observation, consoleMessages }, null, 2));
    assert.equal(observation.requests.length, 5, `${name}: all five configured adapters request`);
    assert.equal(observation.config.bidderTimeout, config.bidderTimeout);
    assert.equal(observation.config.ttlBuffer, 1);
    assert.equal(observation.config.adServerCurrency, 'USD');
    assert.equal(observation.config.floor, 0.8);
    if (options.render !== false && observation.result.candidate) {
      assert.ok(
        observation.events.some((event) => event.type === 'bidWon'),
        `${name}: native win missing`,
      );
      if (!observation.events.some((event) => event.type === 'adRenderSucceeded'))
        console.error(JSON.stringify({ observation, consoleMessages }, null, 2));
      assert.ok(
        observation.events.some((event) => event.type === 'adRenderSucceeded'),
        `${name}: explicit render success missing`,
      );
      assert.ok(!observation.events.some((event) => event.type === 'adRenderFailed'));
    }
    return observation;
  } finally {
    await page.close();
  }
}

function remember(name, result) {
  const summary = {
    name,
    waitMs: result.result.at - result.startedAt,
    timedOut: result.result.timedOut,
    candidate: result.result.candidate
      ? { bidder: result.result.candidate.bidder, cpm: result.result.candidate.cpm }
      : null,
    accepted: result.events.filter((x) => x.type === 'bidResponse').map((x) => x.bidder),
    rejected: result.events.filter((x) => x.type === 'bidRejected').map((x) => x.bidder),
    bucket: result.result.targeting.hb_pb,
    targetingKeys: Object.keys(result.result.targeting).sort(),
  };
  observations.push(summary);
  return result;
}

try {
  const equality = remember('floor-equality-and-rejection', await sample('floor equality'));
  assert.deepEqual(
    equality.result.candidate && {
      bidder: equality.result.candidate.bidder,
      cpm: equality.result.candidate.cpm,
    },
    { bidder: 'atlas', cpm: 0.8 },
  );
  assert.ok(equality.events.some((x) => x.type === 'bidRejected' && x.bidder === 'beacon'));
  assert.ok(!equality.events.some((x) => x.type === 'bidRejected' && x.bidder === 'atlas'));
  assert.equal(equality.result.timedOut, false);
  assert.ok(
    equality.result.at - equality.startedAt < 1000,
    'all adapters should close auction early',
  );

  const below = { atlas: { delay: 40, cpm: 0.79 }, beacon: { delay: 50, cpm: 0.75 } };
  const enforced = remember('floor-enforced', await sample('floor enforced', { offers: below }));
  assert.equal(enforced.result.candidate, null);
  const bypass = remember(
    'floor-skip-100',
    await sample('floor bypass', { offers: below, skipRate: 100 }),
  );
  assert.equal(bypass.result.candidate.bidder, 'atlas');
  const unenforced = remember(
    'floor-enforcement-disabled',
    await sample('floor enforcement disabled', { offers: below, enforce: false }),
  );
  assert.equal(unenforced.result.candidate.bidder, 'atlas');

  const slow = { atlas: { delay: 80, cpm: 1.23 }, beacon: { delay: 700, cpm: 1.57 } };
  const short = remember(
    'timeout-excludes-slow-candidate',
    await sample('short timeout', { timeout: 300, offers: slow }),
  );
  assert.equal(short.result.timedOut, true);
  assert.equal(short.result.candidate.bidder, 'atlas');
  assert.equal(short.result.at - short.startedAt, 300);
  const long = remember(
    'larger-timeout-admits-slow-candidate',
    await sample('long timeout', { timeout: 900, offers: slow }),
  );
  assert.equal(long.result.timedOut, false);
  assert.equal(long.result.candidate.bidder, 'beacon');
  assert.ok(long.result.at - long.startedAt < 900);

  const boundary = remember(
    'exact-deadline-offer-excluded',
    await sample('exact deadline', {
      timeout: 900,
      offers: { atlas: { delay: 80, cpm: 1.23 }, beacon: { delay: 900, cpm: 1.57 } },
    }),
  );
  assert.equal(boundary.result.timedOut, true);
  assert.equal(boundary.result.candidate.bidder, 'atlas');
  assert.equal(boundary.result.at - boundary.startedAt, 900);

  const medium = remember('medium-send-all', await sample('medium send all', { offers: slow }));
  const high = remember(
    'high-send-top-only',
    await sample('high top only', { offers: slow, granularity: 'high', sendAll: false }),
  );
  assert.equal(medium.result.targeting.hb_pb, targetingBucket(1.57, 'medium'));
  assert.equal(high.result.targeting.hb_pb, targetingBucket(1.57, 'high'));
  assert.ok(Object.keys(medium.result.targeting).some((key) => key.endsWith('_atlas')));
  assert.ok(!Object.keys(high.result.targeting).some((key) => key.endsWith('_atlas')));
  assert.equal(medium.result.candidate.cpm, high.result.candidate.cpm);
  assert.equal(medium.requests.length, high.requests.length);

  const expiry = remember(
    'ttl-buffer-expiry',
    await sample('TTL expiry', {
      timeout: 100,
      offers: { atlas: { delay: 40, cpm: 1.53, ttl: 2 } },
      expireAfterMs: 1000,
      render: false,
    }),
  );
  assert.equal(expiry.result.targeting.hb_pb, targetingBucket(1.53, 'medium'));
  assert.ok(!expiry.afterExpiry.hb_adid, 'TTL minus one-second buffer must expire targeting');

  console.log(
    JSON.stringify(
      {
        passed: observations.length,
        prebidVersion: PREBID_REFERENCE_VERSION,
        sha256: PREBID_REFERENCE_SHA256,
        artifact: 'all-module non-production reference; only selected features configured',
        offline: true,
        observations,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
