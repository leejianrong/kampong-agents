// The canvas talks to one of two servers over the same HTTP shapes:
//
//   - LOCAL: the Fastify server `kampong dev` starts (packages/cli, ADR-0005/
//     ADR-0007). One implicit spec, no auth, a file-watcher SSE stream.
//     `createApiClient(baseUrl)` (unchanged) speaks this.
//   - HOSTED: the multi-tenant server (packages/server, ADR-0013/ADR-0019).
//     Better Auth session cookies, many specs per workspace addressed by id,
//     workspace-scoped BYOK keys, durable server-side runs. `createHostedClient`
//     speaks the workspace/auth/BYOK surface and mints a per-spec `ApiClient`
//     (`specClient(id)`) that the same `App`/`RunPanel` drive unchanged.
//
// The two are kept behind one `ApiClient` interface (ADR-0020) so the editor
// UI never forks on mode. `main.tsx` probes which server it is at startup
// (`detectServerMode`) and renders the local `App` or the hosted shell.
//
// Run-related types are `import type`-only from @kampong/engine (SLICES.md
// V2 KAN-1107): the canvas never bundles @mastra/core or any engine runtime
// code -- it only calls the server's HTTP API -- so a type-only import,
// erased at build time, is the safe way to share these shapes without
// pulling a Node-only package into the browser bundle.
import type { PendingApproval, RunEvent, RunState } from "@kampong/engine";
import { blankSpecSource } from "@kampong/spec";
import type { ComponentCatalog, OpChanges, OpErrorCode, SpecOp, SpecSummary } from "@kampong/spec";

export interface SpecErrorDto {
  path: (string | number)[];
  message: string;
  line?: number;
  column?: number;
}

export interface LoadSpecResponse {
  success: boolean;
  /** KAM-196: there is no spec yet (a new workflow, not an error). `source` is "" and the file appears on first save. */
  missing?: boolean;
  spec?: Record<string, unknown>;
  errors: SpecErrorDto[];
  layout: Record<string, { x: number; y: number }>;
  source: string;
}

export type PatchOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "add"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] };

export interface ApplyPatchResponse {
  success: boolean;
  spec?: Record<string, unknown>;
  errors?: SpecErrorDto[];
}

/** A rejected operation (ADR-0055): the usual error plus which op, a code, and the reads that block it. */
export interface OpErrorDto extends SpecErrorDto {
  code?: OpErrorCode;
  opIndex?: number;
  references?: { path: (string | number)[]; kind: string; text: string; line?: number }[];
}

export interface ApplyOpsResponse {
  success: boolean;
  spec?: Record<string, unknown>;
  /** The spec's revision after the write, or (on a refusal) the current one. */
  revision?: string;
  changes?: OpChanges;
  errors?: OpErrorDto[];
  /** The `baseRevision` sent was out of date (HTTP 409); nothing was written. */
  stale?: boolean;
}

/**
 * Sends operations to the spec endpoint. A 422 (invalid) or 409 (stale) is an expected outcome the UI shows,
 * so it resolves with `success: false`; any other failure throws an `ApiError`.
 */
async function postOps(
  url: string,
  ops: SpecOp[],
  baseRevision: string | undefined,
): Promise<ApplyOpsResponse> {
  return putSpecChange(url, { ops, ...(baseRevision !== undefined && { baseRevision }) });
}

/** Sends a whole spec text to the import endpoint (KAM-207). Same answers as `postOps`. */
async function putSource(
  url: string,
  source: string,
  baseRevision: string | undefined,
): Promise<ApplyOpsResponse> {
  return putSpecChange(url, { source, ...(baseRevision !== undefined && { baseRevision }) });
}

