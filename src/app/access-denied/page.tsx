import Link from "next/link";
import { AuthCard, AuthShell } from "panel-frame-ui";
import { BrandMark } from "@/components/brand";

export default function AccessDeniedPage() {
  return (
    <main className="access-page">
      <AuthShell
        brand={
          <span className="pf-brand proengram-brand">
            <BrandMark /> ProEngram
          </span>
        }
        aside={
          <div className="auth-aside">
            <p className="eyebrow">COMPANY KNOWLEDGE</p>
            <h1>Access follows your workspace permissions.</h1>
          </div>
        }
      >
        <AuthCard>
          <p className="eyebrow">ACCESS</p>
          <h1>Access is not enabled</h1>
          <p className="pf-page-description">
            Your Perminister account is signed in, but it does not have the current ProEngram
            workspace permission.
          </p>
          <Link className="pf-button pf-button-secondary" href="/login">
            Return to sign in
          </Link>
          <p className="login-note">
            Ask your ProEngram workspace administrator to grant the required access.
          </p>
        </AuthCard>
      </AuthShell>
    </main>
  );
}
