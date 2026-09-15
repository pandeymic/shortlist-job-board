# Shortlist — Google Sheets publishing

An update to the original Shortlist prototype. The clean interface is preserved; public feed switches, import buttons, employer forms, Remotive integration, and automatic sample listings have been removed.

## What is built
- A read-only connection from a private Google Sheet to a persistent SQLite database.
- Automatic sync on startup when due, then every 15 minutes while the server is running. A 15-second local timer checks the database schedule; it does NOT call Google every 15 seconds.
- Approval-based publishing, status-based withdrawal, duplicate detection, and safe validation.
- Public job browsing, keyword/location/type/remote filters, saved bookmarks, and external applications.
- A local administrator CLI for sync, status, issue export, CSV template generation, and consistent SQLite backups.
- Tests and an importable CSV template.

## What is NOT connected or deployed
No Google credentials or spreadsheet are configured. No private Sheet was accessed or changed during this build. Live Google authentication and retrieval have NOT been verified; signing, requests, and responses were tested with mocks.

No public deployment, X/Agent Reach collector, paid service, email system, employer accounts, application collection, or user account system was added. Jobs and approval decisions come only from your Sheet. The future Codex collector needs its own separate write authorization.

## Requirements
- Node.js **24 LTS** (the project uses built-in node:sqlite).
- A persistent server with internet access to Google's APIs.
- A private Google Sheet and a read-only service account.
- No npm install required: the server and tests use Node built-ins only. Node may print an experimental SQLite warning depending on your release.

## 1. Run the project locally
Extract the ZIP. Open a terminal in the project folder:

```sh
node --version
cp .env.example .env
node server.mjs
```
On Windows, copy `.env.example` to `.env` in File Explorer instead of using `cp`.
Open http://localhost:3000. Without Google setup it honestly shows that jobs are unavailable. It never substitutes fictional jobs.

Stop with Ctrl+C. Restart after changing environment variables.

## 2. Prepare your Google Sheet
1. Create a private Google Sheet.
2. Import `sheet-template.csv` into a tab named `Jobs`, or copy its header row exactly.
3. Delete or replace the clearly fictional example row. It is Pending and will not publish.
4. Format job IDs, URLs, and timestamps as **Plain text**. Do not use formulas in the data range. Optional: add a data-validation dropdown for status: Pending, Approved, Rejected, Closed.
5. Freeze row 1. Put internal notes in columns after M or in a separate tab. The backend reads A:M only.

### Columns (exact names, A:M)

| Column | Format / requirement |
|---|---|
| job_id | Required for all rows. Stable unique text, 1–160 characters: letters, digits, `_`, `.`, `:`, `-`. First character must be a letter or digit. Do not change it after publication. |
| title | Required to publish. Plain text. |
| company | Required to publish. Plain text. |
| location | Candidate eligibility, e.g. India, Worldwide, US only. Blank is unknown, NOT worldwide. |
| work_arrangement | Remote, Hybrid, On-site, or blank. |
| employment_type | Full-time, Part-time, Contract, Internship, Freelance, Temporary, or blank. |
| salary_text | Preserve the employer's currency, range, and period. Blank is unknown. |
| description | Required to publish. Plain text only; HTML is displayed literally, not executed. Maximum 30,000 characters. |
| application_url | Required to publish. HTTP/HTTPS only, no embedded username/password. Must lead to an actual application page. |
| source_url | Optional original post/career-page URL. HTTP/HTTPS only. |
| posted_at | ISO date `2026-09-08` or timestamp `2026-09-08T08:30:00Z` (timezone required for timestamps), or blank. This is the source publication date, not proof the job was first opened then. |
| collected_at | Same ISO formats, or blank. Internal, not exposed by the public endpoint. |
| status | Exact, case-sensitive: Pending, Approved, Rejected, Closed. Required. |

Other text fields have a 2,048-character limit. Numeric Google date serials and ambiguous dates such as 09/08/26 are rejected for approved rows. Optional fields are not guessed.

