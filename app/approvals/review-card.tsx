"use client";

import { useActionState, useEffect, useState } from "react";
import { decide, type DecisionState } from "./actions";

const REVIEWER_KEY = "leadpilot.reviewer";

export function ReviewCard({ id, draft }: { id: number; draft: string }) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(decide, {});
  const [text, setText] = useState(draft);
  const [reviewer, setReviewer] = useState("");

  // Remember the reviewer's name in this browser (a convenience only; it may be unavailable).
  useEffect(() => {
    try {
      setReviewer(localStorage.getItem(REVIEWER_KEY) ?? "");
    } catch {}
  }, []);
  const saveReviewer = (name: string) => {
    setReviewer(name);
    try {
      localStorage.setItem(REVIEWER_KEY, name);
    } catch {}
  };

  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="id" value={id} />
      <textarea
        name="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={text.length > 320 ? "text-red-600" : "text-slate-500"}>{text.length}/320</span>
        {text !== draft && <span className="text-amber-700">edited</span>}
        <input
          name="reviewer"
          value={reviewer}
          onChange={(e) => saveReviewer(e.target.value)}
          placeholder="Your name"
          className="ml-auto w-40 rounded-md border border-slate-300 px-2 py-1"
        />
        <button
          name="decision"
          value="approve"
          disabled={pending}
          className="rounded-md bg-emerald-700 px-3 py-1 font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          Approve &amp; send
        </button>
        <button
          name="decision"
          value="reject"
          disabled={pending}
          className="rounded-md border border-slate-300 px-3 py-1 font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {state.error && (
        <div className="text-sm text-red-600">
          {state.error}
          {state.errors && (
            <ul className="list-disc pl-5">
              {state.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
