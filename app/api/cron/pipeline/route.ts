import { cronAuthError } from "@/lib/cron";
import { runPipelineJob } from "@/pipeline/deps";
import { PipelineBusyError } from "@/pipeline/run";

// The full rebuild runs in one request; give it the longest time a Vercel Hobby function gets.
export const maxDuration = 300;

// GET is how Vercel Cron calls it (vercel.json); POST is kept for manual and external schedulers.
export async function GET(request: Request) {
  return POST(request);
}

// POST /api/cron/pipeline: the nightly pipeline (SPEC A4).
// 200 when the run succeeded; 500 when it failed (an error or a quality check), with the run
// summary in the body so the alert says why; 409 when another run is still in progress.
export async function POST(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const summary = await runPipelineJob();
    return Response.json(summary, { status: summary.status === "succeeded" ? 200 : 500 });
  } catch (err) {
    if (err instanceof PipelineBusyError) return Response.json({ error: err.message }, { status: 409 });
    console.error("Pipeline failed to start:", err);
    return Response.json({ error: "Pipeline failed to start" }, { status: 500 });
  }
}
