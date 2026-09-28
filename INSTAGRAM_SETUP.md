# Instagram auto-posting for Shortlist

Posts the top approved, not-yet-posted jobs from your Google Sheet to Instagram once a day, as a carousel (1-8 jobs plus cover and CTA, 3-10 slides). Cards are generated as images by code, committed to `public/ig/`, served by the Render app, and published through the Instagram Graph API.

## What this adds

| File | Purpose |
| --- | --- |
| `scripts/generate-job-cards.mjs` | Reads the Sheet (same service-account auth as the server), picks the top `CARDS_PER_POST` approved jobs not in the posted-state file, renders a cover, one 1080x1350 card per job, and a CTA slide as PNG and Meta-ready JPEG into `public/ig/`, and writes `public/ig/manifest.json`. |
| `scripts/instagram-post.mjs` | Creates Instagram media container(s) from the manifest, polls until processed, publishes, then records the job IDs in `automation/instagram-posted.json` so a job is never posted twice. |
| `.github/workflows/instagram-daily.yml` | Daily cron (10:00 IST) plus a manual run with a dry-run toggle. |
| `server.mjs` (modified) | New route: serves `GET /ig/<file>` (JPEG/JSON) from `public/ig/`. Everything else is unchanged. |
| `automation/instagram-posted.json` | State: which job IDs were already posted. Committed by the workflow. |

## 1. Meta / Instagram setup (one time, ~20 minutes)

1. Convert the Instagram account to a **Business or Creator** account (Instagram app: Settings -> Account type).
2. Link it to a **Facebook Page** (Instagram app: Settings -> Linked accounts).
3. At [developers.facebook.com](https://developers.facebook.com) create an app, add the **Instagram Graph API** product.
4. Get a **long-lived access token** (valid ~60 days) with these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
5. Find your Instagram user ID: with the token, call `GET /me/accounts`, take your Page ID, then call `GET /{page-id}?fields=instagram_business_account`. The returned ID is `IG_USER_ID`.
6. Note: long-lived tokens expire roughly every 60 days. When posting starts failing with Meta auth errors, refresh the token and update the GitHub secret. (Refreshing: `GET /oauth/access_token?grant_type=fb_exchange_token&...` - see Meta docs.)

## 2. GitHub configuration

Repo -> Settings -> Secrets and variables -> Actions.

**Secrets tab:**

| Name | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Same service account email as in Render |
| `GOOGLE_PRIVATE_KEY` | Same private key as in Render (paste with real newlines) |
| `IG_USER_ID` | Numeric Instagram business account ID from step 1 |
| `IG_ACCESS_TOKEN` | Long-lived Meta token from step 1 |

**Variables tab:**

| Name | Value |
| --- | --- |
| `GOOGLE_SPREADSHEET_ID` | Your Sheet ID (same as Render) |
| `GOOGLE_SHEET_TAB` | `Jobs` |
| `IMAGE_BASE_URL` | Your Render URL, e.g. `https://shortlist-xxxx.onrender.com` (https, no trailing slash) |
| `CARDS_PER_POST` | Optional. Jobs per post, 1-8 jobs. Default 3. Cover and CTA bring the total to 3-10 slides. |

The workflow needs permission to push commits: Settings -> Actions -> General -> Workflow permissions -> "Read and write permissions".

## 3. How to run

**Dry run first (recommended):** Actions -> Instagram daily -> Run workflow -> leave "dry run" checked. It generates cards and commits them to `public/ig/` but posts nothing. Open the JPGs in the repo and eyeball the cover, each job, and the CTA before posting.

**Real run:** Run workflow again with "dry run" unchecked. It regenerates cards, waits until Render serves them over HTTPS (up to 10 minutes - a push triggers a Render redeploy, and free-tier cold starts are slow), publishes to Instagram, and commits the posted-state file.

**Scheduled:** After the first manual run, it runs by itself daily at 10:00 IST.

**Local testing:** set the same variables in `.env`, then:

```sh
node scripts/generate-job-cards.mjs   # needs librsvg2-bin or imagemagick installed
node scripts/instagram-post.mjs       # actually posts - be sure you mean it
```

## 4. Behavior and limits

- A job is posted once, ever. The posted-state file is the record. To repost a job, delete its entry from `automation/instagram-posted.json`.
- Jobs are picked in Sheet row order: top approved rows first. Keep your best rows near the top.
- Meta's content-publishing limit is about 25 posts per 24 hours per account. One run = one carousel post.
- Instagram requires JPEG images served over public HTTPS - this is why cards go through the repo + Render rather than being uploaded directly.
- Editing a Sheet row after it was posted does not repost it.
- If the Sheet has no new approved jobs, the run exits cleanly and does nothing.

The company marks are typographic labels, not official logos. The Sheet has no verified logo URL; add approved image assets before claiming to display real company logos. The CTA does not promise an automated DM. "Comment JOBS" is an engagement prompt, while the apply links remain in the bio.

## 5. Rendering notes

- The workflow installs `librsvg2-bin` + `imagemagick` (apt, no npm dependencies added).
- On-card text is sanitized to Latin-1 so ImageMagick's fallback renderer cannot silently drop glyphs (the rupee sign renders with Noto Sans under the workflow rasterizer; the fallback renderer may vary, so inspect the dry run).
