import { z } from "zod";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- A small JSON Schema subset ------------------------------------------------------------------
// Enough to validate an op's input and drive a generated canvas form. `.strict()` makes an unsupported
// keyword (oneOf, $ref, ...) a loud lint error instead of a silently ignored one.

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

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z
    .object({
      type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
      title: z.string().optional(),
      description: z.string().optional(),
      default: scalar.optional(),
      enum: z.array(scalar).min(1).optional(),
      format: z.literal("multiline").optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      pattern: z
        .string()
        .refine((p) => {
          try {
            new RegExp(p);
            return true;
          } catch {
            return false;
          }
        }, "not a valid regular expression")
        .optional(),
      properties: z.record(z.string().regex(NAME), schemaNodeSchema).optional(),
      required: z.array(z.string()).optional(),
      items: schemaNodeSchema.optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      const fits = (value: string | number | boolean): boolean =>
        node.type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : node.type === "object" || node.type === "array"
            ? false
            : typeof value === node.type;
      if (node.default !== undefined && !fits(node.default)) {
        ctx.addIssue({
          code: "custom",
          message: `default is not a valid ${node.type}`,
          path: ["default"],
        });
      }
      for (const [i, member] of (node.enum ?? []).entries()) {
        if (!fits(member)) {
          ctx.addIssue({
            code: "custom",
            message: `enum value is not a valid ${node.type}`,
            path: ["enum", i],
          });
        }
      }
      for (const name of node.required ?? []) {
        if (!node.properties || !(name in node.properties)) {
          ctx.addIssue({
            code: "custom",
            message: `required property "${name}" is not declared in properties`,
            path: ["required"],
          });
        }
      }
    }),
);