async function putSpecChange(url: string, payload: object): Promise<ApplyOpsResponse> {
  const res = await fetch(url, jsonInit(payload, { method: "PUT" }));
  if (res.status === 422 || res.status === 409) {
    const body = (await res.json()) as ApplyOpsResponse;
    return { ...body, ...(res.status === 409 && { stale: true }) };
  }
  if (!res.ok) {
    throw new ApiError(
      await errorMessageFor(res, `Failed to save the change (HTTP ${res.status}).`),
      res.status,
    );
  }
  return (await res.json()) as ApplyOpsResponse;
}

/** `applyPatch`'s contract: a refused write throws, with the messages joined. */
async function patchViaOps(
  send: (ops: SpecOp[]) => Promise<ApplyOpsResponse>,
  ops: PatchOp[],
): Promise<ApplyPatchResponse> {
  const result = await send(ops);
  if (!result.success) {
    throw new ApiError(
      (result.errors ?? []).map((e) => e.message).join("; ") || "Failed to save the change.",
      result.stale ? 409 : 422,
    );
  }
  return result;
}

export interface StartRunResponse {
  success: boolean;
  id?: string;
  state?: RunState;
  /** The mode the server ran it in (KAM-188); absent from a server that has only live runs. */
  mode?: RunMode;
  errors?: SpecErrorDto[];
  error?: string;
}

/** How a test run reaches its tools and model: replay answers from recorded fixtures, live calls the real services (KAM-188). */
export type RunMode = "replay" | "live";

/** One tool a run would call, as `GET /api/run-options` describes it. */
export interface RunOptionsToolDto {
  name: string;
  describes: string;
  effect: "read" | "write" | "destructive" | "unknown";
  /** A live run could change something outside the project. */
  sideEffecting: boolean;
  requiresApproval: boolean;
  recorded: boolean;
}

/** One declared spec var a test run can set for a single run (KAM-191). */
export interface RunOptionsVarDto {
  name: string;
  type: "string" | "number" | "list";
  items?: "string" | "number";
  description?: string;
  /** The default as field text (a list comma-separated); absent when the var has none. */
  default?: string;
}

/** What the open spec can do on a test run: the modes open to it and what a live run would call. */
export interface RunOptionsResponse {
  success: boolean;
  error?: string;
  modes?: RunMode[];
  defaultMode?: RunMode;
  fixtures?: { available: boolean; dir?: string; count: number };
  tools?: RunOptionsToolDto[];
  /** The spec's declared vars; absent from a server that cannot say, which gets no var fields (hosted today). */
  vars?: RunOptionsVarDto[];
  modelCalls?: boolean;
}

export interface ApproveRunResponse {
  success: boolean;
  state?: RunState;
  error?: string;
}

export type RunEventMessage =
  { type: "state"; state: RunState } | { type: "event"; event: RunEvent; state: RunState };

export type { PendingApproval, RunEvent, RunState };
export type { ComponentCatalog, SpecSummary };

/** One line of `kampong doctor` output, as the local server returns it (KAN-1901). */
export interface DoctorCheckDto {
  status: "pass" | "warn" | "fail";
  area: "spec" | "component" | "env" | "fixtures" | "network";
  message: string;
}

/** One variable the Secrets panel shows: a name and where it comes from, never a value. */
export interface SecretStatusDto {
  name: string;
  source: "saved" | "environment" | "unset";
  /** The open spec reads it through `${NAME}`. */
  referenced: boolean;
}

export interface PinComponentResponse {
  success: boolean;
  catalog?: ComponentCatalog;
  error?: string;
}

/**
 * The editor surface both server modes implement. `App`/`RunPanel` depend on
 * exactly this and nothing mode-specific -- the local client and each hosted
 * per-spec client both satisfy it, which is what keeps the editor from
 * forking on mode (ADR-0020).
 */
/** One template the gallery offers (KAM-216): what `GET /api/templates` returns. */
export interface TemplateSummary {
  name: string;
  title: string;
  description: string;
  /** The kinds of step it uses, for the chips. */
  stepKinds: string[];
  /** Ships recorded data, so it runs with no key. */
  runsOffline: boolean;
}

