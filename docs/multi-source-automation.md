# Multi-source Offers automation through Phase 5

This implementation adds a separate, dry-run-only source cycle to the existing evidence and Notion code. No service was deployed, no workflow was activated, no production Notion page was written, and no live source or Claude result was used for validation. Fixtures are synthetic. The repository did not contain a separately numbered approved plan; the five phases below map to the requested scope.

| Phase | Delivered |
| --- | --- |
| 1 | Validated source registry, disabled examples, external secret references, per-source cadence and failure isolation |
| 2 | Remotive JSON, RSS 2.0/WWR, Greenhouse, Lever (global/EU, bounded pagination), Ashby public adapters |
| 3 | DNS-pinned capture, redirect/SSRF checks, deterministic evidence, provenance, canonical deduplication and conflict quarantine |
| 4 | Optional Claude tool-schema enrichment, existing idempotent Notion mapping/upsert integration, enforced dry-run plans |
| 5 | Atomic local checkpoint, inactive n8n ingestion/health exports, deployment procedure, offline tests and health checks |

## Run locally

Requires Node >=22.18 and the locked development dependencies for typecheck. Review `examples/sources.json`; sources ship disabled. Replace ATS board/company placeholders and enable only permitted sources. Review source terms, attribution and published usage limits before enabling. Cadence is per source. Remote aggregators -- the ones that actually produce the digest -- run at the registry's own minimum for their adapter, between two and six hours. Company ATS boards run every twelve hours: a company does not post twenty-four times a day, and the ceiling is the 24-hour verification TTL, since at a 1440-minute cadence the previous availability check expires exactly as the next one arrives and offers flicker to `stale`. No automatic retries are made for rate limits, CAPTCHA or authentication failures. No logged-in browser scraping, session cookies, anti-bot evasion or LinkedIn/Indeed/Glassdoor capture is supported. Mail ingestion remains in its existing local workflow.

```sh
npm ci
npm test
npm run check
npm run sources -- --dry-run
npm run sources -- --health
```

Running the source cycle performs public GET requests only for explicitly enabled sources. “Dry-run” permits these reads and local persistence; it never calls a Notion write transport. It rejects `enabled:true` Notion configuration before fetching. There is no sync/activate switch in this entrypoint. The CLI does not run sources without `--dry-run`. No source was enabled as part of this implementation.

The registry fixes API hosts/routes from board names. RSS uses an explicit HTTPS endpoint without credentials or a query string. For a private authorized RSS feed, set `secretEnv` to an environment variable name such as `OFFERS_SOURCE_TEAM_TOKEN`, then inject that bearer secret into the worker process from the deployment secret store. The registry rejects inline secret fields and arbitrary credential environment names. Never store secret values in repository files, CLI arguments, n8n JSON, logs or source URLs. Authenticated redirects across origins are blocked. Public ATS adapters need no API credentials.

## Evidence and identity

Each capture retains provider/source ID, external ID, original URL, final feed endpoint, observation timestamp, SHA-256 of the provider row and the publication field used. No timestamp is derived from discovery time. Greenhouse `updated_at` and Lever `createdAt` are deliberately not publication evidence. Ashby `publishedAt` means last published, as documented by the provider; provenance preserves that field rather than claiming the original posting date. Missing fields, malformed rows, unlisted Ashby jobs and Greenhouse prospect posts cannot become eligible records. RSS requires an explicit company or registry company; WWR's documented `Company: Role` title convention is recognized only on its host.

Feed presence from Remotive or RSS is ambiguous availability. Public ATS listings provide an explicit published-list signal. Optional `captureHtml:true` performs fresh HTML capture, replacing availability even on failure. Only a single URL-bound JSON-LD JobPosting with valid dates is accepted. HTTP 200, arbitrary page text, malformed or multiple matching postings, missing URL bindings, future dates and invalid deadlines do not establish verified evidence. Conflicting publication dates quarantine the record. HTML capture is limited to the first 100 jobs per source per cycle; excess jobs are explicitly blocked and the source is partial. Missing jobs in a later feed do not prove closure; old evidence expires under the existing 24-hour verification TTL and three-day publication window.

URL normalization removes fragments/tracking parameters, sorts remaining query parameters and removes trailing slashes. Meaningful job-ID parameters remain. Exact canonical URLs merge across providers with combined provenance. Company/title/date conflicts are blocked. Similar titles on different URLs never merge automatically. Existing source-ID keyed records keep their Notion key if exactly one existing record matches the canonical URL; ambiguous legacy aliases remain present but blocked. Provider IDs remain in provenance for audit rather than changing the established store identity format.

