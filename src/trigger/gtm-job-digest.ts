import { schedules } from "@trigger.dev/sdk";
import { Resend } from "resend";

// Daily digest of remote "GTM Engineer" (and close variants) postings from
// Himalayas + Remotive + Arbeitnow, emailed via Resend. Fires 9:00 AM
// Asia/Kolkata. Test manually anytime from the Trigger.dev dashboard.
//
// Himalayas (https://himalayas.app/jobs/api/search?q=...) is the primary
// source — it's the only one of the three whose server-side query param
// actually filters (confirmed live: "GTM Engineer" returns real matches,
// a gibberish query returns 0). Remotive's and Arbeitnow's `search`/query
// params were confirmed to do nothing at all (real query vs. gibberish
// query returned identical results on both) — they're kept only as cheap
// supplementary sources, with relevance enforced entirely client-side via
// isRelevantTitle() for all three. Don't trust `search=`/`q=` from a new
// source without testing it against a gibberish query first, the way this
// was verified.

const HIMALAYAS_SEARCH_URL = "https://himalayas.app/jobs/api/search?q=GTM%20Engineer&sort=recent";
const HIMALAYAS_PAGES_TO_FETCH = 3; // ~20 results/page; covers well beyond a week of this title's volume
const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";
const ARBEITNOW_URL = "https://www.arbeitnow.com/api/job-board-api";
const USER_AGENT = "gtm-job-digest/1.0 (+https://github.com/chetanmuley01/gtm-job-digest)";

// GTM Engineer is a niche, low-volume title, and Remotive's whole feed is
// currently a small handful of jobs. A tight 24-48h window regularly finds
// nothing. Widened to 7 days so genuine matches aren't missed; the tradeoff
// (no persistent store, so a match can resurface across a few days' emails)
// is accepted deliberately — repeats are far less bad than silence.
const LOOKBACK_HOURS = 24 * 7;
const MAX_JOBS_IN_EMAIL = 20;
const SEND_ON_ZERO_RESULTS = true; // set false to stay silent on quiet days

const TO_EMAIL = process.env.DIGEST_TO_EMAIL ?? "chetanmuley01@gmail.com";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

interface NormalizedJob {
  title: string;
  company: string;
  location: string;
  url: string;
  postedAtMs: number;
  source: "Himalayas" | "Remotive" | "Arbeitnow";
}

interface HimalayasJob {
  title: string;
  companyName: string;
  applicationLink: string;
  locationRestrictions: string[];
  pubDate: number; // unix seconds
}

interface RemotiveJob {
  url: string;
  title: string;
  company_name: string;
  publication_date: string;
  candidate_required_location: string;
}

interface ArbeitnowJob {
  title: string;
  company_name: string;
  location: string;
  url: string;
  remote: boolean;
  created_at: number; // unix seconds
}

function isRelevantTitle(title: string): boolean {
  const t = title.toLowerCase();
  return /\bgtm\b/.test(t) || /go[- ]to[- ]market/.test(t) || (/\bgrowth\b/.test(t) && /\bengineer/.test(t));
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
    const jobs = await fetchRecentJobs();

    if (jobs.length === 0 && !SEND_ON_ZERO_RESULTS) {
      console.log("No matching GTM Engineer postings — skipping email (SEND_ON_ZERO_RESULTS=false)");
      return { newJobs: 0, emailed: false };
    }

    await sendDigestEmail(jobs);
    return { newJobs: jobs.length, emailed: true };
  },
});

async function fetchHimalayasJobs(): Promise<NormalizedJob[]> {
  const pageNumbers = Array.from({ length: HIMALAYAS_PAGES_TO_FETCH }, (_, i) => i + 1);
  const pages = await Promise.all(
    pageNumbers.map(async (page) => {
      const response = await fetch(`${HIMALAYAS_SEARCH_URL}&page=${page}`, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`Himalayas API returned ${response.status}: ${response.statusText} (page ${page})`);
      }
      const data = (await response.json()) as { jobs: HimalayasJob[] };
      return data.jobs;
    }),
  );

  return pages.flat().map((job) => ({
    title: job.title,
    company: job.companyName,
    location: job.locationRestrictions.length === 0 ? "Worldwide" : job.locationRestrictions.join(", "),
    url: job.applicationLink,
    postedAtMs: job.pubDate * 1000,
    source: "Himalayas" as const,
  }));
}

