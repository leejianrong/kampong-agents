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
  StructuredOutputError,
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
  resolveConfigEnv,
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
  recoverSlackRawBody,
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
  type ApprovalFailureCode,
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

// Persisted pending approvals, resumable by key from any process (KAN-1854, ADR-0042).
export {
  APPROVAL_KEY_PREFIX,
  DEFAULT_APPROVAL_TTL_MS,
  approvalStateKey,
  listPendingApprovals,
  specHash,
  type ApprovalPhase,
  type PersistedApproval,
} from "./pending-approval.js";
export type { ResumeRequest } from "./workflow.js";

// Durable keyed runtime state (ADR-0028, KAM-112).
export type { StateStore, StateValue, PutOptions, StateClock } from "./state-store.js";
export {
  SqliteStateStore,
  DEFAULT_STATE_DB_PATH,
  type SqliteStateStoreOptions,
} from "./sqlite-state-store.js";

// Unattended runner: overlap lock, jitter, backoff, fail-visible (KAN-1855).
export {
  runUnattended,
  runnerLockKey,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type RunnerEvent,
  type RunnerOptions,
  type RunnerResult,
  type RunnerStopReason,
  type BackoffOptions,
} from "./runner.js";

// Schedule trigger: cron/every parsing, next-tick computation and overlap pacing (KAN-1856).
export {
  buildSchedule,
  isValidTimeZone,
  nextCronRun,
  nextTick,
  parseCron,
  parseEvery,
  MIN_EVERY_MS,
  type CronFields,
  type Schedule,
  type ScheduleSpec,
} from "./schedule.js";
export {
  createModelFixtures,
  MissingModelFixtureError,
  MODEL_FIXTURE_PREFIX,
  type CreateModelFixturesOptions,
} from "./model-fixtures.js";
export { pollKey, processPoll, type PollConfig, type PollInput, type PollOutcome } from "./poll.js";
export { createSchedulePacer, type OverlapPolicy, type SchedulePacer } from "./schedule-runner.js";

// KAN-1848 (ADR-0047): webhook auth presets, the `when` filter and `map`.
export {
  handleWebhookRequest,
  triggerHeaders,
  type WebhookDecision,
  type WebhookOptions,
  type WebhookRequest,
  type WebhookTriggerConfig,
} from "./webhook-trigger.js";
export { resolveWebhookAuth, secretEnvName, type ResolvedWebhookAuth } from "./webhook-auth.js";
