"use client";

import { useState } from "react";
import { Badge, Card, DashboardShell, EmptyState, PageHeader, ThemeControl } from "panel-frame-ui";
import { PreviewDropdown, PreviewToolbar } from "ui-preview-kit";
import { BrandMark } from "./brand";

const screens = [
  { value: "overview", label: "Overview" },
  { value: "knowledge", label: "Knowledge" },
  { value: "saved", label: "Saved answers" },
  { value: "policies", label: "Policies" },
];
const scenarios = [
  { value: "populated", label: "Populated" },
  { value: "empty", label: "Empty" },
  { value: "setup", label: "Setup needed" },
  { value: "denied", label: "Permission denied" },
];
const sampleItems = [
  {
    title: "Customer data handling guide",
    kind: "GitHub Markdown",
    note: "Approved guidance for handling customer information and access requests.",
  },
  {
    title: "Quarterly onboarding checklist",
    kind: "GitHub Markdown",
    note: "The steps every new teammate completes in their first week.",
  },
  {
    title: "When to request a policy review",
    kind: "Sentry8 policy",
    note: "Route unclear or high-impact tool actions to an authorized reviewer.",
  },
];

export function PreviewGallery() {
  const [screen, setScreen] = useState("overview");
  const [scenario, setScenario] = useState("populated");
  const title = screens.find((item) => item.value === screen)?.label ?? "Overview";
  const connected = scenario === "populated" || scenario === "empty";
  const nav = (
    <nav aria-label="Preview navigation" className="pf-sidebar-group">
      <p className="pf-sidebar-group-label">COMPANY BRAIN</p>
      {screens.map((item) => (
        <button
          aria-pressed={screen === item.value}
          className="pf-sidebar-link"
          key={item.value}
          onClick={() => setScreen(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="preview-page">
      <PreviewToolbar
        subtitle="Synthetic data · local preview"
        note="Actions are simulated. This route does not use real accounts, databases, GitHub, or Sentry8."
        variant="card"
      >
        <div className="preview-controls">
          <PreviewDropdown label="Screen" value={screen} options={screens} onSelect={setScreen} />
          <PreviewDropdown
            label="Scenario"
            value={scenario}
            options={scenarios}
            onSelect={setScenario}
          />
          <ThemeControl label="Theme" />
        </div>
      </PreviewToolbar>
      <DashboardShell
        contentAsMain={false}
        brand={
          <span className="pf-brand proengram-brand">
            <BrandMark /> ProEngram
          </span>
        }
        sidebarContext={
          <div className="workspace-context">
            <span className="workspace-context-label">WORKSPACE</span>
            <span className="workspace-context-name">Northstar Labs</span>
          </div>
        }
        navigation={nav}
        toolbar={
          <div className="app-toolbar">
            <span className="toolbar-auth-status">
              <span className="status-dot" /> Preview user
            </span>
          </div>
        }
      >
        <main className="page-content preview-content" id="preview-screen">
          <div className="preview-state-note">Scenario: {scenario} · all values are synthetic</div>
          {scenario === "denied" ? (
            <EmptyState
              title="Access is not enabled"
              description="The signed-in member does not have permission to read this workspace."
            />
          ) : scenario === "setup" ? (
            <EmptyState
              title="Connect the shared library"
              description="The first-run view explains how the Nanogres database and GitHub source are connected."
            />
          ) : (
            <>
              <PageHeader
                eyebrow="COMPANY BRAIN"
                title={title}
                description="A shared space for approved knowledge, useful answers, and policy context."
                actions={
                  <button
                    className="pf-button pf-button-secondary"
                    onClick={() => setScenario(scenario === "empty" ? "populated" : "empty")}
                    type="button"
                  >
                    Simulated action
                  </button>
                }
              />
              {screen === "overview" ? (
                <>
                  <div className="metric-grid">
                    {[
                      { label: "GitHub documents", value: scenario === "empty" ? "0" : "24" },
                      { label: "Saved answers", value: scenario === "empty" ? "0" : "17" },
                      { label: "Sentry8 policies", value: scenario === "empty" ? "0" : "8" },
                    ].map((metric) => (
                      <Card className="metric-card" key={metric.label}>
                        <div className="metric-label">
                          {metric.label}
                          <Badge tone={connected ? "success" : "warning"}>
                            {connected ? "Connected" : "Setup needed"}
                          </Badge>
                        </div>
                        <strong className="metric-value">{metric.value}</strong>
                        <div className="metric-note">Synthetic preview value</div>
                      </Card>
                    ))}
                  </div>
                  {scenario === "empty" ? (
                    <EmptyState
                      title="Your library is ready for its first item"
                      description="Sync company Markdown or save a useful answer to begin."
                    />
                  ) : (
                    <PreviewItems />
                  )}
                </>
              ) : scenario === "empty" ? (
                <EmptyState
                  title={screen === "policies" ? "No policy snapshots" : "No shared items yet"}
                  description="The empty state keeps next steps visible without implying data is connected."
                />
              ) : (
                <PreviewItems />
              )}
            </>
          )}
        </main>
      </DashboardShell>
    </div>
  );
}

function PreviewItems() {
  return (
    <div className="item-list preview-panel">
      {sampleItems.map((item) => (
        <Card className="brain-item" key={item.title}>
          <div className="brain-item-meta">
            <Badge tone={item.kind === "Sentry8 policy" ? "accent" : "neutral"}>{item.kind}</Badge>
            <span>Updated yesterday</span>
          </div>
          <span className="brain-item-title">{item.title}</span>
          <p className="brain-item-excerpt">{item.note}</p>
        </Card>
      ))}
    </div>
  );
}
