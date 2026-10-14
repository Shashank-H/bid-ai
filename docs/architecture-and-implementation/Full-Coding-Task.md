**Exercise: Integrating and Persisting Prebid.js Auction Data**

**NOTE:** Feel free to produce any flavour of this problem that showcases your strongest skills. Be that Frontend, Backend, Data or ML. This exercise is about you, not about this task\*

**Problem Overview**  
The objective of this task is to architect and develop a system that integrates with Prebid.js to capture auction-related events and persistently stores them in a cloud database via a serverless function.

Please prepare a short Development Plan document. You should refer to this document during the live session while implementing or reviewing the problem alongside our engineers, simulating a real work task. This part is important, as we need to ensure your capability to effectively define and deliver projects with the team.

Your task involves tracking auction events such as \`bidRequested\`, \`bidResponse\`, \`bidWon\`, and others. These events must be intercepted on the client side using a standalone JavaScript file, which should be asynchronously injectable into any webpage via a \`\<script\>\` tag. The captured events are then to be transmitted to a backend service, processed by a serverless function, and finally recorded in a cloud-based database.

**Initial Steps**

1\. Implement and configure Prebid.js within a web environment. Useful resources include:

\- Ad Unit Refresh Example [https\://docs.prebid.org/dev-docs/examples/adunit-refresh.html](https://docs.prebid.org/dev-docs/examples/adunit-refresh.html)

\- Basic Example [https\://docs.prebid.org/dev-docs/examples/basic-example.html](https://docs.prebid.org/dev-docs/examples/basic-example.html)

2\. Develop a separate JavaScript file for event monitoring. This script should be capable of being injected into the Prebid.js setup from step 1 to monitor and capture specified ad auction events.  
3\. Utilize Axios or Fetch to forward the captured events to a designated API endpoint.

**Advanced Steps**  
1\. Create a serverless function using AWS Lambda that activates upon receiving the API call.  
2\. This Lambda function is responsible for parsing the event data and storing it in an AWS DynamoDB table (or local storage).  
3\. Implement thorough error management and data validation mechanisms within both the client-side script and the serverless function.  
4\. Ensure the system is designed for scalability, capable of managing a substantial volume of event data efficiently.

**Additional Notes / Comments**

In the initial steps, the main objective is to get Prebid running in your web environment. The simplest approach is one HTML file and one JavaScript file. Any web framework will also work if you're comfortable with it. Advice: first, get the example from the doc page working. The second requirement in the Initial Steps is to inject another JavaScript file. If you're using a framework like React or Angular, ensure this JS file can be injected on the page separately and not bundled into the build.

**\*Here are some examples of how you might emphasize different areas:**

**\- Frontend focus:** Polish the client-side event capture — think about reliability (retry logic, batching/debouncing, offline queuing), clean abstraction over the Prebid event API, minimal performance impact on the host page, and a small dashboard or UI that visualizes captured events in real time.

**\- Backend focus:** Go deep on the serverless architecture — design a robust API (input validation, idempotency, error handling), think about scalability patterns (batch writes, DynamoDB table design with appropriate partition/sort keys), add logging/monitoring, and consider how you'd handle high-throughput ingestion in production.

**\- Data focus:** Concentrate on what happens after the data lands — design a well-structured schema that supports analytical queries (e.g., latency analysis per bidder, win rates, bid density over time), build transformations or aggregations on the captured events, and prepare a short analysis or visualization of the auction data you've collected.

**\- ML / Data Science focus:** Use the captured auction data to build a predictive or analytical model — for example, predict whether a bid will win based on features like bidder, ad unit, bid value, and response time; estimate optimal floor prices; or detect anomalous bidding patterns (e.g., unusually slow responses, bid shading). You can work with synthetic or simulated data if the volume from your local setup is limited. Walk us through your feature engineering choices, model selection, and how you'd envision this running in production (e.g., as a real-time scoring endpoint or a batch pipeline).

\- **AI / Agentic focus**: You are building a chat-based AI agent embedded in a publisher's ad-ops dashboard. The agent can investigate issues, explain findings, and take corrective action on live ad configuration but **mutating actions require explicit publisher approval**. The agent is powered by an LLM, exposes a streaming chat API to the frontend, and calls backend capabilities via an MCP server that **you will design**.

**NOTE: You are not expected to complete every step. We'd rather see thoughtful work in your area of strength than shallow coverage of everything. Your Development Plan should reflect which angle you're taking and why.**
