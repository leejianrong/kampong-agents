import { z } from "zod";

// The shared request description (KAN-1845, ADR-0029): how an HTTP call is described, used inline by
// the `http_request` tool today and embedded as `request` / `response` in a connector manifest op
// (KAN-1832). Defined once so the two never diverge. Failure rules, pacing and retry (KAN-1846) are
// added to this same shape.
//
// Secrets are never literals here either (Q14, AGENTS.md): a header or query parameter whose name
// looks like a credential must carry an `${ENV_VAR}` placeholder. That check is a heuristic on the
// parameter name; it cannot recognise a secret hidden in an arbitrarily named field, so docs still
// tell authors to use placeholders for every credential.

const ENV_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

// RFC 9110 token characters: what a header name may legally contain.
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// Names that carry a credential. Deliberately specific: "Idempotency-Key", "author" and "sort_key"
// are ordinary parameters, while "X-API-Key", "access_token" and "client_secret" are not.
const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie)$|token|secret|password|passwd|credential|api[-_]?key/i;
const SENSITIVE_QUERY =
  /token|secret|password|passwd|credential|signature|api[-_]?key|access[-_]?key|^(key|auth|authorization)$/i;

function requireEnvPlaceholderForSecrets(
  kind: "header" | "query parameter",
  sensitive: RegExp,
): (values: Record<string, string>, ctx: z.RefinementCtx) => void {
  return (values, ctx) => {
    for (const [name, value] of Object.entries(values)) {
      if (sensitive.test(name) && !ENV_PLACEHOLDER.test(value)) {
        ctx.addIssue({
          code: "custom",
          message:
            `${kind} "${name}" looks like a credential: reference an environment variable ` +
            `as \${ENV_VAR} (for example "Bearer \${TOKEN}"), never a literal secret`,
          path: [name],
        });
      }
    }
  };
}

export const requestHeadersSchema = z
  .record(z.string().regex(HEADER_NAME, "not a valid HTTP header name"), z.string())
  .superRefine(requireEnvPlaceholderForSecrets("header", SENSITIVE_HEADER));

export const requestQuerySchema = z
  .record(z.string().min(1), z.string())
  .superRefine(requireEnvPlaceholderForSecrets("query parameter", SENSITIVE_QUERY));

// Exactly one body encoding. `.strict()` rejects a body that names two (or an unknown key) instead
// of silently picking one.
export const requestBodySchema = z.union([
  z.object({ json: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]) }).strict(),
  z.object({ form: z.record(z.string(), z.string()) }).strict(),
  z.object({ raw: z.string(), content_type: z.string().min(1).optional() }).strict(),
]);

// A path into a JSON response: dotted keys, ["quoted keys"] (for names with spaces, such as Alpha
// Vantage's "Error Message") and numeric indexes. Deliberately not full JSONPath (ADR-0029).
const PATH_SEGMENT = String.raw`(?:\.[A-Za-z0-9_$-]+|\["(?:[^"\\]|\\.)*"\]|\[\d+\])`;
const PATH_FIRST = String.raw`(?:[A-Za-z0-9_$-]+|\["(?:[^"\\]|\\.)*"\]|\[\d+\])`;
const RESPONSE_PATH = new RegExp(`^${PATH_FIRST}${PATH_SEGMENT}*$`);

export const responsePathSchema = z
  .string()
  .regex(RESPONSE_PATH, 'not a valid path (use dotted keys, ["quoted keys"] and [0] indexes)');

// KAN-1846: a rule that turns a 200 response into a visible failure. Alpha Vantage reports a rate
// limit as `{ "Note": ... }` with HTTP 200 and Slack reports `{ "ok": false }`, so status alone is
// not enough. Exactly one condition per rule.
export const failureRuleSchema = z
  .object({
    path: responsePathSchema,
    exists: z.boolean().optional(),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    matches: z
      .string()
      .refine((pattern) => {
        try {
          new RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      }, "not a valid regular expression")
      .optional(),
    /** Where to read the human-readable reason from; defaults to a description of the rule. */
    message_path: responsePathSchema.optional(),
    /** Whether the retry policy may retry this failure (a rate-limit note, not a bad request). */
    retryable: z.boolean().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const conditions = [rule.exists, rule.equals, rule.matches].filter((c) => c !== undefined);
    if (conditions.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "a failure rule needs exactly one of exists, equals or matches",
      });
    }
  });

export const paceSchema = z.object({ rps: z.number().positive().max(1000) }).strict();

export const retrySchema = z
  .object({
    max: z.number().int().min(1).max(10),
    backoff: z.enum(["fixed", "exponential"]).optional(),
    base_ms: z.number().int().positive().optional(),
    max_delay_ms: z.number().int().positive().optional(),
  })
  .strict();

export const responseModeSchema = z.enum(["json", "text", "bytes"]);

export const requestResponseSchema = z.object({ mode: responseModeSchema }).strict();

/**
 * The optional request fields shared by every HTTP-shaped definition. Spread into a Zod object
 * alongside the caller's own `method` and `url`.
 */
export const requestOptionalFields = {
  headers: requestHeadersSchema.optional(),
  query: requestQuerySchema.optional(),
  body: requestBodySchema.optional(),
  response: requestResponseSchema.optional(),
  failure_when: z.array(failureRuleSchema).optional(),
  pace: paceSchema.optional(),
  retry: retrySchema.optional(),
};

export type RequestBody = z.infer<typeof requestBodySchema>;
export type ResponseMode = z.infer<typeof responseModeSchema>;
export type FailureRule = z.infer<typeof failureRuleSchema>;
export type Pace = z.infer<typeof paceSchema>;
export type Retry = z.infer<typeof retrySchema>;
