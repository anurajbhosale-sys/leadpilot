import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "LeadPilot",
  description: "AI lead, call & attribution platform for multi-location service businesses",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <nav className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl gap-6 px-6 py-3 text-sm">
            <span className="font-semibold">LeadPilot</span>
            <Link href="/" className="text-slate-600 hover:text-slate-900">Lead form</Link>
            <Link href="/calls" className="text-slate-600 hover:text-slate-900">Calls</Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
