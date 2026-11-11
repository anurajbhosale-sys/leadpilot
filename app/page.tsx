import { llmMode } from "@/lib/ai/client";

// Placeholder home page for Phase 1. The smart lead form replaces this in a later phase.
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">LeadPilot</h1>
      <p className="mt-2 text-slate-600">
        AI lead, call &amp; attribution platform for multi-location service businesses.
      </p>
      <div className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <p>
          <span className="font-medium">Status:</span> Phase 1 (foundation)
        </p>
        <p>
          <span className="font-medium">LLM mode:</span> {llmMode()}
        </p>
      </div>
    </main>
  );
}