async function fetchRemotiveJobs(): Promise<NormalizedJob[]> {
  const response = await fetch(REMOTIVE_URL);
  if (!response.ok) {
    throw new Error(`Remotive API returned ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { jobs: RemotiveJob[] };
  return data.jobs.map((job) => ({
    title: job.title,
    company: job.company_name,
    location: job.candidate_required_location,
    url: job.url,
    postedAtMs: new Date(job.publication_date).getTime(),
    source: "Remotive" as const,
  }));
}

async function fetchArbeitnowJobs(): Promise<NormalizedJob[]> {
  const response = await fetch(ARBEITNOW_URL);
  if (!response.ok) {
    throw new Error(`Arbeitnow API returned ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as { data: ArbeitnowJob[] };
  return data.data
    .filter((job) => job.remote)
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.location || "Remote",
      url: job.url,
      postedAtMs: job.created_at * 1000,
      source: "Arbeitnow" as const,
    }));
}

async function fetchRecentJobs(): Promise<NormalizedJob[]> {
  const results = await Promise.allSettled([fetchHimalayasJobs(), fetchRemotiveJobs(), fetchArbeitnowJobs()]);

  const candidates: NormalizedJob[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
    } else {
      console.error("Job source fetch failed:", result.reason);
    }
  }
  if (results.every((r) => r.status === "rejected")) {
    throw new Error("All job source fetches failed (Himalayas, Remotive, Arbeitnow)");
  }

  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const seenUrls = new Set<string>();
  const matches: NormalizedJob[] = [];

  for (const job of candidates) {
    if (!isRelevantTitle(job.title)) continue;
    if (job.postedAtMs < cutoff) continue;
    if (seenUrls.has(job.url)) continue;
    seenUrls.add(job.url);
    matches.push(job);
  }

  return matches.sort((a, b) => b.postedAtMs - a.postedAtMs).slice(0, MAX_JOBS_IN_EMAIL);
}

async function sendDigestEmail(jobs: NormalizedJob[]) {
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
      ? `GTM Engineer Jobs — ${jobs.length} found (${dateStr})`
      : `GTM Engineer Jobs — nothing new (${dateStr})`;

  const { html, text } = buildEmailBody(jobs, dateStr);

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

function buildEmailBody(jobs: NormalizedJob[], dateStr: string): { html: string; text: string } {
  const windowDays = LOOKBACK_HOURS / 24;

  if (jobs.length === 0) {
    const html = `<p>No remote "GTM Engineer" (or close variant) postings found across Himalayas + Remotive + Arbeitnow in the last ${windowDays} days as of ${dateStr}.</p>`;
    return { html, text: html.replace(/<[^>]+>/g, "") };
  }

  const rows = jobs
    .map((job) => {
      const posted = new Date(job.postedAtMs).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
      });
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">
            <a href="${job.url}" style="font-size:15px;font-weight:600;color:#1a56db;text-decoration:none;">${escapeHtml(job.title)}</a><br/>
            <span style="color:#333;">${escapeHtml(job.company)}</span> &middot;
            <span style="color:#666;">${escapeHtml(job.location)}</span><br/>
            <span style="color:#999;font-size:12px;">${escapeHtml(job.source)} &middot; posted ${posted}</span>
          </td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#111;">GTM Engineer — ${jobs.length} remote role${jobs.length === 1 ? "" : "s"} (${dateStr})</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <p style="color:#999;font-size:12px;margin-top:20px;">Sources: Himalayas + Remotive + Arbeitnow &middot; window: last ${windowDays} days</p>
    </div>`;

  const text = jobs
    .map((job) => `${job.title} — ${job.company} (${job.location}) [${job.source}]\n${job.url}`)
    .join("\n\n");

  return { html, text };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
