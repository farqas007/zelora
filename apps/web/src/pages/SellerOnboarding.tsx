import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";

export function SellerOnboardingPage() {
  return (
    <PageShell title="Seller onboarding">
      <p>
        The seller onboarding form arrives in a later step. It will submit to
        the existing <code>POST /api/seller/onboarding</code> contract.
      </p>
      <p>
        Back to the <Link to="/">home page</Link>.
      </p>
    </PageShell>
  );
}