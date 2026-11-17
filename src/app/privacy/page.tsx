import Link from "next/link";
import styles from "../privacy.module.css";

export const metadata = {
  title: "Privacy policy · ProEngram",
  description: "How ProEngram handles company knowledge, saved answers, and account information.",
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/login">
          ProEngram
        </Link>
        <Link className={styles.backLink} href="/login">
          Back to sign in
        </Link>
      </header>

      <article className={styles.document} aria-labelledby="privacy-title">
        <p className={styles.kicker}>ProEngram · Privacy</p>
        <h1 id="privacy-title">Privacy policy</h1>
        <p className={styles.intro}>
          ProEngram is operated by Zakai Hamilton. This page explains how information is handled
          when you use the company knowledge dashboard and its connected assistant tools.
        </p>
        <p className={styles.updated}>Last updated November 17, 2026</p>

        <div className={styles.sections}>
          <section>
            <h2>Information the service handles</h2>
            <p>
              Perminister provides the identity, email address, organization membership, and access
              grants used to sign in and authorize actions. ProEngram stores company knowledge
              synced from the configured GitHub repository, including Markdown content and source
              references; saved answers and citations that a user chooses to share; and policy
              snapshots imported by the organization.
            </p>
            <p>
              The service keeps activity records for actions such as knowledge searches, saved
              answers, source synchronization, and proposed GitHub changes. A search activity
              record identifies the actor and action and may include a result count; the search
              text itself is used to find matching items. Tool inputs are processed to complete the
              requested operation.
            </p>
          </section>

          <section>
            <h2>How information is used and shared</h2>
            <p>
              Information is used to search shared knowledge, return company-approved policy
              context, save answers, sync repository documents, and propose edits as GitHub pull
              requests. ProEngram stores the knowledge index, saved material, policies, and
              activity in a Nanogres-managed PostgreSQL database. GitHub remains the source for
              editable Markdown documents.
            </p>
            <p>
              Vercel hosts the dashboard and service endpoints. Perminister handles identity and
              access checks, and GitHub is used for repository sync and pull requests. When you
              connect through ChatGPT or Claude, your assistant sends a tool request to ProEngram
              and receives the result; those providers' own privacy practices apply to their
              processing of your conversation.
            </p>
            <p>
              Access to workspace information is controlled by organization permissions. A saved
              answer is shared with the company workspace, and a proposed repository edit is
              visible to people who can access the corresponding GitHub pull request.
            </p>
          </section>

          <section>
            <h2>Cookies and browser storage</h2>
            <p>
              The dashboard uses an HTTP-only session cookie to keep a signed-in session and
              browser local storage to remember your appearance preference. The service also
              receives ordinary connection details when your browser or assistant makes a request.
            </p>
          </section>

          <section>
            <h2>Retention and control</h2>
            <p>
              Indexed documents, saved answers, policy snapshots, and workspace activity are kept
              to provide the service and its history. ProEngram does not set a single fixed
              deletion period for all workspace records. Organization administrators manage the
              connected repository and workspace membership; contact the service operator for a
              request about information stored by ProEngram.
            </p>
          </section>

          <section>
            <h2>Requests and contact</h2>
            <p>
              For a privacy question or request, contact Zakai Hamilton using the contact
              information on the <a href="https://www.perminister.com/privacy">Perminister privacy
              page</a>. If your information comes from a company workspace, your organization
              administrator can also help direct the request.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              Updates will appear on this page with a revised date as the service or its data
              handling changes.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