export interface ApiClient {
  loadSpec(): Promise<LoadSpecResponse>;
  applyPatch(ops: PatchOp[]): Promise<ApplyPatchResponse>;
  /**
   * Applies raw patch ops and step/tool operations in one request (ADR-0055). Resolves with
   * `success: false` and `errors` (with a `code`, and `references` for a blocked delete or move) when the
   * request is refused; throws only for transport and server errors. `baseRevision` makes the write
   * conditional on the spec not having changed (`stale: true` otherwise).
   */
  applyOps(ops: SpecOp[], options?: { baseRevision?: string }): Promise<ApplyOpsResponse>;
  /**
   * Import (ADR-0054, KAM-207): replaces the whole spec with this YAML text if it validates. A refusal
   * resolves with `success: false` and the errors, with line numbers, and nothing is written. Export is the
   * `source` that `loadSpec` already returns.
   */
  replaceSource(source: string, options?: { baseRevision?: string }): Promise<ApplyOpsResponse>;
  /**
   * "Start blank" from the empty state (KAM-196): writes the minimal valid spec. Refused (`success: false`)
   * if the spec already has content. Local mode creates the file; hosted writes the same text through
   * `replaceSource`.
   */
  startBlank(): Promise<ApplyOpsResponse>;
  /**
   * The ready-made templates the template gallery offers (KAM-216). Only the local server has them (the
   * hosted server has no template route yet), so the hosted client omits this and the gallery is hidden.
   */
  listTemplates?(): Promise<TemplateSummary[]>;
  /**
   * Saves a template as this workflow, with its recorded fixtures so it runs in replay with no key. Refused
   * (`success: false`) when the workflow already has content, unless `replace` is set. Local server only.
   */
  startFromTemplate?(name: string, options?: { replace?: boolean }): Promise<ApplyOpsResponse>;
  /**
   * Subscribes to out-of-band spec-change events. Only the local server has a
   * file watcher (ADR-0008); the hosted client returns a no-op unsubscribe,
   * so App's auto-reload/conflict paths simply never fire in hosted mode.
   */
  subscribeToEvents(onEvent: (event: { type: string; source: string }) => void): () => void;
  /**
   * The components installed beside the spec, for generated tool forms (KAN-1885). Only the local
   * server has them; the hosted client omits this and the form hides the Component kind.
   */
  listComponents?(): Promise<ComponentCatalog>;
  /**
   * Pins one installed component, as `kampong lock` does (KAN-1901). A re-pin that widens what the
   * component may do is refused unless `allowWiderPermissions` is set. Local server only.
   */
  pinComponent?(
    use: string,
    options?: { allowWiderPermissions?: boolean; expectedDigest?: string },
  ): Promise<PinComponentResponse>;
  /**
   * `kampong doctor`: offline by default; `online` dials each host and `probe` sends each credential to the
   * service it belongs to, so a caller asks for those explicitly. Local server only.
   */
  runDoctor?(options?: { online?: boolean; probe?: boolean }): Promise<DoctorCheckDto[]>;
  /**
   * Secrets: set a credential by name; runs and checks use it at once. Write-only: no call returns a
   * value, only each name and whether it is set. Local server only.
   */
  listSecrets?(): Promise<SecretStatusDto[]>;
  setSecret?(name: string, value: string): Promise<SecretStatusDto[]>;
  removeSecret?(name: string): Promise<SecretStatusDto[]>;
  /**
   * The modes a test run can use and, for a live run, the tools it would call (KAM-188). Only the local
   * server can replay recorded fixtures; the hosted client omits this, so the panel shows no mode switch.
   */
  getRunOptions?(): Promise<RunOptionsResponse>;
  /** `vars` are values for the spec's `vars` for this run only (KAM-191); the local server applies them, hosted ignores them. */
  startRun(input: string, mode?: RunMode, vars?: Record<string, string>): Promise<StartRunResponse>;
  approveRun(id: string, approved: boolean, reason?: string): Promise<ApproveRunResponse>;
  subscribeToRunEvents(id: string, onMessage: (message: RunEventMessage) => void): () => void;
}

