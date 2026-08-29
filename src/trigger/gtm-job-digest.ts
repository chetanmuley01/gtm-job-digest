import { schedules } from "@trigger.dev/sdk";
import { Resend } from "resend";

// Daily digest of remote "GTM Engineer" (and close variants) postings from
// Remotive + Arbeitnow, emailed via Resend. Fires 9:00 AM Asia/Kolkata.
// Test manually anytime from the Trigger.dev dashboard.
//
// Neither source's server-side `search` query param actually filters
// (confirmed live: a real query and a gibberish query returned identical
// results on both APIs) — so relevance is enforced entirely client-side via
// isRelevantTitle() below. Don't rely on `search=` params from either API.

const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";
const ARBEITNOW_URL = "https://www.arbeitnow.com/api/job-board-api";

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
  source: "Remotive" | "Arbeitnow";
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
  const results = await Promise.allSettled([fetchRemotiveJobs(), fetchArbeitnowJobs()]);

  const candidates: NormalizedJob[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      candidates.push(...result.value);
    } else {
      console.error("Job source fetch failed:", result.reason);
    }
  }
  if (results.every((r) => r.status === "rejected")) {
    throw new Error("Both Remotive and Arbeitnow fetches failed");
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
    const html = `<p>No remote "GTM Engineer" (or close variant) postings found across Remotive + Arbeitnow in the last ${windowDays} days as of ${dateStr}.</p>`;
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
      <p style="color:#999;font-size:12px;margin-top:20px;">Sources: Remotive + Arbeitnow &middot; window: last ${windowDays} days</p>
    </div>`;

  const text = jobs
    .map((job) => `${job.title} — ${job.company} (${job.location}) [${job.source}]\n${job.url}`)
    .join("\n\n");

  return { html, text };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
