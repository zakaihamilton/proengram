import Link from "next/link";
import Image from "next/image";
import { ThemeControl } from "panel-frame-ui";
import { BrandMark } from "@/components/brand";
import { WelcomeReveal } from "@/components/welcome-reveal";
import { getDashboardIdentity } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import appIcon from "./icon.png";

function ArrowIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path
        d="M4 10h11m-4.5-4.5L15 10l-4.5 4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function SourceIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path
        d="M5.5 2.8h6l3.2 3.3v10.5a.8.8 0 0 1-.8.8H6.3a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
      <path
        d="M11.3 2.9v3.5h3.2M7.8 10h4.8M7.8 13h4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function LineIcon({ path, className }: { path: string; className: string }) {
  return (
    <span aria-hidden="true" className={className}>
      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <path
          d={path}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      </svg>
    </span>
  );
}

export default async function HomePage() {
  const identity = await getDashboardIdentity();
  if (identity) redirect("/overview");

  return (
    <main className="welcome-page">
      <div className="welcome-wrap">
        <header className="welcome-header">
          <Link aria-label="ProEngram home" className="welcome-brand" href="/">
            <Image
              alt=""
              className="welcome-app-icon"
              height={32}
              priority
              src={appIcon}
              width={32}
            />
            <span>ProEngram</span>
          </Link>
          <nav aria-label="Main navigation" className="welcome-nav">
            <a className="welcome-nav-link" href="#how-it-works">
              How it works
            </a>
            <ThemeControl label="Appearance" />
            <Link className="welcome-sign-in" href="/login">
              Sign in
            </Link>
          </nav>
        </header>

        <section aria-labelledby="welcome-title" className="welcome-hero">
          <div className="welcome-copy">
            <p className="welcome-kicker">
              <span aria-hidden="true" /> A shared brain for your company
            </p>
            <h1 id="welcome-title">
              Your team’s best answers <em>stay useful.</em>
            </h1>
            <p className="welcome-intro">
              Give ChatGPT and Claude the company context your team trusts, and keep useful answers
              close to the sources they came from.
            </p>
            <div className="welcome-actions">
              <Link className="welcome-primary" href="/login">
                Open your workspace <ArrowIcon />
              </Link>
              <span className="welcome-action-note">Secure sign-in through Perminister</span>
            </div>
            <div className="welcome-integrations">
              <span>Works with</span>
              <strong>GitHub</strong>
              <strong>ChatGPT</strong>
              <strong>Claude</strong>
            </div>
          </div>

          <div className="welcome-art">
            <div className="welcome-preview">
              <div className="welcome-preview-header">
                <span className="welcome-preview-brand">
                  <BrandMark small /> ProEngram
                </span>
                <span className="welcome-live">Shared library</span>
              </div>
              <div className="welcome-preview-body">
                <p className="welcome-preview-label">A question from your team</p>
                <p className="welcome-preview-question">
                  What should I share when a customer asks about data retention?
                </p>
                <div className="welcome-answer">
                  <div>
                    <p className="welcome-answer-title">
                      A clear answer, grounded in your guidance
                    </p>
                    <p className="welcome-answer-copy">
                      Explain the retention period and point them to your approved privacy guidance.
                    </p>
                  </div>
                </div>
                <div className="welcome-sources-label">From your company library</div>
                <div className="welcome-source-row">
                  <span className="welcome-source-icon">
                    <SourceIcon />
                  </span>
                  <span>Data retention policy</span>
                  <span className="welcome-source-type">GitHub</span>
                </div>
                <div className="welcome-source-row">
                  <span className="welcome-source-icon">
                    <SourceIcon />
                  </span>
                  <span>Customer privacy guide</span>
                  <span className="welcome-source-type">GitHub</span>
                </div>
              </div>
              <div className="welcome-preview-footer">
                <span>Source-linked</span>
                <span>Shared with your team</span>
              </div>
            </div>
          </div>
        </section>

        <section aria-label="ProEngram benefits" className="welcome-benefits">
          <div className="welcome-section-heading">
            <p className="welcome-section-kicker">A better home for company knowledge</p>
            <h2>Make good work easier to find, trust, and reuse.</h2>
          </div>
          <div className="welcome-benefits-layout">
            <div className="welcome-benefits-visual">
              <Image
                alt="Colleagues reviewing a printed company policy beside a laptop."
                fill
                sizes="(max-width: 980px) 100vw, 48vw"
                src="/images/knowledge-review.jpg"
              />
            </div>
            <WelcomeReveal className="welcome-feature-grid">
              <article className="welcome-feature">
                <LineIcon
                  className="welcome-feature-icon"
                  path="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5zM5 4.5v17M9 6h7M9 10h7"
                />
                <h3>Knowledge with a source</h3>
                <p>
                  Find trusted company guidance while keeping GitHub Markdown as the editable home
                  for your docs.
                </p>
              </article>
              <article className="welcome-feature">
                <LineIcon
                  className="welcome-feature-icon"
                  path="M7.5 3.5h9A1.5 1.5 0 0 1 18 5v15.5L12 17l-6 3.5V5a1.5 1.5 0 0 1 1.5-1.5Z"
                />
                <h3>Answers worth keeping</h3>
                <p>
                  Save useful answers once so teammates can build on what the company already knows.
                </p>
              </article>
              <article className="welcome-feature">
                <LineIcon
                  className="welcome-feature-icon"
                  path="M12 3 20 6v6c0 5-3.5 8-8 11-4.5-3-8-6-8-11V6l8-3ZM8.5 12l2.2 2.2 4.8-5"
                />
                <h3>Access that stays governed</h3>
                <p>
                  Perminister manages who can access the workspace and contribute to shared
                  knowledge.
                </p>
              </article>
            </WelcomeReveal>
          </div>
        </section>

        <section
          aria-labelledby="welcome-process-title"
          className="welcome-process"
          id="how-it-works"
        >
          <WelcomeReveal className="welcome-process-content">
            <div className="welcome-section-heading">
              <p className="welcome-section-kicker">A practical workflow</p>
              <h2 id="welcome-process-title">From approved documentation to reusable answers.</h2>
            </div>
            <div className="welcome-process-body">
              <ol className="welcome-process-grid">
                <li className="welcome-process-step">
                  <div className="welcome-process-step-heading">
                    <span className="welcome-process-number">01</span>
                    <h3>Index your documentation</h3>
                  </div>
                  <p>
                    GitHub Markdown is synced to a searchable shared library and stays editable in
                    your repository.
                  </p>
                </li>
                <li className="welcome-process-step">
                  <div className="welcome-process-step-heading">
                    <span className="welcome-process-number">02</span>
                    <h3>Retrieve a sourced answer</h3>
                  </div>
                  <p>
                    Ask through ChatGPT or Claude, then follow each answer back to its company
                    source.
                  </p>
                </li>
                <li className="welcome-process-step">
                  <div className="welcome-process-step-heading">
                    <span className="welcome-process-number">03</span>
                    <h3>Improve the shared library</h3>
                  </div>
                  <p>
                    Save a useful answer for teammates or propose a documentation update for review
                    in GitHub.
                  </p>
                </li>
              </ol>
              <div className="welcome-process-visual">
                <Image
                  alt="Colleagues discussing company guidance around a laptop."
                  fill
                  sizes="(max-width: 980px) 100vw, 48vw"
                  src="/images/team-review.jpg"
                />
              </div>
            </div>
          </WelcomeReveal>
        </section>

        <section aria-labelledby="welcome-trust-title" className="welcome-trust">
          <WelcomeReveal className="welcome-trust-content">
            <div className="welcome-trust-copy">
              <p className="welcome-section-kicker">System boundaries</p>
              <h2 id="welcome-trust-title">The systems you already rely on stay in control.</h2>
              <p>
                ProEngram makes company knowledge easier to use without replacing the tools that own
                its content, approval, or access.
              </p>
              <div className="welcome-trust-visual">
                <Image
                  alt="A team member checking a printed reference beside a document on their laptop."
                  fill
                  sizes="(max-width: 980px) 100vw, 36vw"
                  src="/images/source-check.jpg"
                />
              </div>
            </div>
            <dl className="welcome-trust-list">
              <div className="welcome-trust-row">
                <dt>Knowledge source</dt>
                <dd>
                  <strong>GitHub</strong>
                  <span>Markdown remains editable in your repositories.</span>
                </dd>
              </div>
              <div className="welcome-trust-row">
                <dt>Content review</dt>
                <dd>
                  <strong>Pull requests</strong>
                  <span>Suggested changes go to maintainers for review.</span>
                </dd>
              </div>
              <div className="welcome-trust-row">
                <dt>Workspace access</dt>
                <dd>
                  <strong>Perminister</strong>
                  <span>Member grants determine access to company knowledge.</span>
                </dd>
              </div>
            </dl>
          </WelcomeReveal>
        </section>

        <section aria-labelledby="welcome-cta-title" className="welcome-cta">
          <WelcomeReveal className="welcome-cta-panel">
            <div className="welcome-cta-copy">
              <p className="welcome-section-kicker">Get started</p>
              <h2 id="welcome-cta-title">
                Start with the company documents your team already trusts.
              </h2>
            </div>
            <div className="welcome-cta-actions">
              <Link className="welcome-primary" href="/login">
                Open your workspace <ArrowIcon />
              </Link>
              <span>Secure sign-in through Perminister</span>
            </div>
          </WelcomeReveal>
        </section>

        <footer className="welcome-footer">
          <Link aria-label="ProEngram home" className="welcome-brand welcome-footer-brand" href="/">
            <Image alt="" className="welcome-footer-icon" height={24} src={appIcon} width={24} />
            <span>ProEngram</span>
          </Link>
          <p>Keep the context. Share what works.</p>
        </footer>
      </div>
    </main>
  );
}
