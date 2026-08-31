import { schedules } from "@trigger.dev/sdk";
import { Resend } from "resend";

// Daily digest of new remote "GTM Engineer" postings, emailed via Resend.
// Fires 9:00 AM Asia/Kolkata. Test manually anytime from the Trigger.dev dashboard.
//
// Sources are tried as a WATERFALL, in priority order: Bloomberry -> Remotive ->
// RemoteOK -> Jobicy -> Arbeitnow -> Himalayas. Each source is filtered to postings within the
// last LOOKBACK_DAYS. The first source that returns at least one qualifying job
// wins for this run — its top MAX_JOBS_IN_EMAIL newest jobs are emailed. Sources
// are NOT merged; this keeps the digest focused instead of a pile from every API.
//
// Bloomberry needs a real BLOOMBERRY_API_KEY (sign up at bloomberry.com/signup.html)
// — if unset, it's skipped and the waterfall starts at Remotive.
//
// Only worldwide-eligible postings are shown: a "remote" listing restricted to a
// single country (e.g. remote-within-US) isn't actually open to us, so
// isWorldwideLocation() filters those out after each source's own fetch.
//
// With a 15-day lookback and a once-daily cron, a job posted near the boundary can
// legitimately appear in two consecutive days' emails — there's no cross-run dedup
// without a persistent store, and that's an accepted tradeoff (missing a job would
// be worse than repeating one).

const SEARCH_QUERY = "GTM Engineer";
const KEYWORD_TERMS = ["gtm", "go-to-market", "go to market", "revops", "revenue operations"];

const LOOKBACK_DAYS = 15;
const MAX_JOBS_IN_EMAIL = 5;
const SEND_ON_ZERO_RESULTS = true; // set false to stay silent on quiet days

const TO_EMAIL = process.env.DIGEST_TO_EMAIL ?? "chetanmuley01@gmail.com";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

interface NormalizedJob {
  title: string;
  company: string;
  url: string;
  location: string;
  postedAt: Date;
  salary?: string;
  sourceName: string;
}

export const gtmJobDigest = schedules.task({
  id: "gtm-job-digest",
  cron: {
    pattern: "0 9 * * *",
    timezone: "Asia/Calcutta", // IST — Trigger.dev's supported list uses this alias, not "Asia/Kolkata"
  },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 30_000,
  },
  run: async () => {
    const { jobs, sourceName, sourcesTried } = await fetchViaWaterfall();

    if (jobs.length === 0 && !SEND_ON_ZERO_RESULTS) {
      console.log(
        `No new GTM Engineer postings from any source (tried: ${sourcesTried.join(", ")}) — skipping email (SEND_ON_ZERO_RESULTS=false)`
      );
      return { newJobs: 0, emailed: false, sourcesTried };
    }

    await sendDigestEmail(jobs, sourceName, sourcesTried);
    return { newJobs: jobs.length, emailed: true, source: sourceName, sourcesTried };
  },
});

function cutoffDate(): Date {
  return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

function matchesKeywords(...fields: (string | undefined)[]): boolean {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return KEYWORD_TERMS.some((term) => haystack.includes(term));
}

// Many "remote" listings are only remote-within-a-country (e.g. "United
// States", "Brazil") — worth knowing about, but not actually open to
// someone anywhere. Only a job with no location restriction at all (or an
// explicit "Worldwide"/"Anywhere"/"Global" location string) is genuinely
// open to anyone, so that's what this digest shows.
function isWorldwideLocation(location: string): boolean {
  const l = location.toLowerCase();
  return l === "worldwide" || l.includes("anywhere") || l.includes("global");
}

async function fetchViaWaterfall(): Promise<{
  jobs: NormalizedJob[];
  sourceName: string;
  sourcesTried: string[];
}> {
  const fetchers: { name: string; fetch: () => Promise<NormalizedJob[]> }[] = [
    { name: "Bloomberry", fetch: fetchBloomberry },
    { name: "Remotive", fetch: fetchRemotive },
    { name: "RemoteOK", fetch: fetchRemoteOK },
    { name: "Jobicy", fetch: fetchJobicy },
    { name: "Arbeitnow", fetch: fetchArbeitnow },
    { name: "Himalayas", fetch: fetchHimalayas },
  ];

  const sourcesTried: string[] = [];

  for (const { name, fetch: fetchSource } of fetchers) {
    if (name === "Bloomberry" && !process.env.BLOOMBERRY_API_KEY) {
      console.log("Skipping Bloomberry — BLOOMBERRY_API_KEY not set");
      continue;
    }

    sourcesTried.push(name);
    try {
      const jobs = (await fetchSource()).filter((job) => isWorldwideLocation(job.location));
      console.log(`${name}: found ${jobs.length} worldwide-eligible job(s) in the last ${LOOKBACK_DAYS}d`);
      if (jobs.length > 0) {
        return { jobs: jobs.slice(0, MAX_JOBS_IN_EMAIL), sourceName: name, sourcesTried };
      }
    } catch (err) {
      console.error(`${name} fetch failed, falling through to next source:`, err);
    }
  }

  return { jobs: [], sourceName: sourcesTried[sourcesTried.length - 1] ?? "none", sourcesTried };
}

// --- Bloomberry (via revealera.com) ---------------------------------------

interface RevealeraJob {
  id: string;
  title: string;
  company_name: string;
  url: string;
  region?: string; // e.g. "United States (Remote)" — free text, not a clean restriction flag
  created_at: string; // unix seconds, as a string
  inactive?: string; // "1" if the posting is no longer active
}

interface RevealeraResponse {
  jobs: RevealeraJob[];
}

async function fetchBloomberry(): Promise<NormalizedJob[]> {
  const apiKey = process.env.BLOOMBERRY_API_KEY;
  const beginDate = cutoffDate().toISOString().slice(0, 10);
  const url =
    `https://api.revealera.com/signals/jobs.json?` +
    `api_key=${encodeURIComponent(apiKey!)}` +
    `&keyword=${encodeURIComponent(SEARCH_QUERY)}` +
    `&remote_only=true` +
    `&begin_date=${beginDate}` +
    `&search_job_title_only=true` +
    `&limit=20`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bloomberry API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as RevealeraResponse;
  const cutoff = cutoffDate().getTime();

  return (data.jobs ?? [])
    .filter((job) => job.inactive !== "1")
    .map((job) => ({ ...job, postedAtMs: Number(job.created_at) * 1000 }))
    .filter((job) => job.postedAtMs >= cutoff)
    .sort((a, b) => b.postedAtMs - a.postedAtMs)
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      url: job.url,
      location: job.region || "",
      postedAt: new Date(job.postedAtMs),
      sourceName: "Bloomberry",
    }));
}

