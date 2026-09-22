import { Link } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Minimal scaffold layout for placeholder pages, mirroring the existing
 * shell/grid classes from `styles.css` so every route keeps the site chrome.
 */
export interface PageShellProps {
  title: string;
  children: ReactNode;
}

export function PageShell({ title, children }: PageShellProps) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="site-header">
        <Link className="brand" to="/">
          Zelora
        </Link>
        <p className="tagline">Multi-vendor marketplace platform</p>
      </header>
      <main id="main-content" className="main">
        <h1>{title}</h1>
        {children}
      </main>
      <footer className="site-footer">
        <p>Zelora · foundation shell · Phase 1</p>
      </footer>
    </div>
  );
}