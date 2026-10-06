// Plain TypeScript type definitions mirroring @kampong/spec's Zod-inferred
// AgentSpec shape (packages/spec/src/schema.ts as of this export), vendored
// here rather than imported from "@kampong/spec" -- see this repo's
// docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. This
// project never re-validates a spec at runtime (it's a fixed, already-
// validated literal baked into src/index.ts at export time), so only the
// *shape* needs to travel with the export -- not the Zod schema/validator
// itself, which also isn't a package this project could resolve standalone
// (no @kampong/* dependency, per this export's zero-lock-in guarantee).

export type ModelProvider = "anthropic" | "openai" | "ollama" | "openrouter";

export interface Model {
  provider: ModelProvider;
  name: string;
  api_key?: string;
  base_url?: string;
  timeout_ms?: number;
}

export interface KnowledgeItem {
  type: "pdf" | "url" | "text";
  source: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// KAN-1845: the shared request description on `http_request` (mirrors packages/spec/src/request.ts).
export type RequestBody =
  | { json: Record<string, unknown> | unknown[] }
  | { form: Record<string, string> }
  | { raw: string; content_type?: string };

export type ResponseMode = "json" | "text" | "bytes";

// KAN-1846 (mirrors packages/spec/src/request.ts).
export interface FailureRule {
  path: string;
  exists?: boolean;
  equals?: string | number | boolean | null;
  matches?: string;
  message_path?: string;
  retryable?: boolean;
}

export interface Retry {
  max: number;
  backoff?: "fixed" | "exponential";
  base_ms?: number;
  max_delay_ms?: number;
}

// KAN-1832/1884 (mirrors packages/spec/src/component.ts): the component manifest, as the vendored
// interpreter reads it. An exported project receives its manifests already parsed and linted, baked
// into src/runtime/components.generated.ts, so only the shape travels, as with the spec itself.
export type OpEffect = "read" | "write" | "destructive";

export interface SchemaNode {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: (string | number | boolean)[];
  format?: "multiline";
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
}

export interface ComponentAuthSlot {
  env: string;
  hosts: string[];
  inject?: { header?: string; query?: string; template: string };
}

export interface ComponentConfigParam {
  type: "string";
  title?: string;
  description?: string;
  default?: string;
  pattern?: string;
}

interface ComponentHeader {
  id: string;
  version: string;
  title?: string;
  description?: string;
  license?: string;
  permissions?: { egress: string[] };
  auth?: { slots: Record<string, ComponentAuthSlot> };
  config?: Record<string, ComponentConfigParam>;
}

export interface RestOp {
  title?: string;
  description?: string;
  effect: OpEffect;
  input?: SchemaNode;
  request: {
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: RequestBody;
  };
  slots?: string[];
  response?: { mode: ResponseMode };
  failure_when?: FailureRule[];
  output?: SchemaNode;
  pace?: { rps: number };
  retry?: Retry;
  fixture_key?: string[];
}

export interface ModuleOp {
  title?: string;
  description?: string;
  effect: OpEffect;
  input?: SchemaNode;
  output?: SchemaNode;
}

export interface RestComponentManifest extends ComponentHeader {
  kind: "rest";
  ops: Record<string, RestOp>;
}

export interface ModuleComponentManifest extends ComponentHeader {
  kind: "module";
  entry: string;
  deps?: Record<string, string>;
  ops: Record<string, ModuleOp>;
}

export type ComponentManifest = RestComponentManifest | ModuleComponentManifest;

// KAN-1430: tools are a discriminated union on `action` -- the generic HTTP
// tool plus the Slack/Gmail connectors (credential is an ${ENV} token).
export type Tool =
  | {
      name: string;
      action: "http_request";
      method: HttpMethod;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: RequestBody;
      response?: { mode: ResponseMode };
      failure_when?: FailureRule[];
      pace?: { rps: number };
      retry?: Retry;
      requires_approval?: boolean;
      extract?: string;
    }
  | {
      name: string;
      action: "slack_post_message";
      token: string;
      channel: string;
      text: string;
      requires_approval?: boolean;
      extract?: string;
    }
  | {
      name: string;
      action: "gmail_send";
      token: string;
      to: string;
      subject: string;
      body: string;
      requires_approval?: boolean;
      extract?: string;
    }
  | {
      // KAN-1884: a component call. The exporter does not vendor the component interpreter yet, so an
      // export that uses one is refused; the shape is here so the vendored workflow type-checks.
      name: string;
      action: "component";
      use: string;
      op: string;
      with?: Record<string, unknown>;
      config?: Record<string, string>;
      secrets?: Record<string, string>;
      requires_approval?: boolean;
      extract?: string;
    };

export type FallbackAction = "escalate_to_human";

export interface Guardrails {
  confidence_threshold?: number;
  fallback_action?: FallbackAction;
}

export type WorkflowStep =
  | {
      step: string;
      type: "condition";
      if: string;
      then: string;
      else: string;
    }
  | {
      // KAN-1429: a tool step calls a named tool as a normal, always-run step.
      step: string;
      type: "tool";
      tool: string;
    }
  | {
      // KAN-1429: a first-class human-approval step.
      step: string;
      type: "approval";
      message?: string;
    }
  | {
      step: string;
      action: string;
      inputs?: string[];
      query?: string;
      confidence_gate?: boolean;
    };

// KAN-1431: how a workflow starts (webhook only today).
export interface Trigger {
  type: "webhook";
}

// KAN-1432: where a headless deployment sends the Approve/Reject Slack
// prompt (slack only today).
export interface ApprovalNotifier {
  type: "slack";
  token: string;
  channel: string;
}

export interface AgentSpec {
  version: string;
  agent: {
    id: string;
    name: string;
    role: string;
    goal: string;
    trigger?: Trigger;
    approval_notifier?: ApprovalNotifier;
    model?: Model;
    knowledge_base?: KnowledgeItem[];
    tools?: Tool[];
    guardrails?: Guardrails;
    workflow: WorkflowStep[];
  };
}