// --- Remotive ---------------------------------------------------------------

interface RemotiveJob {
  url: string;
  title: string;
  company_name: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
}

interface RemotiveResponse {
  jobs: RemotiveJob[];
}

async function fetchRemotive(): Promise<NormalizedJob[]> {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(SEARCH_QUERY)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Remotive API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as RemotiveResponse;
  const cutoff = cutoffDate().getTime();

  return data.jobs
    .filter((job) => matchesKeywords(job.title))
    .filter((job) => new Date(job.publication_date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publication_date).getTime() - new Date(a.publication_date).getTime())
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      url: job.url,
      location: job.candidate_required_location,
      postedAt: new Date(job.publication_date),
      salary: job.salary || undefined,
      sourceName: "Remotive",
    }));
}

// --- RemoteOK -----------------------------------------------------------------

interface RemoteOKJob {
  position?: string;
  company?: string;
  url?: string;
  tags?: string[];
  date?: string;
  location?: string;
}

async function fetchRemoteOK(): Promise<NormalizedJob[]> {
  const response = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "gtm-job-digest (+chetanmuley01@gmail.com)" },
  });
  if (!response.ok) {
    throw new Error(`RemoteOK API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as RemoteOKJob[];
  const cutoff = cutoffDate().getTime();

  return data
    .filter((job): job is Required<Pick<RemoteOKJob, "position" | "url" | "date">> & RemoteOKJob =>
      Boolean(job.position && job.url && job.date)
    )
    .filter((job) => matchesKeywords(job.position, ...(job.tags ?? [])))
    .filter((job) => new Date(job.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map((job) => ({
      title: job.position,
      company: job.company ?? "Unknown",
      url: job.url,
      location: job.location || "Remote",
      postedAt: new Date(job.date),
      sourceName: "RemoteOK",
    }));
}

// --- Jobicy ---------------------------------------------------------------

interface JobicyJob {
  jobTitle: string;
  companyName: string;
  url: string;
  pubDate: string;
  jobGeo?: string;
  jobIndustry?: string[];
}

interface JobicyResponse {
  jobs: JobicyJob[];
}

async function fetchJobicy(): Promise<NormalizedJob[]> {
  const response = await fetch("https://jobicy.com/api/v2/remote-jobs?count=50&industry=marketing");
  if (!response.ok) {
    throw new Error(`Jobicy API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as JobicyResponse;
  const cutoff = cutoffDate().getTime();

  return data.jobs
    .filter((job) => matchesKeywords(job.jobTitle, ...(job.jobIndustry ?? [])))
    .filter((job) => new Date(job.pubDate).getTime() >= cutoff)
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .map((job) => ({
      title: job.jobTitle,
      company: job.companyName,
      url: job.url,
      location: job.jobGeo || "Remote",
      postedAt: new Date(job.pubDate),
      sourceName: "Jobicy",
    }));
}

// --- Arbeitnow ---------------------------------------------------------------

interface ArbeitnowJob {
  title: string;
  company_name: string;
  url: string;
  remote: boolean;
  tags?: string[];
  created_at: number; // unix seconds
  location?: string;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
}

async function fetchArbeitnow(): Promise<NormalizedJob[]> {
  const response = await fetch("https://www.arbeitnow.com/api/job-board-api");
  if (!response.ok) {
    throw new Error(`Arbeitnow API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as ArbeitnowResponse;
  const cutoff = cutoffDate().getTime();

  return data.data
    .filter((job) => job.remote)
    .filter((job) => matchesKeywords(job.title, ...(job.tags ?? [])))
    .filter((job) => job.created_at * 1000 >= cutoff)
    .sort((a, b) => b.created_at - a.created_at)
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      url: job.url,
      location: job.location || "Remote",
      postedAt: new Date(job.created_at * 1000),
      sourceName: "Arbeitnow",
    }));
}

// --- Himalayas ---------------------------------------------------------------

interface HimalayasJob {
  title: string;
  companyName: string;
  applicationLink: string;
  pubDate: number; // unix seconds
  locationRestrictions: string[]; // empty = no restriction, i.e. worldwide
  categories?: string[];
  parentCategories?: string[];
}

interface HimalayasResponse {
  jobs: HimalayasJob[];
}

// Himalayas' plain browse endpoint (/jobs/api) has no keyword filter, and its
// /search?keyword= param silently ignores the keyword too — confirmed live by
// comparing a real query against gibberish and getting the same huge unfiltered
// count both times. /search?q= is the one that actually filters (verified the
// same way: a real query returns real matches, gibberish returns zero), so
// that's what's used here, fetched across a few pages for coverage.
const HIMALAYAS_PAGES_TO_FETCH = 3;

async function fetchHimalayas(): Promise<NormalizedJob[]> {
  const pageNumbers = Array.from({ length: HIMALAYAS_PAGES_TO_FETCH }, (_, i) => i + 1);
  const pages = await Promise.all(
    pageNumbers.map(async (page) => {
      const url = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(SEARCH_QUERY)}&sort=recent&page=${page}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Himalayas API returned ${response.status}: ${response.statusText} (page ${page})`);
      }
      const data = (await response.json()) as HimalayasResponse;
      return data.jobs;
    })
  );

  const cutoff = cutoffDate().getTime();

  return pages
    .flat()
    .filter((job) => matchesKeywords(job.title, ...(job.categories ?? []), ...(job.parentCategories ?? [])))
    .filter((job) => job.pubDate * 1000 >= cutoff)
    .sort((a, b) => b.pubDate - a.pubDate)
    .map((job) => ({
      title: job.title,
      company: job.companyName,
      url: job.applicationLink,
      location: job.locationRestrictions.length === 0 ? "Worldwide" : job.locationRestrictions.join(", "),
      postedAt: new Date(job.pubDate * 1000),
      sourceName: "Himalayas",
    }));
}

