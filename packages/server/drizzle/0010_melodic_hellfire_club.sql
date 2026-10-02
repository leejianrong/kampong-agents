CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_spec_id_unique" UNIQUE("spec_id")
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE cascade ON UPDATE no action;