# Local demo accounts

**Demo-only credentials — intentionally stored in this repository at the user's request. Never reuse these passwords elsewhere.**

| Login | Password | Publisher | Fixture dates (UTC) |
| --- | --- | --- | --- |
| demo.a | `am4XhTMx-ZJSRCLzZezATi61` | publisher-a (Publisher A) | 2026-01-01–2026-01-14 |
| demo.b | `4iBX7EwJUCBK9rkJusc6_tgk` | publisher-b (Publisher B) | 2026-02-01–2026-02-14 |

Browser: http://localhost:8080

Setup verified: normal `bid-identity` contains two Argon2id users, two login indexes and two memberships; `bid-publisher-data` contains both publisher metadata records (`PUBLISHER#publisher-a` / `PUBLISHER#publisher-b`, `METADATA`). Explicit bootstrap created two users, then repeated with two unchanged users and no conflicts. PostgreSQL database `bid` application (`public`/`drizzle`) and saver (`agent_checkpoints`) migrations are initialized. Normal API/web/DynamoDB/Postgres services are healthy; both real browser logins and publisher assignments passed at the URL above. A saved smoke question under demo.a deliberately shows the visible missing-model-settings error; no live response is claimed. Analytics are checked-in tiny fixtures, not a DynamoDB historical dataset. PostgreSQL stores conversations/checkpoints. Authentication is stateless: no session records.

Real model status: not verified in this implementation; required private model key setting is missing. Configure LLM_BASE_URL, LLM_MODEL and LLM_API_KEY privately; for an explicitly unauthenticated endpoint, use a nonempty local placeholder permitted by that endpoint. A host model URL must be reachable from the API container. Restart API/web after configuration. No real model, API, signing or database secrets are in this file.

Local setup changes: only missing/blank AUTH_SIGNING_SECRET and DEMO_PASSWORD_A/B were added to gitignored `.env`; no existing nonblank values were replaced. The signing secret is persistent and is not in this file. Ordinary startup does not reseed accounts or migrate SQL.
