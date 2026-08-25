import { schedules } from "@trigger.dev/sdk";
import { Resend } from "resend";

// Daily digest of new remote "GTM Engineer" postings from Remotive, emailed via Resend.
// Fires 9:00 AM Asia/Kolkata. Test manually anytime from the Trigger.dev dashboard.

const SEARCH_QUERY = "GTM Engineer";
const REMOTIVE_URL = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(SEARCH_QUERY)}`;

// Remotive's feed is delayed ~24h, and the cron runs once every 24h, so the
// lookback window is padded wider than one day. This means a job posted near
// the boundary can legitimately appear in two consecutive days' emails —
// there's no cross-run dedup without a persistent store, and that's an
// accepted tradeoff (missing a job would be worse than repeating one).
const LOOKBACK_HOURS = 48;
const MAX_JOBS_IN_EMAIL = 20;
const SEND_ON_ZERO_RESULTS = true; // set false to stay silent on quiet days

const TO_EMAIL = process.env.DIGEST_TO_EMAIL ?? "chetanmuley01@gmail.com";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

interface RemotiveResponse {
  "job-count": number;
  jobs: RemotiveJob[];
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
      console.log("No new GTM Engineer postings — skipping email (SEND_ON_ZERO_RESULTS=false)");
      return { newJobs: 0, emailed: false };
    }

    await sendDigestEmail(jobs);
    return { newJobs: jobs.length, emailed: true };
  },
});

async function fetchRecentJobs(): Promise<RemotiveJob[]> {
  const response = await fetch(REMOTIVE_URL);
  if (!response.ok) {
    throw new Error(`Remotive API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as RemotiveResponse;
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  return data.jobs
    .filter((job) => new Date(job.publication_date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publication_date).getTime() - new Date(a.publication_date).getTime())
    .slice(0, MAX_JOBS_IN_EMAIL);
}

async function sendDigestEmail(jobs: RemotiveJob[]) {
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
      ? `GTM Engineer Jobs — ${jobs.length} new (${dateStr})`
      : `GTM Engineer Jobs — no new postings today (${dateStr})`;

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

function buildEmailBody(jobs: RemotiveJob[], dateStr: string): { html: string; text: string } {
  if (jobs.length === 0) {
    const html = `<p>No new remote "GTM Engineer" postings found on Remotive in the last ${LOOKBACK_HOURS}h as of ${dateStr}.</p>`;
    return { html, text: html.replace(/<[^>]+>/g, "") };
  }

  const rows = jobs
    .map((job) => {
      const posted = new Date(job.publication_date).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
      });
      const salary = job.salary ? ` &middot; ${escapeHtml(job.salary)}` : "";
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">
            <a href="${job.url}" style="font-size:15px;font-weight:600;color:#1a56db;text-decoration:none;">${escapeHtml(job.title)}</a><br/>
            <span style="color:#333;">${escapeHtml(job.company_name)}</span> &middot;
            <span style="color:#666;">${escapeHtml(job.candidate_required_location)}</span>${salary}<br/>
            <span style="color:#999;font-size:12px;">${escapeHtml(job.job_type)} &middot; posted ${posted}</span>
          </td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#111;">GTM Engineer — ${jobs.length} new remote roles (${dateStr})</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <p style="color:#999;font-size:12px;margin-top:20px;">Source: Remotive &middot; window: last ${LOOKBACK_HOURS}h</p>
    </div>`;

  const text = jobs
    .map((job) => `${job.title} — ${job.company_name} (${job.candidate_required_location})\n${job.url}`)
    .join("\n\n");

  return { html, text };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
