# Local demo accounts

**Demo-only credentials — intentionally stored in this repository at the user's request. Never reuse these passwords elsewhere.**

| Login | Password | Publisher | Fixture dates (UTC) |
| --- | --- | --- | --- |
| demo.a | `am4XhTMx-ZJSRCLzZezATi61` | publisher-a (Publisher A) | 2026-01-01–2026-01-14 |
| demo.b | `4iBX7EwJUCBK9rkJusc6_tgk` | publisher-b (Publisher B) | 2026-02-01–2026-02-14 |

Browser: http://localhost:8080

Setup verified: normal `bid-identity` contains two Argon2id users, two login indexes and two memberships; `bid-publisher-data` contains both publisher metadata records (`PUBLISHER#publisher-a` / `PUBLISHER#publisher-b`, `METADATA`). Explicit bootstrap created two users, then repeated with two unchanged users and no conflicts. PostgreSQL database `bid` application (`public`/`drizzle`) and saver (`agent_checkpoints`) migrations are initialized. Normal API/web/DynamoDB/Postgres services are healthy; both real browser logins and publisher assignments passed at the URL above. The later real Ollama comparison under demo.a completed with citations and saved reload in 31 seconds. Analytics are checked-in tiny fixtures, not a DynamoDB historical dataset. PostgreSQL stores conversations/checkpoints. Authentication is stateless: no session records.

Real model status: verified with local `qwen3.5:9b`. Defaults use `http://host.docker.internal:11434/v1` and non-secret SDK placeholder key `ollama`; no real key is required. Cold loading may take another ~60 seconds. Model tool choice/answer quality can vary. A successful comparison is saved in conversation `504966a0-a2a4-41d1-a7aa-63f930415dff`. No real provider/API/database secrets are in this file.

Local setup changes: the initial bootstrap added missing/blank signing/demo-password settings to gitignored `.env`. The user's later runnable-Ollama request updated the model URL to the Docker Desktop host bridge, supplied the non-secret `ollama` SDK placeholder and increased the timeout. Existing accounts/passwords and the private signing secret were not replaced. The code also includes public local-demo fallback credentials/signing key; never use those for a shared deployment. Ordinary startup does not reseed accounts or migrate SQL.
