# GTM Job Digest

A daily email of new **remote GTM Engineer** roles, assembled by a six-source waterfall and
delivered at 09:00 IST.

Built because searching six job boards by hand every morning is exactly the kind of
repetitive, low-judgement work that should not be done by a person.

---

## Why this is a GTM engineering problem, not a scraping problem

Job boards are a lead-generation problem wearing different clothes. The same three things
that make prospect data hard make job data hard:

1. **No single source has full coverage.** Every board has gaps, and the gaps move.
2. **Sources disagree on schema.** Six APIs, six shapes for "when was this posted".
3. **The data lies.** A listing tagged `remote` is frequently remote-within-one-country.

This project solves all three the way a GTM data pipeline does.

## The waterfall

Sources are tried **in priority order** until one returns a qualifying result:

```
Bloomberry → Remotive → RemoteOK → Jobicy → Arbeitnow → Himalayas
```

The first source with at least one qualifying job **wins the run**. Sources are
deliberately **not merged** — merging six boards produces a pile, and a pile does not get
read. The digest optimises for being opened, not for being complete.

This is the same fallback pattern that enrichment tools like Clay charge per-credit for:
try the best source, fall through on empty or error, stop at the first good answer.

## Data quality: the "remote" filter

The single highest-value line of logic in the repo:

```ts
function isWorldwideLocation(location: string): boolean {
  const l = location.toLowerCase();
  return l === "worldwide" || l.includes("anywhere") || l.includes("global");
}
```

Most "remote" jobs are remote-within-the-US. For someone applying from outside that
country they are noise, and noise is what kills a daily digest — two weeks of irrelevant
emails and you stop opening it. Every source's results are filtered through this **after**
its own fetch, because no two boards express the restriction the same way.

## Engineering decisions worth defending

| Decision | Reasoning |
|---|---|
| **First-source-wins, no merge** | A focused email gets read. A merged pile gets archived. |
| **Repeats tolerated, misses not** | 15-day lookback on a daily cron means a boundary job can appear twice. Without a persistent store there is no cross-run dedup — and missing a role is far worse than seeing one twice. |
| **Missing API key skips a tier** | No `BLOOMBERRY_API_KEY` starts the waterfall at Remotive instead of crashing. The pipeline degrades, it doesn't fail. |
| **Per-source error isolation** | One board returning 500 falls through to the next. A single bad source cannot take down the run. |
| **Normalized job shape** | Every source maps into one `NormalizedJob` interface, so filtering and rendering stay source-agnostic. |
| **Send on zero results** | Silence is ambiguous — did it find nothing, or did it break? An empty digest is a heartbeat. |

## Stack

| Component | Choice |
|---|---|
| Runtime | TypeScript, Node 24 |
| Scheduling | [Trigger.dev](https://trigger.dev) — cron, retries, observability |
| Email | [Resend](https://resend.com) |
| Retries | 3 attempts, exponential backoff, jitter |
| Sources | Bloomberry (revealera), Remotive, RemoteOK, Jobicy, Arbeitnow, Himalayas |

## Configuration

Everything tunable sits at the top of `src/trigger/gtm-job-digest.ts`:

```ts
const SEARCH_QUERY = "GTM Engineer";
const KEYWORD_TERMS = ["gtm", "go-to-market", "go to market", "revops", "revenue operations"];
const LOOKBACK_DAYS = 15;
const MAX_JOBS_IN_EMAIL = 5;
const SEND_ON_ZERO_RESULTS = true;
```

Retarget it at any role by changing `SEARCH_QUERY` and `KEYWORD_TERMS`. Nothing else is
role-specific.

## Running it

```bash
npm install
cp .env.example .env        # fill in RESEND_API_KEY at minimum
npx trigger.dev@latest dev  # test locally; fire manually from the dashboard
```

`BLOOMBERRY_API_KEY` is optional — the free tier gives 200 credits, and without it the
waterfall simply starts one tier down.

## What I'd build next

- **Persistent seen-jobs store** so cross-run dedup becomes possible, removing the
  repeat-tolerance tradeoff above.
- **Merge-and-rank instead of first-wins**, scoring by recency and keyword density, once
  there is dedup to make merging safe.
- **Company enrichment** on each posting — headcount, funding, tech stack — turning the
  digest from a job list into a qualified account list.
- **Coverage telemetry**: log which source wins over time to find out which boards
  actually carry GTM roles.

---

Built by [Chetan Muley](https://github.com/chetanmuley01).
