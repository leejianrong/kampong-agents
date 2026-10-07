// Mastra-backed execution engine (PLAN.md Shape S3/S4, ADR-0003, ADR-0004):
// AgentSpec -> Mastra agent, guardrail/HITL blocking approval, BYOK model
// resolution (SLICES.md V2, KAN-1103 through KAN-1108), plus the mock/record
// tool layer and the Ollama local-model adapter (SLICES.md V3, KAN-1111/1112).

export const PACKAGE_NAME = "@kampong/engine";

export {
  createMastraModelClient,
  providerRequiresApiKey,
  resolveEnvVarPlaceholder,
  MissingApiKeyError,
  UnknownModelProviderError,
  OllamaUnavailableError,
  DEFAULT_OLLAMA_BASE_URL,
  ModelCallTimeoutError,
  DEFAULT_MODEL_TIMEOUT_MS,
  type ModelClient,
  type GenerateTextInput,
  type GenerateStructuredInput,
  type CreateMastraModelClientOptions,
} from "./model.js";

export {
  callHttpTool,
  toMastraTool,
  substitutePlaceholders,
  resolveEnvValue,
  extractField,
  readResponsePath,
  ToolCallError,
  type ToolErrorCode,
  type HttpToolCallOptions,
  type ToolContext,
  type ToolFetchImpl,
} from "./http-tool.js";

export {
  invokeOp,
  opRequiresApproval,
  type InvokeOpOptions,
  type ModuleContext,
  type ModuleIsolation,
  type ModuleRunner,
} from "./component.js";

export {
  createComponentDispatcher,
  type CreateComponentDispatcherOptions,
} from "./component-dispatch.js";

export {
  DirectoryComponentRegistry,
  LayeredComponentRegistry,
  createFirstPartyRegistry,
  isFirstPartyId,
  type DirectoryComponentRegistryOptions,
  InProcessModuleRunner,
  ComponentResolutionError,
  type ComponentRegistry,
  type ComponentSummary,
  type ComponentProblem,
  type ResolvedComponent,
  type ResolveOptions,
  type PinSource,
} from "./component-registry.js";

export { Pacer, instantClock, realClock, type Clock } from "./pacing.js";

export {
  buildApprovalBlocks,
  postApprovalRequest,
  postInteractionUpdate,
  verifySlackSignature,
  parseSlackInteractionPayload,
  isApproveAction,
  isRejectAction,
  SlackApiError,
  type PostApprovalRequestInput,
  type VerifySlackSignatureInput,
  type SlackInteraction,
} from "./slack-approval.js";

export {
  createFixtureFetch,
  fixtureFilePrefix,
  MissingFixtureError,
  type ToolFixtureMode,
  type CreateFixtureFetchOptions,
} from "./tool-fixtures.js";

export { evaluateCondition } from "./condition.js";

export { isBelowConfidenceThreshold } from "./guardrail.js";

export {
  runWorkflow,
  desugarLegacyTool,
  type RunEvent,
  type ApprovalDecision,
  type EngineDeps,
  type ComponentDispatcher,
  type ComponentTool,
  type ComponentRuntime,
  type PreparedComponentCall,
} from "./workflow.js";

export {
  AgentRun,
  createAgentRun,
  type RunStatus,
  type RunState,
  type PendingApproval,
  type StepRecord,
  type CreateAgentRunOptions,
} from "./run.js";
export {
  createModuleFixtures,
  moduleFixtureFilePrefix,
  type CreateModuleFixturesOptions,
} from "./module-fixtures.js";
export type { ModuleFixtureOutcome, ModuleFixtureSeam } from "./component.js";
export {
  loadRevocations,
  mergeShippedIndex,
  PROJECT_REGISTRY_INDEX,
  RevocationRegistry,
  RevokedComponentError,
  shippedRegistryIndexPath,
} from "./revocation.js";
