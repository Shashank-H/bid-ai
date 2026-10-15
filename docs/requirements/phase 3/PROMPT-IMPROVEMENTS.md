# Prompt improvement notes

## Context

Captured from manual Publisher B (`demo.b`) testing on October 15, 2026. These are observations and proposed improvements, not implemented prompt changes or newly verified financial totals.

The synthetic dataset covers August 24, 2026 at 03:30 UTC through October 19, 2026 at 03:30 UTC: exactly 56 elapsed days across 57 UTC date buckets. August 24 and October 19 are partial UTC dates; October 18 is the latest complete date. Read these bounds from dataset metadata rather than hardcoding them in the prompt.

## What worked

- The October 5–11 versus September 28–October 4 comparison correctly reported roughly 13.7% fewer auctions but 12.2% higher estimated revenue. Higher fill and average winning CPM explained the arithmetic without claiming a proven intervention effect.
- The September 14–27 versus August 31–September 13 comparison identified Beacon's slowdown: average latency rose from about 302 ms to 1,191 ms.
- Ember was identified as the weakest overall contributor in the queried aggregate.
- Configuration history correctly showed Publisher B's unchanged version 1: $0.60 floor, 900 ms timeout and five enabled bidders. The assistant did not invent a configuration change.
- Recommendations were qualified as suggestions, distinguished estimated revenue from payment, and did not claim to save configuration.
- A later answer correctly identified normal Beacon latency of approximately 302–303 ms in October 5–11 and October 12–18, rather than assuming September's slowdown continued indefinitely.

## 1. “Lifetime revenue” incorrectly excluded partial dates — high priority

**Conversation:** After asking which bidder earned the most, the user clarified: “I mean lifetime revenue.”

**Observed answer:** Beacon led with $61.20 for August 25–October 18, described as “available complete-day data.” The answer excluded both available partial boundary dates. Its final statement that the dataset did not cover the partial first observation date was misleading: observations do exist on August 24, just not for that whole UTC date.

**Required improvement:**

- Interpret “lifetime,” “all time,” “overall,” and “since the beginning” as the entire available observation span unless the user explicitly requests complete dates only.
- Override an earlier recent-week scope when the user changes to lifetime scope.
- Include observed data on both partial boundary dates. Do not extrapolate missing hours or silently discard the observed hours.
- Rank all five bidders over that same span; do not reuse the latest week's ranking or total.
- State “estimated revenue across all available dataset observations,” not true business-lifetime earnings.
- Report coverage and partial boundaries explicitly. The $61.20 complete-day result must not be presented as the full-span total; recompute it.

**Regression question:**

> Across every available observation, including partial boundary dates, rank all bidders by total estimated revenue. State the exact coverage.

**Pass condition:** Query the full metadata date range, include both partial dates, recompute totals and label them as dataset-to-date estimates. No full-span dollar amount is prescribed here without a fresh calculation.

## 2. “Consistently” needs repeated-period evidence

**Conversation:** “Which bidder consistently underperforms across August 24–October 18?”

**Observed answer:** Ember had the lowest aggregate response rate (~15.4%), win rate (~0.17%) and estimated revenue (~$0.11). That supports “weakest overall,” but one aggregate alone does not establish week-by-week consistency.

**Required improvement:** Compare weekly bidder results before claiming persistence. If only an aggregate was retrieved, explicitly say “weakest overall in this aggregate; consistency across weeks has not been checked.” Keep partial weeks labelled and compare the same metrics for every bidder.

**Regression question:**

> Was Ember the weakest bidder in every observed week, or only across the overall period? Show the weekly evidence.

**Pass condition:** Support each repeated-period claim with weekly results, or clearly state the analysis is incomplete. Do not infer consistency from one low total.

## 3. “Week by week” was answered with only two weeks

**Conversation:** “Compare bidder performance week by week. Does Beacon's slowdown persist in October?”

**Observed answer:** The assistant compared October 5–11 and October 12–18. Its conclusion was appropriately limited to those weeks, but it did not complete the broader weekly comparison requested.

**Required improvement:**

- Explain the selected weekly buckets and inspect the September slowdown, the September 28–October 4 transition week, and subsequent complete October weeks.
- Keep October 19's partial observations separate from complete-week comparisons if discussing all available October data.
- Inspect average latency alongside available timeout and late-response counts/rates. Average latency alone cannot establish timeout behavior or recovery.
- Conclude whether the slowdown persisted, recovered, or recurred only for periods actually checked.
- Stay within existing tool budgets. If the requested series cannot be completed, state the missing periods rather than implying exhaustive coverage.