// --- Email --------------------------------------------------------------------

async function sendDigestEmail(jobs: NormalizedJob[], sourceName: string, sourcesTried: string[]) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }
  const resend = new Resend(apiKey);

  const dateStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const subject =
    jobs.length > 0
      ? `GTM Engineer Jobs — ${jobs.length} new via ${sourceName} (${dateStr})`
      : `GTM Engineer Jobs — no new postings today (${dateStr})`;

  const { html, text } = buildEmailBody(jobs, sourceName, sourcesTried, dateStr);

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [TO_EMAIL],
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}

function buildEmailBody(
  jobs: NormalizedJob[],
  sourceName: string,
  sourcesTried: string[],
  dateStr: string
): { html: string; text: string } {
  if (jobs.length === 0) {
    const html = `<p>No worldwide-eligible "GTM Engineer" postings found in the last ${LOOKBACK_DAYS} days as of ${dateStr}. Sources tried: ${escapeHtml(
      sourcesTried.join(", ")
    )}.</p>`;
    return { html, text: html.replace(/<[^>]+>/g, "") };
  }

  const rows = jobs
    .map((job) => {
      const posted = job.postedAt.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
      });
      const salary = job.salary ? ` &middot; ${escapeHtml(job.salary)}` : "";
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">
            <a href="${job.url}" style="font-size:15px;font-weight:600;color:#1a56db;text-decoration:none;">${escapeHtml(job.title)}</a><br/>
            <span style="color:#333;">${escapeHtml(job.company)}</span> &middot;
            <span style="color:#666;">${escapeHtml(job.location)}</span>${salary}<br/>
            <span style="color:#999;font-size:12px;">posted ${posted}</span>
          </td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#111;">GTM Engineer — ${jobs.length} new remote roles (${dateStr})</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <p style="color:#999;font-size:12px;margin-top:20px;">Source: ${escapeHtml(sourceName)} &middot; worldwide-eligible only &middot; window: last ${LOOKBACK_DAYS}d &middot; also tried: ${escapeHtml(
    sourcesTried.filter((s) => s !== sourceName).join(", ") || "none"
  )}</p>
    </div>`;

  const text = jobs
    .map((job) => `${job.title} — ${job.company} (${job.location})\n${job.url}`)
    .join("\n\n");

  return { html, text };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
