import { PhoneCall, Sparkles } from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
  category?: string;
}

/**
 * Standalone Layout — no "back to use cases" since this app IS the single use case.
 * The page header has the brand mark + product name + a subtle status pill that
 * signals the app is using the v3 multi-agent pipeline.
 */
const Layout = ({ children, title, description, category }: LayoutProps) => {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50/60 via-white to-slate-50/40">
      {/* Sticky brand header */}
      <header className="bg-white/85 backdrop-blur-md border-b border-slate-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="bg-gradient-to-br from-emerald-100 to-emerald-50 border border-emerald-200 rounded-xl p-2 shadow-sm">
                <PhoneCall className="h-5 w-5 text-emerald-700" />
              </div>
              <div>
                <div className="text-base font-semibold text-slate-900 leading-tight tracking-tight">
                  RCU AI Verification
                </div>
                <div className="text-xs text-slate-500 leading-tight">
                  Bajaj Auto Credit · Telephonic Confirmation Automation
                </div>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live · v3
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Hero / page title section */}
      <section className="relative bg-white border-b border-slate-200 overflow-hidden">
        {/* Soft radial glow behind the title */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.07),transparent_60%)]" />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-center">
          {category && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-xs font-medium mb-4 shadow-sm">
              <Sparkles className="size-3" />
              {category}
            </div>
          )}
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-slate-900 mb-4 tracking-tight">
            {title}
          </h1>
          <p className="text-base sm:text-[15px] text-slate-600 max-w-2xl mx-auto leading-relaxed">
            {description}
          </p>
        </div>
      </section>

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>Bajaj Auto Credit · Risk Containment Unit · AI Verification</span>
          <span className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 font-mono text-[10px]">
              Soniox stt-async-v4
            </span>
            <span className="text-slate-400">·</span>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 font-mono text-[10px]">
              gpt-4o-mini (cached)
            </span>
          </span>
        </div>
      </footer>
    </div>
  );
};

export default Layout;
