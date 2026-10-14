ALTER TABLE "turns" ADD COLUMN "model_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "tool_attempts" integer DEFAULT 0 NOT NULL;