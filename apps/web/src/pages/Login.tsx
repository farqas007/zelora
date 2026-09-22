import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";

export function LoginPage() {
  return (
    <PageShell title="Sign in">
      <p>
        The sign-in form arrives in a later step. In the meantime, register an
        account or go back to the <Link to="/">home page</Link>.
      </p>
    </PageShell>
  );
}