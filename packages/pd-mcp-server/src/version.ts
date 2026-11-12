/**
 * Server identity — SPEC-PD-MCP-GATE4-001 §9.3 release manifest anchor.
 *
 * SERVER_VERSION mirrors the package version through the release
 * materialization step (`syncMcpServerVersionMirror` in
 * scripts/release/lib/version-plan.mjs); changesets alone rewrites only
 * package.json. A unit test pins it to package.json so the two cannot drift.
 */
export const SERVER_NAME = 'pd-mcp-server' as const;

export const SERVER_VERSION = '0.4.1' as const;

/** The only MCP SDK family/version this server is released against
 * (Gate 4-A freeze, PD_MCP_GATE4A_REALITY_CHECK §3). Exact pin — no ranges. */
export const MCP_SDK_PIN = '@modelcontextprotocol/server@2.4.0' as const;
