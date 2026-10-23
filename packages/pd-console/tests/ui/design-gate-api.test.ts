import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesignGateDeclaration,
  fetchDesignGateDeclaration,
  fetchDesignGateSessions,
  revokeDesignGateDeclaration,
  updateDesignGateDecision,
} from "../../src/ui/api.js";

const declaration = {
  sourceRef: "decl-1",
  governanceWorkspacePath: "D:/governance",
  projectWorkspacePath: "D:/project",
  hostSessionId: "codex-session-1",
  taskRef: "codex:codex-session-1",
  specPath: "docs/design.md",
  specDigest: "sha256:abc",
  scope: { paths: ["src/example.ts"], actions: ["write", "execute"] },
  decision: "not_approved",
  revision: 1,
  revoked: false,
  actor: { ownerId: "owner-1", credentialId: "credential-1" },
  decidedAt: "2026-10-22T00:00:00.000Z",
};

function respond(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
}

describe("local Codex design-gate API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates observed sessions and rejects malformed session rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ sessions: [{ projectWorkspacePath: "D:/project", hostSessionId: "session-1" }] })));
    const result = await fetchDesignGateSessions();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sessions).toEqual([{ projectWorkspacePath: "D:/project", hostSessionId: "session-1" }]);

    vi.mocked(fetch).mockResolvedValue(respond({ sessions: [{ projectWorkspacePath: "D:/project", hostSessionId: 4 }] }));
    const malformed = await fetchDesignGateSessions();
    expect(malformed.success).toBe(false);
  });

  it("encodes the selected native session and accepts an explicitly absent declaration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ declaration: null })));
    const result = await fetchDesignGateDeclaration("D:/project with spaces", "session/?#1");
    expect(result).toEqual({ success: true, data: { declaration: null } });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/v1/governance/design-gate/declaration?projectWorkspacePath=D%3A%2Fproject+with+spaces&hostSessionId=session%2F%3F%231");
  });

  it("validates the declaration contract field-by-field and refuses malformed returned declarations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ declaration })));
    const valid = await fetchDesignGateDeclaration("D:/project", "codex-session-1");
    expect(valid.success).toBe(true);

    vi.mocked(fetch).mockResolvedValue(respond({ declaration: { ...declaration, actor: { ownerId: "owner-1" } } }));
    const malformed = await fetchDesignGateDeclaration("D:/project", "codex-session-1");
    expect(malformed.success).toBe(false);
  });

  it("posts only Owner declaration fields and revision-bound decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ declaration })));
    const createInput = {
      projectWorkspacePath: "D:/project",
      hostSessionId: "codex-session-1",
      specPath: "docs/design.md",
      scope: { paths: ["src/example.ts"], actions: ["write", "execute"] as ("write" | "execute")[] },
      decision: "not_approved" as const,
    };
    await createDesignGateDeclaration(createInput);
    const createCall = vi.mocked(fetch).mock.calls[0];
    expect(createCall?.[0]).toBe("/api/v1/governance/design-gate/declarations");
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(createInput);
    expect(JSON.parse(String(createCall?.[1]?.body))).not.toHaveProperty("ownerId");
    expect(JSON.parse(String(createCall?.[1]?.body))).not.toHaveProperty("sourceRef");

    await updateDesignGateDecision("decl/1", 3, "approved");
    const decisionCall = vi.mocked(fetch).mock.calls[1];
    expect(decisionCall?.[0]).toBe("/api/v1/governance/design-gate/declarations/decl%2F1/decision");
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({ expectedRevision: 3, decision: "approved" });

    await revokeDesignGateDeclaration("decl-1", 4);
    const revokeCall = vi.mocked(fetch).mock.calls[2];
    expect(revokeCall?.[0]).toBe("/api/v1/governance/design-gate/declarations/decl-1/revoke");
    expect(JSON.parse(String(revokeCall?.[1]?.body))).toEqual({ expectedRevision: 4 });
  });
});