The source CLI seeds its independent store from `data/offers.json` on the first run and then uses `data/source-cycle.json`. It preserves the mail store byte-for-byte and does not continuously import later mail changes. The existing mail and new source cycle share the automation lock, but should not be used as concurrent production Notion writers. A future combined writer must reconcile both stores first.

One atomic, fsynced checkpoint contains the normalized store, cadence, health, accumulated provenance, optional suggestions and Notion plan. The cycle's raw `jobs` array is returned in memory but **deliberately not persisted**: nothing reads it back (a resumed run recovers only `store`, `state` and `provenance`), and it accounted for roughly 46% of the checkpoint's size. Provider payload hashes retain first/latest observations of each distinct payload; full remote documents are not archived. Store history records changes as before. Back up the checkpoint and limit retention of historical payload variants according to local requirements. Files are mode 0600; descriptions are untrusted text, never executed. Local artifact readers should escape any rendered HTML.

## Network boundary

DNS lookup checks every returned address at each redirect hop. Connections pin a validated address using Node's connection lookup while preserving the hostname for TLS verification. Private, loopback, link-local, multicast, reserved/documentation and IPv6 transition/mapped ranges are rejected. HTTPS downgrade, URL credentials, nonstandard ports and disallowed job-site hosts are rejected. The transport makes GET requests without proxy environment settings, cookies or automatic redirects.

Default limits are 8 seconds for the whole request including DNS and redirects, five redirects, and 2 MB measured while streaming. Content types are adapter-specific. The transport requests identity encoding and rejects compressed responses rather than risking expansion. Lever has a 50-page/100-row budget; repeating pages or reaching the budget fails the source without publishing partial captures. Sources and HTML requests execute sequentially. Custom injected transports/resolvers are test seams and must uphold their contracts; production uses the supplied pinned transport.

## Optional Claude enrichment

```sh
npm run sources -- --dry-run --enrich-model MODEL_ID
```

Inject `ANTHROPIC_API_KEY` from the worker secret store and select a model available to that account. This opt-in sends captured title/description (up to 20,000 characters) to Claude and may incur API charges. It was not exercised against the live API here. The default run does not import credentials or call Claude.

Enrichment runs after deterministic capture and deduplication. A maximum of 100 jobs per cycle can be enriched; excess jobs retain deterministic output with an enrichment-budget warning. A forced tool input schema permits only a bounded summary and quoted skill suggestions. Runtime validation rejects extra fields, fabricated quotes, unsupported skills and duplicates; output is capped at 100 KB with a 20-second timeout. Untrusted job text is explicitly separated from instructions. Suggestions stay in a separate `enrichments` map and never change dates, identity, verification, screening, compensation, score or Notion properties. Invalid responses add a warning and deterministic ingestion continues. Summaries remain non-authoritative, even after structural validation.

## Notion boundary

The existing `planNotionSync` and `upsertNotionRecords` implement query-by-external-key, update/create, unchanged-row skipping and duplicate-key rejection. Tests use a fake Notion transport to verify replay idempotence. Multi-source automation imports the planner only and always emits `confirmed:false`.

To produce mapped payloads, supply the existing ignored `data/notion-local.json` with `schemaVerified:true` and a valid `config` whose `enabled` is false. Schema verification is an operator assertion; this implementation does not inspect remote schema. Unverified schemas produce blocked plans. The existing verification gate is re-evaluated at plan time. A generated plan is not confirmation of page existence, permissions, deployment or delivery. Do not enable the existing standalone live-sync CLI as part of this deployment.

## Deploy the inactive n8n exports

`workflows/n8n/offers-ingestion.json` and `offers-health.json` contain a manual trigger, an inactive schedule, a fixed SSH command and a fail-closed result validator. They have no credentials, account IDs, production target URLs or Notion nodes. They are JSON/static-gate tested, not imported into a live n8n instance in this task.

