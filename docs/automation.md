# Controlled Offers cycle (local artifacts; not deployed)

Run on the Mac with its existing Himalaya 2.1.0 account and Keychain access:

```sh
npm run automation -- --account personal --himalaya /opt/homebrew/bin/himalaya
```

Paths resolve from the repository, regardless of the working directory. The cycle uses `data/mail-cursor.json`, `data/offers.json`, `data/automation-plan.json`, and `examples/profile.json`. These reuse the established mail cursor and opportunity store. Stop other writers before running: the legacy general CLI does not participate in these locks. Do not run independent copies against shared state.

The cycle locks `data/automation.lock`, then the mail cursor and opportunity store with the existing exclusive file locks. It runs real mail-alert ingestion, persists state and the report/Notion dry-run plan using same-directory atomic replacement and fsync, then acknowledges the mail cursor. Files are individually atomic, not a multi-file transaction. A failed plan can leave newer state with an older plan; only a successful cycle result acknowledges completion. Pending mail is replayed idempotently after failure. No timestamps are invented, evidence is not scraped by this cycle, and missing/ambiguous/expired evidence remains blocked. A blocked record is an expected outcome, not a failed run.

Exit codes: `0` plan saved with configured schema; `2` invalid arguments; `3` lock occupied; `4` configuration, mail, or persistence failure; `5` plan saved but schema unverified. Output contains only counts/status. After a crash, verify the recorded PID and confirm no process is running before manually removing a stale lock. Locks are never automatically stolen.

## Local Notion configuration

`data/notion-local.json` is ignored by the existing `data/` gitignore rule and contains no credentials. Its known target is database `a18a64dd-cda0-42e3-9b05-64446954e5c4`, data source `4c2fb0a6-6c69-4fe7-9bc0-21cf0825851a` (Offers — Opportunities). A read-only inspection of the shared data source confirmed the title and property types/options required by the mapping (`External Key`, `Name`, `Company`, `URL`, `Published`, `Deadline`, screening, employment, relocation, verification and score fields). The local file records `schemaVerified:true`, but keeps `enabled:false`; payload generation remains a dry-run and all remote writes are blocked. No Notion pages were created or updated.

After a separate read-only inspection verifies property names/types against `src/pipeline.ts`, set `schemaVerified:true` and `config` to the existing NotionConfig shape with `enabled:false`, the known `dataSourceId` (not both IDs inside `config`), verified `externalKeyProperty`, `includeCalculationContext`, and `propertyMap`. Keep both IDs in the outer target metadata. A schema assertion is operator supplied, not automatic remote verification. The plan always retains `confirmed:false`: a dry-run cannot confirm remote existence or permissions.

`src/notion-transport.ts` exports the real `transport` accepted by the existing explicit sync CLI. It reads `NOTION_API_KEY` only when called; credentials must be injected into the invoking process environment, never config, arguments, repository files, or logs. It pins the HTTPS Notion API host/routes, rejects redirects, times out after 15 seconds and does not retry writes. Errors suppress response bodies and underlying exception messages. This coding pass does not call that transport; the automation entrypoint cannot sync and never imports it. A future controlled sync must re-evaluate evidence using the real clock and maintain one writer across machines.

## n8n/VPS boundary — design only

No workflow or endpoint is deployed. VPS n8n cannot read this Mac's email account or Keychain. Keep ingestion on the Mac. A future Mac worker can poll an authenticated VPS job endpoint over outbound HTTPS, execute this fixed local dry-run command, and upload a minimal status summary. This avoids requiring inbound Mac access or transferring email credentials. Never pass arbitrary commands, filesystem paths, tokens, or account names from a webhook to a shell.

For a future HTTP trigger, require authenticated requests using a dedicated bearer credential held in n8n's credential store and the worker's local secret store, TLS, credential rotation, request-size limits and rate limits. Persist a caller-generated job ID for deduplication; serialize jobs through one worker and retain this repository lock. Return 202 only after durable queueing; expose authenticated status by job ID. A queued job is not a completed cycle; surface exits 3/4/5 distinctly and retry with the same job ID. Do not upload raw mail, opportunity reports, or plans unless explicitly required. Notion credentials are separate from trigger credentials. The endpoint, durable queue, worker authentication and VPS deployment remain future work.

## Public-source worker extension

The separate [multi-source implementation through Phase 5](multi-source-automation.md) now supplies inactive n8n SSH workflow exports for a dedicated public-source worker and a local dry-run checkpoint/health CLI. It does not deploy the proposed Mac mail endpoint or queue, transfer Mac credentials, activate workflows, or call production Notion. The original local mail cycle and its state remain intact.
