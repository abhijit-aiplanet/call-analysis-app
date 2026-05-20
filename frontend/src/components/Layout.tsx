import { PhoneCall } from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
  category?: string;
}

/**
 * Standalone Layout — no "back to use cases" since this app IS the single use case.
 * Header has just the brand mark + product name.
 */
const Layout = ({ children, title, description, category }: LayoutProps) => {
  return (
    <div className="min-h-screen bg-slate-50/40">
      {/* Slim header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-100 rounded-lg p-2">
              <PhoneCall className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <div className="text-base font-semibold text-slate-900 leading-tight">
                Call Analysis Pipeline
              </div>
              <div className="text-xs text-slate-500 leading-tight">
                Scribe v2 + Multi-Agent Sentiment
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Page title section */}
      <section className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-center">
          {category && (
            <div className="inline-block px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-full text-xs font-medium mb-3">
              {category}
            </div>
          )}
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-3 tracking-tight">
            {title}
          </h1>
          <p className="text-base text-slate-600 max-w-2xl mx-auto leading-relaxed">
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 text-center text-xs text-slate-500">
          Bajaj Auto Credit · Call Analysis Pipeline
        </div>
      </footer>
    </div>
  );
};

export default Layout;
