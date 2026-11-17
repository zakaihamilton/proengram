import Link from "next/link";
import { AuthCard, AuthShell, ThemeControl } from "panel-frame-ui";
import { BrandMark } from "@/components/brand";
import { getDashboardIdentity } from "@/lib/auth/session";
import { redirect } from "next/navigation";

const errorCopy: Record<string, string> = {
  configuration: "ProEngram sign-in is not configured for this deployment.",
  state: "The sign-in request expired or could not be verified. Please try again.",
  issuer: "The identity provider did not match the expected Perminister issuer.",
  missing_code: "Perminister did not return a sign-in code. Please try again.",
  access_denied: "Your account does not have access to this ProEngram workspace.",
  sign_in_failed: "Sign-in could not be completed. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const identity = await getDashboardIdentity();
  if (identity) redirect("/overview");
  const params = await searchParams;
  const errorKey = Array.isArray(params.error) ? params.error[0] : params.error;
  const error = errorKey ? errorCopy[errorKey] || "Sign-in was not completed." : null;
  if (!error) redirect("/auth/perminister/start");

  return (
    <main className="access-page">
      <AuthShell
        brand={
          <a className="pf-brand proengram-brand" href="/login">
            <BrandMark /> <span>ProEngram</span>
          </a>
        }
        aside={
          <div className="auth-aside">
            <p className="eyebrow">COMPANY KNOWLEDGE</p>
            <h1>Good answers should outlive the chat.</h1>
            <p>
              Search the shared library, find approved policy context, and save useful work for your
              team.
            </p>
            <ul>
              <li>Company Markdown stays in GitHub.</li>
              <li>Shared answers live in Nanogres PostgreSQL.</li>
              <li>Perminister controls who can read and contribute.</li>
            </ul>
          </div>
        }
        utility={<ThemeControl label="Appearance" />}
      >
        <AuthCard>
          <p className="eyebrow">WELCOME</p>
          <h2>Continue with Perminister</h2>
          <p className="pf-page-description">Use your company Perminister account to continue.</p>
          <p className="login-error" role="alert">
            {error}
          </p>
          <Link
            className="pf-button pf-button-primary login-retry"
            href="/auth/perminister/start?prompt=login"
          >
            Try again with Perminister
          </Link>
          <p className="login-note">
            Your ChatGPT or Claude subscription remains separate. ProEngram only provides shared
            company context and tools.
          </p>
        </AuthCard>
      </AuthShell>
    </main>
  );
}
