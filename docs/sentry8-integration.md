# Sentry8 integration status

Sentry8's current MCP Gateway is the model-facing endpoint for its policy evaluation, approvals, and audit trail. It forwards approved calls to downstream MCP servers. Its client setup currently uses Sentry8 project or user connection keys.

ProEngram's direct MCP endpoint uses Perminister resource tokens. Connecting clients directly to ProEngram does not send those calls through Sentry8's Gateway. To make Sentry8 enforce every ProEngram tool call, ProEngram needs to run as a downstream MCP server and the gateway path must preserve the calling Perminister user's identity. Do not substitute a shared project key without an explicit identity and authorization design.

Sentry8's Custom Policy API is an evaluation callback from Sentry8 to a company-hosted endpoint. It can return a custom rule catalog and allow/review/deny decisions. It is not a general read API for downloading a project's active policy. ProEngram therefore treats the Sentry8 policy catalog as unconfigured until an approved Sentry8 export/API or a small identity-safe adapter is available.

The ProEngram `sentry8_policy` item type is ready to hold company-visible policy snapshots with a source revision. The MCP `get_policy` tool returns only imported snapshots and reports an empty catalog when none has been connected.