// KAN-1216: a non-2xx spec response (e.g. the 404 the server returns for a
// spec file deleted out from under a running `kampong dev`, or the 401/404
// the hosted server returns) used to get parsed and cast to the success-
// shaped DTO anyway -- `success` came back `undefined` (not `false`), so
// callers that only checked `.success`/`.errors` treated it as "nothing to
// report" and silently no-op'd. `loadSpec`/`applyPatch` now check `res.ok`
// first and throw this, so callers (App, the hosted shell's 401 gate) can
// catch it and act.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorMessageFor(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; errors?: { message: string }[] };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.map((e) => e.message).join("; ");
    }
  } catch {
    // Body wasn't JSON (or was empty) -- fall through to the generic message.
  }
  return fallback;
}

// Every request carries the session cookie. Harmless for the local server
// (which has no auth); required for the hosted server, whose Better Auth
// session lives in an httpOnly cookie the browser only attaches when asked.
function withCredentials(init: RequestInit = {}): RequestInit {
  return { credentials: "include", ...init };
}

async function secretsFrom(res: Response, fallback: string): Promise<SecretStatusDto[]> {
  if (!res.ok) {
    throw new ApiError(await errorMessageFor(res, `${fallback} (HTTP ${res.status}).`), res.status);
  }
  return ((await res.json()) as { secrets: SecretStatusDto[] }).secrets;
}