**Approval is a publication decision:** check the employer, application link, source permission/attribution requirements, location eligibility, and absence of personal or confidential information before approving. Job details become public when you mark Approved. Keep raw research and private notes out of public description fields. The software does not verify job legitimacy or grant rights to redistribute third-party content.

## 3. Create read-only Google access
1. In Google Cloud Console, select or create a project and enable the **Google Sheets API**.
2. Under IAM & Admin → Service Accounts, create a service account. No broad project role and no domain-wide delegation are needed for reading a Sheet directly shared with it.
3. If your organization's policy permits service-account keys, create a JSON key. Store it OUTSIDE this project/repository, e.g. a private credentials folder, with restrictive file permissions. If key creation is disabled, ask your administrator for an approved credential approach; do not bypass the restriction.
4. Copy the service account email ending in `iam.gserviceaccount.com`.
5. In your Sheet's Share dialog, add that email as **Viewer**. Keep General access Restricted. Share only the intended Sheet, not your whole Drive or a folder.
6. Configure `.env` locally (do not send key material in chat):

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/absolute/private/path/service-account.json
GOOGLE_SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_SHEET_TAB=Jobs
DATABASE_PATH=./data/shortlist.sqlite
HOST=127.0.0.1
PORT=3000
```

The spreadsheet ID is the portion between `/d/` and `/edit` in the Google Sheets URL. Use the tab name, NOT its numeric gid.

For a hosting secret manager, you may instead set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` as secret environment variables and leave `GOOGLE_APPLICATION_CREDENTIALS` unset. Escaped `\n` in the private key is supported. Do not paste secrets into source code, commits, prompts, or logs. OAuth token exchange uses RS256 and the `spreadsheets.readonly` scope; tokens are kept only in server memory.

Official references:
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get

## 4. Verify the first live sync

```sh
node cli.mjs sync
node cli.mjs status
```

Only safe row numbers and validation codes are printed, never credentials or full cell contents. Resolve any errors, restart the server if needed, and visit the site. Make one genuine row Approved and verify it appears. Change it to Closed and confirm it disappears after the next sync or after running the local sync command.

Manual sync is intentionally a terminal command, not a public website endpoint. It still respects an in-progress sync lease. Automatic sync honors a database-backed next-run timestamp, so starting two processes against the SAME database does not double the source polling. Do not run separate independently cached database copies for one site.

## 5. Daily workflow
1. Manually ask Codex + Agent Reach to collect matching hiring posts into the Sheet. Use stable job IDs, deduplicate, leave unknown fields blank, and set new rows Pending. Codex must write values with Sheets' `RAW` mode and keep credentials separate. Agent Reach's installed access does not automatically confer Sheets write permissions.
2. Review rows. Mark good opportunities Approved.
3. The backend publishes within about 15 minutes while awake. Visitors see changes on opening/reloading the page; the frontend does not repeatedly poll while they are typing.
4. Mark a role Closed to withdraw it. Do not delete the row as your normal closure workflow.

There is no X collector or daily X schedule in this project. The site does not infer that a job is valid, open, or globally remote just because a post exists.

## Sync behavior and safety
- Approved + valid → insert/update and publish.
- Pending, Rejected, Closed, or invalid status → hide an existing listing for the same valid job_id.
- Approved but missing required fields, invalid dates/URLs, disallowed formulas, or duplicated IDs → keep hidden and report validation issues.
- Duplicate approved application URLs are compared after removing tracking parameters and fragments. Conflicting rows stay hidden for review; different real roles using one generic application URL may need distinct URLs or manual resolution.
- A new ID cannot duplicate the URL of a retained missing published row.
- Missing Sheet row → retained in its last published state, marked missing for administrator review. This prevents accidental mass deletion but means you MUST review missing-row warnings. Set Closed explicitly to withdraw.
- Blank/headerless/malformed response or API failure → reject that sync and retain the last successful publication state.
- A valid header-only Sheet counts as a successful empty collection; existing rows are flagged missing, not deleted.
- Missing/invalid IDs cannot identify an old listing; they are reported but cannot reliably withdraw it. Restore its old ID and set Closed.
- Database transactions prevent partial publication. A five-minute lease excludes overlapping writers; network calls time out well before the lease. An interrupted run is recorded on the next acquired sync.
- Last attempt, last success, additions, updates, closures, errors, and missing counts are recorded locally. The latest 100 run summaries are retained; detailed issues are capped at 100 per run. Current row validation/missing flags are available through `issues`.
- Public endpoints omit statuses, collection timestamps, invalid rows, and credentials.
- Sheet descriptions are escaped text. Incoming content cannot become instructions or executable code. Application links are opened externally; the backend does not fetch arbitrary links.
- CSV helpers protect against formula-leading characters. When building a separate collector, use RAW writes instead of USER_ENTERED and do not execute fetched content.
- Changing the Sheet ID/tab while reusing a bound database is blocked. Use a deliberate new database path and review publication before switching sources.