1. Provision one dedicated Linux worker with Node >=22.18 at `/usr/local/bin/node`, the repository at `/opt/offers`, and a writable, persistent `data/` directory. Use an unprivileged worker account. Keep code/config read-only to the service except for the required local state. Run the tests/typecheck before using it. Do not copy Mac mail credentials to the VPS.
2. Configure reviewed sources, the local disabled Notion mapping if needed, and environment secrets through the worker's secret manager. With SSH, ensure the remote noninteractive process actually receives those variables. Public feeds require no secrets. Do not give this worker `NOTION_API_KEY`.
3. Run the fixed dry-run command manually on the worker. Inspect the local checkpoint and health; keep raw descriptions/plans on the worker. The CLI emits only counts, source IDs, status and safe reason codes.
4. Import the JSON exports while keeping them inactive. Select an SSH private-key credential in n8n's credential store for each worker node. Restrict access to the worker account and network route; protect and rotate the SSH key. The command/path are literal and must never use webhook or incoming item values. Confirm the worker host and SSH trust policy in your deployed n8n/SSH configuration before executing.
5. Review node compatibility in the installed n8n version. Use manual execution to verify stdout JSON and exit handling. The Code node rejects nonzero exit codes, malformed results or a dry-run gate mismatch. Ingestion also rejects all-disabled/no-healthy-source results. Health runs every 15 minutes; ingestion is scheduled hourly, with provider cadence enforced by the persistent checkpoint. Keep schedules inactive until a separately authorized deployment.

No inbound HTTP endpoint, arbitrary command webhook or durable remote queue is introduced. The workflow uses SSH to the dedicated public-source worker, not to the Mac. This leaves the earlier Mac-mail/VPS design boundary unchanged. Only one worker copy may own a checkpoint; local file locks are not a distributed lock. Workflow automatic retry is off; use cadence-controlled subsequent runs. n8n execution timeout is one hour; if it expires, inspect the remote PID before starting another cycle because stopping an SSH session may leave its child running.

## Read-only tools for deciding

Two subcommands exist to make a decision measurable before it is taken. Neither writes anything.

```sh
bin/offers --probe-source ashby supabase
bin/offers --digest-preview [--now TIMESTAMP] [--profile PATH]
```

`--probe-source` reads one board and reports whether it exists, how many offers it lists, how many carry
`publishedAt`, how many fall inside the freshness window, how many survive the profile's geography gate, and a
sample of the relevant titles. The last two are what decide: a board with hundreds of offers that are all
"Remote, US only" contributes nothing to the cut, and a board whose offers carry no date has 100% of them dropped
by the freshness gate -- the exact bug that hid in the Greenhouse adapter for six sessions. Probe before editing
`examples/sources.json`, never after. The source is built through the registry, so the probe validates exactly
what the cycle will validate.

`--digest-preview` prints the daily cut without recording it: no delivery ledger, no metrics line, no digest file.
`--profile` points it at an alternative profile, which is what makes a profile change measurable -- run it twice
over the same checkpoint with the same `--now` and diff. It deliberately does not take the cycle lock, since it
only reads and every write in this project is atomic; taking the lock would make previewing fail while the cycle
runs, which is when you want to look.

## Health and recovery

CLI exits: 0 completed plan, 2 invalid arguments, 3 occupied lock, 4 configuration/source/persistence/health failure, 5 unverified schema with blocked records, 6 partial source data. An empty or all-disabled cycle can return 0 locally, but health and n8n ingestion checks flag it. Blocked jobs from missing evidence are expected and distinct from failed sources. A fresh health checkpoint requires an enabled healthy source and no failed/partial sources; snapshots older than 24 hours or future-dated snapshots fail. Source failures remain unhealthy during cooldown. Enrichment warnings are visible in local captures and do not redefine source transport health.

Inspect `health`, `counts`, `jobs[].warnings`, `notionPlan.blocked` and provenance locally. On 403/429, respect provider policy; reduce cadence or disable that source. Do not add bypasses. For malformed feed data, retain the failed status and update fixtures/adapters after reviewing the provider contract. A schema gate failure requires local mapping review, not a live write attempt.

A crash before checkpoint replacement leaves the previous complete checkpoint; a restart can refetch public data but deduplication and the Notion dry-run gate remain intact. A crash can leave a lock: read its PID, confirm no process is running, then remove only that stale lock manually. Never auto-steal locks. On corrupt checkpoints, restore a reviewed backup; the CLI fails instead of resetting state. Back up before pruning history or resetting cadence. Recovery must not overwrite the original mail store. Health has no network or write side effects.

## Provider references

Adapter contracts were checked against the [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Lever Postings API](https://github.com/lever/postings-api), [Ashby public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api), [Remotive public API](https://github.com/remotive-com/remote-jobs-api), and [WWR RSS page](https://weworkremotely.com/remote-job-rss-feed). Optional integrations follow [Claude tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) and the [n8n SSH node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ssh/). Consulting documentation did not verify any live job, account, workflow or Notion result.