function jsonInit(body: unknown, init: RequestInit = {}): RequestInit {
  return withCredentials({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

/**
 * The local `kampong dev` client: one implicit spec at `/api/spec`, a
 * file-watcher SSE stream at `/api/events`, and the single-process run
 * endpoints. Behavior is unchanged from before ADR-0020's hosted split.
 */
export function createApiClient(baseUrl = ""): ApiClient {
  return {
    async loadSpec(): Promise<LoadSpecResponse> {
      const res = await fetch(`${baseUrl}/api/spec`, withCredentials());
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to load the spec (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as LoadSpecResponse;
    },

    async applyPatch(ops: PatchOp[]): Promise<ApplyPatchResponse> {
      return patchViaOps((o) => this.applyOps(o), ops);
    },

    async applyOps(ops, options): Promise<ApplyOpsResponse> {
      return postOps(`${baseUrl}/api/spec`, ops, options?.baseRevision);
    },

    async replaceSource(source, options): Promise<ApplyOpsResponse> {
      return putSource(`${baseUrl}/api/spec/source`, source, options?.baseRevision);
    },

    async startBlank(): Promise<ApplyOpsResponse> {
      const res = await fetch(`${baseUrl}/api/spec/blank`, jsonInit({}));
      if (res.ok || res.status === 409 || res.status === 422) {
        const body = (await res.json()) as ApplyOpsResponse & { error?: string };
        return body.success || body.errors
          ? body
          : { ...body, errors: [{ path: [], message: body.error ?? "Could not start blank." }] };
      }
      throw new ApiError(
        await errorMessageFor(res, `Failed to start a blank workflow (HTTP ${res.status}).`),
        res.status,
      );
    },

    async listTemplates(): Promise<TemplateSummary[]> {
      const res = await fetch(`${baseUrl}/api/templates`, withCredentials());
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to list templates (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as TemplateSummary[];
    },

    async startFromTemplate(name, options): Promise<ApplyOpsResponse> {
      const res = await fetch(
        `${baseUrl}/api/spec/template`,
        jsonInit({ name, ...(options?.replace && { replace: true }) }),
      );
      if (res.ok || res.status === 409 || res.status === 422 || res.status === 404) {
        const body = (await res.json()) as ApplyOpsResponse & { error?: string };
        return body.success || body.errors
          ? body
          : {
              ...body,
              errors: [{ path: [], message: body.error ?? "Could not use the template." }],
            };
      }
      throw new ApiError(
        await errorMessageFor(res, `Failed to start from the template (HTTP ${res.status}).`),
        res.status,
      );
    },

    async listComponents(): Promise<ComponentCatalog> {
      const res = await fetch(`${baseUrl}/api/components`, withCredentials());
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to list components (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as ComponentCatalog;
    },

    async pinComponent(use, options = {}): Promise<PinComponentResponse> {
      const res = await fetch(
        `${baseUrl}/api/components/pin`,
        jsonInit({
          use,
          allowWiderPermissions: options.allowWiderPermissions === true,
          ...(options.expectedDigest !== undefined && { expectedDigest: options.expectedDigest }),
        }),
      );
      // A refusal (the update widens permissions, the component is missing) is an answer with a message,
      // not a failure of the request, so the form can show it.
      return (await res.json()) as PinComponentResponse;
    },

    async runDoctor(options = {}): Promise<DoctorCheckDto[]> {
      const res = await fetch(`${baseUrl}/api/doctor`, jsonInit(options));
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Could not run the checks (HTTP ${res.status}).`),
          res.status,
        );
      }
      return ((await res.json()) as { checks: DoctorCheckDto[] }).checks;
    },

    async listSecrets(): Promise<SecretStatusDto[]> {
      const res = await fetch(`${baseUrl}/api/secrets`, withCredentials());
      return secretsFrom(res, "Could not load the variables");
    },

    async setSecret(name, value): Promise<SecretStatusDto[]> {
      const res = await fetch(
        `${baseUrl}/api/secrets/${encodeURIComponent(name)}`,
        jsonInit({ value }, { method: "PUT" }),
      );
      return secretsFrom(res, "Could not save the variable");
    },

    async removeSecret(name): Promise<SecretStatusDto[]> {
      const res = await fetch(
        `${baseUrl}/api/secrets/${encodeURIComponent(name)}`,
        withCredentials({ method: "DELETE" }),
      );
      return secretsFrom(res, "Could not remove the variable");
    },

    subscribeToEvents(onEvent: (event: { type: string; source: string }) => void): () => void {
      const source = new EventSource(`${baseUrl}/api/events`);
      source.onmessage = (message) => {
        onEvent(JSON.parse(message.data));
      };
      return () => source.close();
    },

    async getRunOptions(): Promise<RunOptionsResponse> {
      const res = await fetch(`${baseUrl}/api/run-options`);
      return (await res.json()) as RunOptionsResponse;
    },

    async startRun(
      input: string,
      mode?: RunMode,
      vars?: Record<string, string>,
    ): Promise<StartRunResponse> {
      const res = await fetch(
        `${baseUrl}/api/runs`,
        jsonInit({ input, ...(mode && { mode }), ...(vars && { vars }) }),
      );
      return (await res.json()) as StartRunResponse;
    },

    async approveRun(id: string, approved: boolean, reason?: string): Promise<ApproveRunResponse> {
      const res = await fetch(`${baseUrl}/api/runs/${id}/approve`, jsonInit({ approved, reason }));
      return (await res.json()) as ApproveRunResponse;
    },

    subscribeToRunEvents(id: string, onMessage: (message: RunEventMessage) => void): () => void {
      const source = new EventSource(`${baseUrl}/api/runs/${id}/events`);
      source.onmessage = (message) => {
        onMessage(JSON.parse(message.data));
      };
      return () => source.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Hosted client (packages/server) -- auth, workspace, spec list, BYOK, and a
// per-spec `ApiClient` factory. ADR-0019 (routes), ADR-0016 (BYOK), ADR-0020
// (this seam + the spec-list landing view).
// ---------------------------------------------------------------------------

export interface SessionInfo {
  user: { id: string; email: string; name: string };
  session: { activeOrganizationId: string | null };
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export interface ByokKeyInfo {
  provider: string;
  lastFour: string;
  updatedAt: string;
}

/**
 * Probes which server is answering at `baseUrl`. The hosted server mounts
 * Better Auth at `/api/auth/*` (so `GET /api/auth/get-session` answers 200,
 * body `null` when signed out); the local `kampong dev` server has no such
 * route and 404s. Any network failure is treated as local -- the safe
 * default that keeps `kampong dev` working with no hosted infrastructure.
 */
export async function detectServerMode(baseUrl = ""): Promise<"local" | "hosted"> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/get-session`, withCredentials());
    return res.ok ? "hosted" : "local";
  } catch {
    return "local";
  }
}

// Better Auth error bodies are `{ message?, code? }`; surface the message.
async function authError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    const message = body.message ?? body.error;
    if (typeof message === "string" && message.length > 0) return new ApiError(message, res.status);
  } catch {
    // Non-JSON body -- fall through.
  }
  return new ApiError(fallback, res.status);
}

// A slug Better Auth's organization/create accepts (`z.string().min(1)`),
// derived from the workspace name so the user never has to supply one. A
// random suffix keeps two same-named workspaces from colliding on the unique
// slug (the create endpoint rejects a duplicate).
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `workspace-${suffix}`;
}

/** A minimal, schema-valid starter spec for "new spec" in hosted mode. */
export function starterSpec(name: string): string {
  const id = slugify(name).replace(/-/g, "_") || "new_agent";
  return `# yaml-language-server: $schema=../packages/spec/schemas/agent-spec.v1.0.schema.json
version: "1.0"
agent:
  id: ${id}
  name: "${name}"
  role: "Helpful assistant"
  goal: "Answer the user's question concisely and helpfully."
  # The provider must match a BYOK key you have added for this workspace
  # (Manage keys). The stored key is substituted at run time; the
  # \${...} placeholder below is only to satisfy validation.
  model:
    provider: openrouter
    name: liquid/lfm-2.5-2.6b:free
    api_key: \${OPENROUTER_API_KEY}
  workflow:
    - step: answer
      action: generate_text
      inputs: [input]
`;
}

export interface HostedClient {
  getSession(): Promise<SessionInfo | null>;
  signUp(input: { name: string; email: string; password: string }): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  /** Redirects the browser to GitHub's OAuth consent screen. */
  signInWithGithub(callbackURL: string): Promise<void>;
  signOut(): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<Workspace>;
  setActiveWorkspace(id: string): Promise<void>;
  listSpecs(): Promise<SpecSummary[]>;
  createSpec(name: string, source: string): Promise<{ id: string; name: string }>;
  listByokKeys(): Promise<ByokKeyInfo[]>;
  putByokKey(provider: string, key: string): Promise<void>;
  deleteByokKey(provider: string): Promise<void>;
  /** An `ApiClient` bound to one of this workspace's specs. */
  specClient(specId: string): ApiClient;
}

export function createHostedClient(baseUrl = ""): HostedClient {
  const auth = (path: string) => `${baseUrl}/api/auth${path}`;

  return {
    async getSession(): Promise<SessionInfo | null> {
      const res = await fetch(auth("/get-session"), withCredentials());
      if (!res.ok) return null;
      const body = (await res.json()) as SessionInfo | null;
      return body && body.user ? body : null;
    },

    async signUp(input): Promise<void> {
      const res = await fetch(auth("/sign-up/email"), jsonInit(input));
      if (!res.ok) throw await authError(res, "Sign-up failed.");
    },

    async signIn(input): Promise<void> {
      const res = await fetch(auth("/sign-in/email"), jsonInit(input));
      if (!res.ok) throw await authError(res, "Invalid email or password.");
    },

    async signInWithGithub(callbackURL): Promise<void> {
      const res = await fetch(
        auth("/sign-in/social"),
        jsonInit({ provider: "github", callbackURL }),
      );
      if (!res.ok) throw await authError(res, "GitHub sign-in is unavailable.");
      const body = (await res.json()) as { url?: string };
      if (body.url) window.location.href = body.url;
    },

    async signOut(): Promise<void> {
      const res = await fetch(auth("/sign-out"), jsonInit({}));
      if (!res.ok) throw await authError(res, "Sign-out failed.");
    },

    async listWorkspaces(): Promise<Workspace[]> {
      const res = await fetch(auth("/organization/list"), withCredentials());
      if (!res.ok) throw await authError(res, "Failed to load workspaces.");
      return (await res.json()) as Workspace[];
    },

    async createWorkspace(name): Promise<Workspace> {
      const res = await fetch(
        auth("/organization/create"),
        jsonInit({ name, slug: slugify(name) }),
      );
      if (!res.ok) throw await authError(res, "Failed to create the workspace.");
      return (await res.json()) as Workspace;
    },

    async setActiveWorkspace(id): Promise<void> {
      const res = await fetch(auth("/organization/set-active"), jsonInit({ organizationId: id }));
      if (!res.ok) throw await authError(res, "Failed to switch workspace.");
    },

    async listSpecs(): Promise<SpecSummary[]> {
      const res = await fetch(`${baseUrl}/api/specs`, withCredentials());
      if (!res.ok) {
        throw new ApiError(await errorMessageFor(res, "Failed to load specs."), res.status);
      }
      const body = (await res.json()) as { specs: SpecSummary[] };
      return body.specs;
    },

    async createSpec(name, source): Promise<{ id: string; name: string }> {
      const res = await fetch(`${baseUrl}/api/specs`, jsonInit({ name, source }));
      if (!res.ok) {
        throw new ApiError(await errorMessageFor(res, "Failed to create the spec."), res.status);
      }
      const body = (await res.json()) as { id: string; name: string };
      return body;
    },

    async listByokKeys(): Promise<ByokKeyInfo[]> {
      const res = await fetch(`${baseUrl}/api/byok`, withCredentials());
      if (!res.ok) {
        throw new ApiError(await errorMessageFor(res, "Failed to load keys."), res.status);
      }
      const body = (await res.json()) as { keys: ByokKeyInfo[] };
      return body.keys;
    },

    async putByokKey(provider, key): Promise<void> {
      const res = await fetch(
        `${baseUrl}/api/byok/${provider}`,
        jsonInit({ key }, { method: "PUT" }),
      );
      if (!res.ok) {
        throw new ApiError(await errorMessageFor(res, "Failed to save the key."), res.status);
      }
    },

    async deleteByokKey(provider): Promise<void> {
      const res = await fetch(
        `${baseUrl}/api/byok/${provider}`,
        withCredentials({ method: "DELETE" }),
      );
      if (!res.ok) {
        throw new ApiError(await errorMessageFor(res, "Failed to delete the key."), res.status);
      }
    },

    specClient(specId): ApiClient {
      return createHostedSpecClient(baseUrl, specId);
    },
  };
}

/**
 * Wraps a `HostedClient` so any request that comes back 401 (an expired or
 * revoked session) triggers `onUnauthorized` before the error propagates --
 * the single place the hosted shell turns "session gone" into "show the login
 * screen again" (KAN-1228's 401 → login gate), covering both the control-plane
 * methods and every per-spec `ApiClient` it hands out. `getSession` and the
 * sign-in/out methods are passed through unwrapped: `getSession` returns
 * `null` (never throws) when signed out, and the auth methods are how you get
 * a session in the first place.
 */
export function guardUnauthorized(client: HostedClient, onUnauthorized: () => void): HostedClient {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        throw err;
      }
    };
  const wrapSpecClient = (c: ApiClient): ApiClient => ({
    loadSpec: wrap(c.loadSpec.bind(c)),
    applyPatch: wrap(c.applyPatch.bind(c)),
    applyOps: wrap(c.applyOps.bind(c)),
    replaceSource: wrap(c.replaceSource.bind(c)),
    startBlank: wrap(c.startBlank.bind(c)),
    subscribeToEvents: c.subscribeToEvents.bind(c),
    startRun: c.startRun.bind(c),
    approveRun: c.approveRun.bind(c),
    subscribeToRunEvents: c.subscribeToRunEvents.bind(c),
  });
  return {
    getSession: client.getSession.bind(client),
    signUp: client.signUp.bind(client),
    signIn: client.signIn.bind(client),
    signInWithGithub: client.signInWithGithub.bind(client),
    signOut: client.signOut.bind(client),
    listWorkspaces: wrap(client.listWorkspaces.bind(client)),
    createWorkspace: wrap(client.createWorkspace.bind(client)),
    setActiveWorkspace: wrap(client.setActiveWorkspace.bind(client)),
    listSpecs: wrap(client.listSpecs.bind(client)),
    createSpec: wrap(client.createSpec.bind(client)),
    listByokKeys: wrap(client.listByokKeys.bind(client)),
    putByokKey: wrap(client.putByokKey.bind(client)),
    deleteByokKey: wrap(client.deleteByokKey.bind(client)),
    specClient: (id: string) => wrapSpecClient(client.specClient(id)),
  };
}

/**
 * An `ApiClient` bound to one hosted spec. Same shapes as the local client,
 * but addressed by id (`/api/specs/:id`), with runs started under that spec
 * (`/api/specs/:id/runs`) and no file-watcher stream (hosted specs live in
 * Postgres, not on disk -- `subscribeToEvents` is a no-op).
 */
export function createHostedSpecClient(baseUrl: string, specId: string): ApiClient {
  return {
    async loadSpec(): Promise<LoadSpecResponse> {
      const res = await fetch(`${baseUrl}/api/specs/${specId}`, withCredentials());
      if (!res.ok) {
        throw new ApiError(
          await errorMessageFor(res, `Failed to load the spec (HTTP ${res.status}).`),
          res.status,
        );
      }
      return (await res.json()) as LoadSpecResponse;
    },

    async applyPatch(ops: PatchOp[]): Promise<ApplyPatchResponse> {
      return patchViaOps((o) => this.applyOps(o), ops);
    },

    async applyOps(ops, options): Promise<ApplyOpsResponse> {
      return postOps(`${baseUrl}/api/specs/${specId}`, ops, options?.baseRevision);
    },

    async replaceSource(source, options): Promise<ApplyOpsResponse> {
      return putSource(`${baseUrl}/api/specs/${specId}/source`, source, options?.baseRevision);
    },

    async startBlank(): Promise<ApplyOpsResponse> {
      return this.replaceSource(blankSpecSource());
    },

    subscribeToEvents(): () => void {
      // Hosted specs have no file watcher -- nothing to subscribe to.
      return () => {};
    },

    async startRun(input: string): Promise<StartRunResponse> {
      const res = await fetch(`${baseUrl}/api/specs/${specId}/runs`, jsonInit({ input }));
      return (await res.json()) as StartRunResponse;
    },

    async approveRun(id: string, approved: boolean, reason?: string): Promise<ApproveRunResponse> {
      const res = await fetch(`${baseUrl}/api/runs/${id}/approve`, jsonInit({ approved, reason }));
      return (await res.json()) as ApproveRunResponse;
    },

    subscribeToRunEvents(id: string, onMessage: (message: RunEventMessage) => void): () => void {
      const source = new EventSource(`${baseUrl}/api/runs/${id}/events`, { withCredentials: true });
      source.onmessage = (message) => {
        onMessage(JSON.parse(message.data));
      };
      return () => source.close();
    },
  };
}
