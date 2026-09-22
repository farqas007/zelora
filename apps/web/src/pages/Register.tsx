import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";

export function RegisterPage() {
  return (
    <PageShell title="Create an account">
      <p>
        The registration form arrives in a later step. In the meantime, sign in
        to an existing account or go back to the <Link to="/">home page</Link>.
      </p>
    </PageShell>
  );
}