import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface MarketFooterProps {
  /** Extra content to render in the footer's bottom bar (e.g. the status pill). */
  statusSlot?: ReactNode;
}

/**
 * Storefront footer shared by the marketplace pages. A page may inject extra
 * bottom-bar content; when nothing is provided a neutral "marketplace open"
 * pill keeps the bar populated.
 */
export function MarketFooter({ statusSlot }: MarketFooterProps) {
  return (
    <footer className="market-footer">
      <div className="footer-ornament" aria-hidden="true">
        <img src="/assets/zelora-mark-light.svg" alt="" width="144" height="144" />
        <span className="footer-ornament-ring" />
      </div>
      <div className="footer-inner">
        <div className="footer-columns">
          <div className="footer-col footer-brand">
            <p className="brand">
              <img
                className="brand-logo"
                src="/assets/zelora-logo-light.svg"
                alt="Zelora"
                width="132"
                height="34"
              />
            </p>
            <p>
              A multi-vendor marketplace where independent sellers and their customers meet,
              shop and grow together.
            </p>
          </div>
          <div className="footer-col">
            <h3>Marketplace</h3>
            <ul>
              <li>
                <Link to="/catalog">Shop all products</Link>
              </li>
              <li>
                <Link to="/catalog">Browse categories</Link>
              </li>
              <li>
                <Link to="/seller/onboarding">Become a seller</Link>
              </li>
              <li>
                <Link to="/seller/onboarding">Seller onboarding</Link>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h3>Account</h3>
            <ul>
              <li>
                <Link to="/login">Sign in</Link>
              </li>
              <li>
                <Link to="/register">Create account</Link>
              </li>
              <li>
                <Link to="/dashboard">Dashboard</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} Zelora · Multi-vendor marketplace</p>
          {statusSlot ?? (
            <span className="status-pill" role="status" aria-live="polite">
              <span className="status-dot online" />
              <span>Marketplace open</span>
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}