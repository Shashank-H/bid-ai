ALTER TABLE "turns" ADD COLUMN "specialist_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "decision_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Every pre-gate model attempt was a specialist attempt. Preserve its resume budget.
UPDATE "turns" SET "specialist_attempts" = "model_attempts";