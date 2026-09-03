// Mastra-backed execution engine (PLAN.md Shape S3/S4, ADR-0003, ADR-0004):
// AgentSpec -> Mastra agent, guardrail/HITL blocking approval, BYOK model
// resolution (SLICES.md V2, KAN-1103 through KAN-1108), plus the mock/record
// tool layer and the Ollama local-model adapter (SLICES.md V3, KAN-1111/1112).

export const PACKAGE_NAME = "@kampong/engine";

export {
  createMastraModelClient,
  resolveEnvVarPlaceholder,
  MissingApiKeyError,
  UnknownModelProviderError,
  OllamaUnavailableError,
  DEFAULT_OLLAMA_BASE_URL,
  type ModelClient,
  type GenerateTextInput,
  type GenerateStructuredInput,
  type CreateMastraModelClientOptions,
} from "./model.js";

export {
  callHttpTool,
  toMastraTool,
  substitutePlaceholders,
  extractField,
  type HttpToolCallOptions,
  type ToolContext,
  type ToolFetchImpl,
} from "./http-tool.js";

export {
  createFixtureFetch,
  MissingFixtureError,
  type ToolFixtureMode,
  type CreateFixtureFetchOptions,
} from "./tool-fixtures.js";

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
