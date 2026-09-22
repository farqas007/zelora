import { useEffect, useState } from "react";
import type { ApiEnvelope, HealthResponse } from "@zelora/shared";

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type ApiStatus = "checking" | "online" | "offline";

interface ApiHealthState {
  status: ApiStatus;
  health: HealthResponse | null;
}

const INITIAL_STATE: ApiHealthState = { status: "checking", health: null };

export function App() {
  const [healthState, setHealthState] = useState<ApiHealthState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`);
        if (!response.ok) {
          throw new Error(`Unexpected status ${response.status}`);
        }
        const body = (await response.json()) as ApiEnvelope<HealthResponse>;
        if (cancelled) return;
        if (body.ok) {
          setHealthState({ status: "online", health: body.data });
        } else {
          setHealthState({ status: "offline", health: null });
        }
      } catch {
        if (!cancelled) {
          setHealthState({ status: "offline", health: null });
        }
      }
    }

    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="site-header">
        <p className="brand">Zelora</p>
        <p className="tagline">Multi-vendor marketplace platform</p>
      </header>
      <main id="main-content" className="main">
        <h1>Zelora foundations</h1>
        <p>
          This page is the technical shell for the Zelora marketplace platform. It exists to
          prove that the web application, the API service and the shared contracts build,
          type-check and talk to each other — it is not marketplace UI.
        </p>

        <section className="status-card" aria-labelledby="status-heading">
          <h2 id="status-heading">Platform status</h2>
          <div role="status" aria-live="polite">
            {healthState.status === "checking" && <p>Checking API connection…</p>}
            {healthState.status === "online" && healthState.health !== null && (
              <p>
                API online · service <code>{healthState.health.service}</code> · version{" "}
                <code>{healthState.health.version}</code>
              </p>
            )}
            {healthState.status === "offline" && (
              <p>API offline — start the API with <code>pnpm dev</code>.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="scope-heading">
          <h2 id="scope-heading">Current scope</h2>
          <ul>
            <li>Phase 1 — foundation: monorepo, web app, API service, shared contracts.</li>
            <li>No database, authentication, accounts, catalog, cart or checkout yet.</li>
          </ul>
        </section>
      </main>
      <footer className="site-footer">
        <p>Zelora · foundation shell · Phase 1</p>
      </footer>
    </div>
  );
}