## Admin commands
```sh
node cli.mjs sync
node cli.mjs status
node cli.mjs issues > issues.csv
node cli.mjs template new-template.csv
node cli.mjs backup backups/shortlist.sqlite
node --test test/core.test.mjs
```
The template contains an intentionally Pending fictional row. Do not approve it as a real job.

## Deployment
Use one always-on Node 24 server with persistent storage. Set HOST=0.0.0.0 for most managed/container hosts, use their PORT, and configure secret variables securely. Mount a persistent disk at the configured DATABASE_PATH parent directory. Use HTTPS at the hosting proxy, monitor sync failures and missing-row warnings, and configure a process manager to restart after crashes.

Do NOT run this SQLite version on an ephemeral filesystem or on separate horizontally scaled database copies. Sleeping hosts only catch up when awakened. For serverless/multi-instance production, migrate to a shared database and an external scheduler with a shared lock. The sync runs only while the server process is alive; this ZIP by itself is not an online service.

A Dockerfile is included for a single persistent container. It intentionally does not copy secrets or data. Mount the data directory and credentials separately, and configure the relevant environment variables. The image listens on port 3000 by default.

## Backups and recovery
Use the backup command for a consistent SQLite snapshot, including when WAL mode is active. Do not copy only the .sqlite file while the server is writing; current data can also be in -wal. Store backups privately with restricted permissions, as they include unpublished rows. Test restoration periodically.

To restore: stop all processes using the database, move the existing database AND its -wal/-shm files aside, restore the snapshot to DATABASE_PATH, and restart. For a fresh source, choose a new empty DATABASE_PATH rather than silently mixing audiences.

## Troubleshooting
- GOOGLE_CREDENTIALS_NOT_CONFIGURED / CREDENTIAL_FILE_INVALID: check your private path or secret variables.
- PRIVATE_KEY_INVALID: verify newline handling and that it is a service-account private key.
- GOOGLE_AUTH_HTTP_400: verify key validity and server time.
- GOOGLE_SHEETS_HTTP_403: enable the Sheets API and share the Sheet with the service account as Viewer.
- GOOGLE_SHEETS_HTTP_404 / HTTP_400: check Sheet ID, access, tab name, and A:M headers.
- SHEET_COLUMNS_MISMATCH: copy the exact header names from the template into A:M.
- SYNC_FAILED: generic redacted error; inspect local environment and tests, never enable credential/body logging.
- SOURCE_CHANGED_USE_NEW_DATABASE: deliberate source changes require a new database.
- Website says jobs unavailable: no successful sync yet. Use the local status command.
- No jobs after successful sync: check that rows are Approved AND valid.

## Testing and limitations
`node --test test/core.test.mjs` uses temporary/in-memory databases and explicitly fictional fixtures; it never connects to Google. Backend tests cover approval/withdrawal, edits, duplicate detection, validation, safe URLs/formulas, atomic rollback, persistence, locking, HTTP route protections, redacted errors, JWT signing, and read-only token reuse. Browser smoke tests during development cover public navigation, filters, bookmarks, external applications, escaped descriptions, empty/error views, and narrow-screen layout.

This is an implementation ready for your configuration, not a claim of live Google connectivity or deployment. No personal data submission flows exist. Bookmarks are local to a browser and do not sync across devices. A production launch still needs your operational monitoring, privacy/legal review, source-use permissions, and hosting setup.
