"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DashboardShell, ThemeControl } from "panel-frame-ui";
import type { ReactNode } from "react";
import { selectOrganizationAction } from "@/app/(dashboard)/organization-actions";
import { BrandMark } from "./brand";

const links = [
  {
    href: "/overview",
    label: "Overview",
    icon: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  },
  {
    href: "/knowledge",
    label: "Knowledge",
    icon: "M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5zM5 4.5v17M9 6h7M9 10h7",
  },
  { href: "/saved", label: "Saved answers", icon: "M6 3h12v18l-6-4-6 4z" },
  {
    href: "/policies",
    label: "Policies",
    icon: "M12 3 20 6v6c0 5-3.5 8-8 11-4.5-3-8-6-8-11V6l8-3zM8.5 12l2.2 2.2 4.8-5",
  },
  { href: "/activity", label: "Activity", icon: "M4 17v-4M10 17V7M16 17v-7M22 17V4" },
  {
    href: "/feedback",
    label: "Feedback",
    icon: "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-5A7.5 7.5 0 1 1 20 11.5zM8 11h8M8 14h5",
    managerOnly: true,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM19.4 13.5a7.8 7.8 0 0 0 0-3l1.8-1.4-1.8-3.1-2.2.8a7.6 7.6 0 0 0-2.6-1.5L14.2 3h-3.6l-.4 2.3a7.6 7.6 0 0 0-2.6 1.5l-2.2-.8-1.8 3.1 1.8 1.4a7.8 7.8 0 0 0 0 3l-1.8 1.4 1.8 3.1 2.2-.8a7.6 7.6 0 0 0 2.6 1.5l.4 2.3h3.6l.4-2.3a7.6 7.6 0 0 0 2.6-1.5l2.2.8 1.8-3.1z",
  },
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
      <path
        d={path}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function AppShell({
  children,
  userName,
  email,
  organizationId,
  organizations,
  canReviewFeedback,
}: {
  children: ReactNode;
  userName: string;
  email: string | null;
  organizationId: string;
  organizations: Array<{ organizationId: string; name: string }>;
  canReviewFeedback: boolean;
}) {
  const pathname = usePathname();
  return (
    <DashboardShell
      contentAsMain={false}
      brand={
        <Link aria-label="ProEngram overview" className="pf-brand proengram-brand" href="/overview">
          <BrandMark />
          <span>ProEngram</span>
        </Link>
      }
      sidebarContext={
        <div className="workspace-context">
          <form action={selectOrganizationAction} className="workspace-context-form">
            <label className="workspace-context-label" htmlFor="organization-switcher">
              ORGANIZATION
            </label>
            <select
              aria-label="Choose an organization"
              className="workspace-context-select"
              defaultValue={organizationId}
              id="organization-switcher"
              name="organizationId"
              onChange={(event) => event.currentTarget.form?.requestSubmit()}
            >
              {organizations.map((organization) => (
                <option key={organization.organizationId} value={organization.organizationId}>
                  {organization.name}
                </option>
              ))}
            </select>
            {organizations.length > 1 ? (
              <button className="workspace-context-submit" type="submit">
                Switch organization
              </button>
            ) : null}
          </form>
        </div>
      }
      navigation={
        <nav aria-label="Main navigation" className="pf-sidebar-group">
          <p className="pf-sidebar-group-label">COMPANY BRAIN</p>
          {links
            .filter((link) => !link.managerOnly || canReviewFeedback)
            .map((link) => {
              const active =
                link.href === "/overview" ? pathname === link.href : pathname.startsWith(link.href);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className="pf-sidebar-link"
                  href={link.href}
                  key={link.href}
                >
                  <NavIcon path={link.icon} />
                  <span>{link.label}</span>
                </Link>
              );
            })}
        </nav>
      }
      sidebarFooter={
        <div className="sidebar-footnote">
          <span className="sidebar-footnote-dot" />
          <span>Shared knowledge space</span>
        </div>
      }
      toolbar={
        <div className="app-toolbar">
          <span className="toolbar-auth-status">
            <span className="status-dot" /> Perminister
          </span>
          <ThemeControl label="Appearance" />
          <div className="toolbar-user">
            <span className="user-avatar">{userName.slice(0, 1).toUpperCase()}</span>
            <span className="toolbar-user-copy">
              <strong>{userName}</strong>
              <small>{email || "Company member"}</small>
            </span>
          </div>
          <form action="/auth/logout" method="post">
            <button className="toolbar-signout" type="submit">
              Sign out
            </button>
          </form>
        </div>
      }
    >
      {children}
    </DashboardShell>
  );
}
