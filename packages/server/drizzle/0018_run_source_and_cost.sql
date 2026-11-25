ALTER TABLE "deployments" ADD COLUMN "deployed_by" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "triggered_by" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_usd" numeric(12, 6);