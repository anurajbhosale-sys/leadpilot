import type { Metadata } from "next";
import Link from "next/link";
import { demoUsesRealLlm, isDemoMode } from "@/lib/demo";
import "./globals.css";

export const metadata: Metadata = {
  title: "LeadPilot",
  description: "AI lead, call & attribution platform for multi-location service businesses",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {isDemoMode() && (
          <div role="note" className="bg-amber-100 px-6 py-2 text-center text-xs text-amber-900">
            <strong>Demo.</strong> Every business, lead, call and number here is synthetic.{" "}
            {demoUsesRealLlm()
              ? "AI responses come from a real model, rate-limited."
              : "AI responses are simulated (mock mode), so no model is called."}{" "}
            Please don&apos;t enter real personal details.
          </div>
        )}
        <nav className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl gap-6 px-6 py-3 text-sm">
            <span className="font-semibold">LeadPilot</span>
            <Link href="/" className="text-slate-600 hover:text-slate-900">Lead form</Link>
            <Link href="/calls" className="text-slate-600 hover:text-slate-900">Calls</Link>
            <Link href="/approvals" className="text-slate-600 hover:text-slate-900">Approvals</Link>
            <Link href="/dashboard" className="text-slate-600 hover:text-slate-900">Dashboard</Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
