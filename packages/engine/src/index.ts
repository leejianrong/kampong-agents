// Mastra-backed execution engine (PLAN.md Shape S3/S4, ADR-0003, ADR-0004):
// AgentSpec -> Mastra agent, guardrail/HITL blocking approval, BYOK model
// resolution. SLICES.md V2 (KAN-1103 through KAN-1108) scope: mock/record
// tool-response replay and the Ollama adapter are SLICES.md V3
// (KAN-1109-1111), out of scope here.

export const PACKAGE_NAME = "@kampong/engine";

export {
  createMastraModelClient,
  resolveEnvVarPlaceholder,
  MissingApiKeyError,
  UnknownModelProviderError,
  type ModelClient,
  type GenerateTextInput,
  type GenerateStructuredInput,
} from "./model.js";

export {
  callHttpTool,
  toMastraTool,
  substitutePlaceholders,
  extractField,
  type HttpToolCallOptions,
} from "./http-tool.js";

export { evaluateCondition } from "./condition.js";

export { isBelowConfidenceThreshold } from "./guardrail.js";

export { runWorkflow, type RunEvent, type ApprovalDecision, type EngineDeps } from "./workflow.js";

export {
  AgentRun,
  createAgentRun,
  type RunStatus,
  type RunState,
  type PendingApproval,
  type StepRecord,
  type CreateAgentRunOptions,
} from "./run.js";