**Regression question:**

> Show Beacon's weekly latency, timeout and late-response behavior from September 14 through October 18. When did it recover?

**Pass condition:** Include the transition week and distinguish observed recovery timing from an unproven explanation of its cause.

## 4. Configuration recommendations need a specific evidence chain

**Conversation:** “Changing or updating what configuration may help me earn more revenue?”

**Observed answer:** The initial recommendation suggested testing a modest floor adjustment, but did not show evidence supporting a direction or magnitude. The follow-up answer improved: it advised against changes based on the aggregates alone and named missing evidence.

**Required improvement:**

- For each proposed setting, state the observed problem, why that setting could address it, the trade-off and what evidence is missing.
- Do not recommend increasing the 900 ms timeout solely because Beacon was slow in September if recent measurements show recovery.
- Use timeout/late-response counters already available from tools before declaring those outcomes unavailable. Bid value associated with missed deadlines, latency percentiles and causal effects may still be unavailable.
- Do not choose a higher/lower floor, or invent a percentage/dollar adjustment, from revenue, fill and average winning CPM alone. Bid-price distributions and floor-specific rejection evidence are needed to support a direction.
- Ember's low revenue warrants investigation, not automatic removal. Unique wins, competition, incremental revenue and latency costs matter.
- Recommend one-variable controlled tests where justified; never promise a gain or imply that unchanged historical configuration proves what a hypothetical change would do.

**Regression question:**

> Based on the most recent complete weeks, which configuration change has evidence behind it? For timeout, floor and bidder participation, separate supporting evidence, trade-offs and missing evidence. Say if no change is justified.

**Pass condition:** Recommendations are specific when evidence permits, otherwise explicitly inconclusive. No fabricated counterfactual revenue or causal claim.

## 5. Simple factual answers contain unnecessary advice

**Conversation:** “What is the bidder that I'm earning the most from?”

**Observed answer:** The assistant gave Beacon's latest-week total, followed by generic hypothesis and recommendation sections. The date range was stated, but the extra advice added little to a ranking question.

**Required improvement:** Use recent conversation context to select a period and state it; clarify scope when necessary. Keep factual answers short and avoid inventing a hypothesis or action just to fill sections.

**Implementation constraint:** The existing answer validator requires Observation, Hypothesis and Recommendation sections. Prompt changes must preserve that contract. Relaxing it for factual questions requires a coordinated validator/test change, not prompt text alone. Until then, keep required sections brief and explicitly say when no causal conclusion or action follows.

## 6. Citation presentation is noisy

**Observed answer:** One weekly comparison displayed fourteen daily reference IDs in a single paragraph. The references were valid, but they overwhelmed the explanation.

**Required improvement:** Cite evidence near the specific claim and avoid repeating references. Do not invent weekly citation IDs, cite an unreturned record or remove evidence merely for appearance. If the existing evidence contract requires all daily references, a compact UI grouping or supported period reference is a separate product change, not something a prompt can fabricate.

## Suggested prompt rules

These are proposed rules, not edits to the current system prompt:

1. Resolve the requested period before querying. Explicit lifetime/all-time scope takes precedence over a recent-week default or an earlier conversation period.
2. Use dataset metadata for available bounds and complete-date defaults. Complete-week defaults must not exclude partial observed dates from all-time totals.
3. Distinguish aggregate, weekly, latest-week and all-available claims. State exactly which periods were checked.
4. Answer factual rankings directly with metric, scope, value and evidence. Do not invent advice or causes.
5. Distinguish observations, arithmetic explanations, hypotheses and causal evidence.
6. Tie each configuration suggestion to current evidence and a trade-off. State missing evidence and allow “no justified change.”
7. Use only returned evidence references and retain synthetic/estimated-revenue qualifications without excessive repetition.

## Follow-up verification

- Re-run the lifetime follow-up after a latest-week question; confirm the scope actually expands.
- Repeat all-time queries without explicitly mentioning partial dates; correct inclusion should be the default.
- Check weekly consistency and recovery claims against every period named in the answer.
- Compare advice before and after asking for supporting/missing evidence; the initial answer should already apply that standard.
- Confirm cited references belong to Publisher B and exactly match each queried period.
- Keep prompt-only improvements separate from missing-tool, answer-validator and citation-UI changes.

No prompt, validator, tool or UI implementation has been changed by this document.
