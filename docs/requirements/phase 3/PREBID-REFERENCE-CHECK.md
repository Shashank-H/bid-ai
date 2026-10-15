# Phase 3 — Bounded Prebid reference check

## Reference and scope

Executed October 14, 2026 using Node **24.18.0**, the project's existing Playwright Chromium, and published **Prebid.js 11.41.0**:

- Artifact: `https://unpkg.com/prebid.js@11.41.0/dist/not-for-prod/prebid.js`
- SHA-256: `19ad77badcbd79c45aed15751139f089059e0d4d6606db89590a306eb0e28ad3`
- Release commit: `e9c437d7ddefcb5c1482b118c2a2f85432746bdb`.

The artifact contains **all available modules**, not a selected-only build. The harness configures the bounded banner/Price Floors/Currency profile; some other bundled hooks can initialize (for example USP's missing-CMP fallback). Therefore this is a bounded behavioral reference, **not proof of complete selected-module/browser parity**. No production package/dependency was added, and reference bytes remain in temporary storage outside the repository.

## Commands actually run

From the repository root, with shared/API build outputs available:

```sh
# Preparation only: one pinned download, checksum validated before writing temporary bytes.
node scripts/phase-3-data/fetch-prebid-reference.mjs
# Offline browser execution: reads already verified local bytes; does not download.
node scripts/phase-3-data/prebid-harness.mjs
```

The final command passed **10 controlled samples**. It prints a JSON report; execution was also repeated successfully after fixing the harness transport and render-event flushing. `PREBID_REFERENCE_PATH` can select a prepared artifact path, but its bytes must match the same checksum. Missing/changed reference bytes fail rather than silently fetching another version.

## Isolation and implementation

Each sample uses a fresh page and five registered standard mock bidder specifications (`atlas`, `beacon`, `cedar`, `delta`, `ember`). Their synthetic placement contract is validated and offers contain valid banner dimensions, USD currency, positive CPM/TTL, creative identity, net-revenue flag and an inert creative.

- Install and **pause** the Playwright clock before loading the artifact; advance it explicitly, flushing promise jobs between advances.
- Replace `window.fetch` **before** Prebid loads. The transport supports the actual `Request` input, returns a real `Response`, honors abort signals, and schedules deterministic mock offers/no-bids.
- Forbid every unexpected fetch and every actual browser network request. All 10 samples asserted zero outbound browser requests, zero unexpected mock URLs, zero page errors and five configured adapter requests.
- Snapshot candidate and targeting when `bidsBackHandler` completes. Do not let a subsequent arrival rewrite the synthetic auction decision.
- Where a candidate exists, render its native `adId` into a fresh iframe through `pbjs.renderAd`; assert **both `bidWon` and `adRenderSucceeded`**, with no render-failure event. TTL-expiry check deliberately does not render.
- Compare medium/high monetary bucket output with the application's `targetingBucket` implementation. Native randomized IDs are not compared or included in deterministic dataset hashes.

## Observed results

| Check                                         | Observed result                                                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Floor equality/rejection and early completion | `$0.80` offer accepted; `$0.79` offer emits `bidRejected`; atlas wins at `$0.80`. All adapters complete and auction closes at **60 ms**, not its 1,000 ms budget.                               |
| Floor enforcement                             | Offers `$0.79`/`$0.75` both rejected under `$0.80`; no candidate.                                                                                                                               |
| Floor bypass                                  | `skipRate: 100` admits both below-floor offers; atlas `$0.79` wins.                                                                                                                             |
| Enforcement disabled                          | `enforceJS: false` admits the same offers; atlas `$0.79` wins.                                                                                                                                  |
| Short timeout                                 | Budget **300 ms**, atlas `$1.23` at 80 ms, beacon `$1.57` scheduled at 700 ms: timed out at 300 ms; frozen winner atlas.                                                                        |
| Larger timeout                                | Same demand with **900 ms** budget: beacon accepted; winner beacon `$1.57`; all adapters finish at **700 ms**, before deadline.                                                                 |
| Exact deadline ordering                       | Beacon scheduled at exactly **900 ms** with a 900 ms budget: auction timeout fires first; frozen winner remains atlas. This ordering must not be presented as guaranteed at-deadline inclusion. |
| Medium + send all                             | Winning original CPM remains `$1.57`; `hb_pb` is **`1.50`**, matching the application bucket function. Atlas's bidder-suffixed targeting is present.                                            |
| High + top only                               | Winning original CPM still `$1.57`; `hb_pb` is **`1.57`**. No atlas-suffixed targeting; five requests remain unchanged.                                                                         |
| TTL buffer                                    | TTL 2 seconds, buffer 1 second: offer is initially targetable; after controlled advancement it is not targetable **before** its unbuffered two-second TTL would expire.                         |

## Explicit limits and implications

- This checks auction/configuration/targeting/render mechanisms on a handful of offers, **not every generated event or all eight-week scenarios**. Persisted reconciliation, scenario assertions and browser investigation E2E are separate checks.
- The mock fetch honors AJAX aborts. Short/equal-budget offers can be aborted rather than producing a later native `bidResponse`. The pinned source permits late accepted observations on other transport/completion paths; that broader late-hook path was **not independently exercised** here. Never label every late observation a native `bidRejected`.
- The application must handle or avoid same-timestamp deadline/offer ambiguity explicitly. This reference schedules the auction timer before mock transport completion; at equality the timeout wins. Native tied-CPM winner ordering was not tested.
- Native targeting includes `hb_ver` and does not emit `hb_source` for these minimal specifications. The check compares bucket/candidate semantics and send-all behavior, **not an identical targeting-key universe**. Native random `adId` differs from stable synthetic request identities.
- Fixed USD rates and baseline profile values were accepted. Mixed-currency conversion, CPM adjustment functions, different formats, SSP credentials, consent policy, storage/identity effects, real ad-server line items and actual payment were not tested.
- Auction wait is controlled-clock evidence for a user-experience **proxy**, not measured visitor LCP, layout shift, viewability or paid revenue. Rendering the inert iframe was exercised; the application UI was not rendered by this harness.

Source-backed distinctions: [floor rejection](https://github.com/prebid/Prebid.js/blob/e9c437d7ddefcb5c1482b118c2a2f85432746bdb/modules/priceFloors.ts#L993-L1058), [auction timeout](https://github.com/prebid/Prebid.js/blob/e9c437d7ddefcb5c1482b118c2a2f85432746bdb/src/auction.ts#L279-L313), [early completion](https://github.com/prebid/Prebid.js/blob/e9c437d7ddefcb5c1482b118c2a2f85432746bdb/src/auction.ts#L602-L629), [TTL targeting](https://github.com/prebid/Prebid.js/blob/e9c437d7ddefcb5c1482b118c2a2f85432746bdb/src/targeting/filters.ts#L6-L21), and [`bidWon` versus render success](https://github.com/prebid/Prebid.js/blob/e9c437d7ddefcb5c1482b118c2a2f85432746bdb/src/adRendering.ts#L32-L45).
