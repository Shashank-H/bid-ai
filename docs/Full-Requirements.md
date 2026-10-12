## Synthetic Data & Investigation Scenarios

### Objective

Generate realistic, deterministic advertising auction data for two fictional publishers, with different performance patterns, configurations, and underlying problems.

The data should support multiple natural-language investigations, including revenue analysis, bidder comparisons, latency issues, and configuration optimization.

### Dataset Requirements

- Generate 6–8 weeks of historical auction data per publisher.
- Store auction events, aggregated metrics, estimated earnings, configurations, and configuration history in DynamoDB.
- Include realistic variations in traffic, CPM, bid response rates, win rates, and bidder latency.
- Ensure metrics and estimated earnings are mathematically consistent.
- Introduce intentional anomalies with identifiable root causes.
- Record configuration changes with timestamps so the agent can correlate performance changes with configuration history.
- Keep a separate scenario manifest for automated testing and demo preparation. Do not expose the manifest to the agent.

### Publisher A — Revenue Decline After Configuration Change

**Primary interview scenario**

- **Weeks 1–3:** Estimated revenue remains stable or gradually increases.
- **Week 4:** Estimated revenue suddenly drops by approximately 15–20%.
- **Root cause:** An auction configuration change introduced at the beginning of Week 4.

Example:

An operator increases the floor CPM from $0.80 to $1.40.

This reduces the number of eligible bids and lowers the fill rate. Although average winning CPM may increase slightly, the reduction in filled impressions causes estimated revenue to decline by approximately 18%.

**Expected agent behavior:**
1. Retrieve weekly revenue trends and identify the decline.
2. Compare fill rates, CPM, and auction volume before and after the decline.
3. Retrieve configuration history.
4. Correlate the floor-price change with the decline.
5. Explain the likely cause with supporting evidence, without treating correlation as proof.
6. Propose a safer floor price or a controlled rollback.
7. Present an interactive approval card.

### Publisher B — Different Performance Problems

Publisher B should have different configurations and performance characteristics.

Include scenarios such as:

**Scenario 1: Bidder latency degradation**
- One bidder's response latency increases significantly.
- More responses arrive after the auction timeout.
- Bidder participation and estimated revenue decline.
- Agent identifies the affected bidder and recommends evaluating timeout adjustments or bidder performance.

**Scenario 2: Revenue growth despite lower traffic**
- Traffic decreases, but average winning CPM and fill rate improve.
- Estimated revenue remains stable or increases.
- Agent explains why revenue does not always move proportionally with traffic.

**Scenario 3: Underperforming bidder**
- One bidder consistently has low response rates and poor win rates.
- Agent compares bidders and recommends investigating or disabling the underperforming bidder.

### Additional Investigation Questions

The dataset should support questions such as:

- Why did my estimated revenue drop last week?
- What changed in my configuration before revenue declined?
- Which bidder contributes the most estimated revenue?
- Which bidder has the highest latency?
- Has my fill rate improved over the last month?
- Is increasing my auction timeout likely to help?
- Why did revenue increase even though traffic decreased?
- Which configuration changes should I consider reverting?
- Compare my current performance with the previous three weeks.
- What optimization would you recommend based on my auction data?

### Data Quality & Security

- Use a seeded random generator for reproducible results.
- Make each scenario discoverable through normal analytics and configuration tools.
- Ensure raw events and aggregated metrics reconcile.
- Avoid contradictory metrics or unexplained anomalies.
- Scope all DynamoDB data to its publisher.
- Ensure Publisher A cannot retrieve Publisher B's data through agent tools or direct API requests.
- Do not give the agent access to hidden scenario definitions or expected answers.

### Acceptance Criteria

1. Publisher A demonstrates a roughly 18% Week 4 estimated revenue decline following a recorded configuration change.
2. Publisher B demonstrates distinct bidder and revenue patterns.
3. The agent can investigate each scenario through multiple authorized tool calls.
4. The agent can distinguish observations, likely causes, and recommended actions.
5. The frontend displays supporting charts, metrics, tool execution traces, and configuration proposals.
6. Identical seed inputs reproduce the same investigation results.
7. Automated tests validate key metric relationships and expected anomalies.

**Important:** Synthetic revenue must be labeled as estimated revenue unless the dataset explicitly models actual paid ad-server revenue.
