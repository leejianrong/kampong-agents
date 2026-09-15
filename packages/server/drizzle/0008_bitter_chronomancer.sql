CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" text NOT NULL,
	"trace_json" jsonb NOT NULL,
	"final_output" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE cascade ON UPDATE no action;