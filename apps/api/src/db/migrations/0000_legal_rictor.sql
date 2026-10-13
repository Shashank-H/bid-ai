CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"publisher_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_turn_id" uuid,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"name" text NOT NULL,
	"arguments_json" text NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_input_size" CHECK (octet_length("tool_executions"."arguments_json") <= 16384),
	CONSTRAINT "tool_result_size" CHECK ("tool_executions"."result" is null or octet_length("tool_executions"."result"::text) <= 32768)
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" text NOT NULL,
	"safe_output" text DEFAULT '' NOT NULL,
	"error_code" text,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_status" CHECK ("turns"."status" in ('running', 'completed', 'interrupted', 'cancelled', 'error')),
	CONSTRAINT "turns_input_size" CHECK (octet_length("turns"."input") <= 8192),
	CONSTRAINT "turns_output_size" CHECK (octet_length("turns"."safe_output") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner" ON "conversations" USING btree ("user_id","publisher_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_thread" ON "conversations" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_execution_call" ON "tool_executions" USING btree ("turn_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_request" ON "turns" USING btree ("conversation_id","request_id");--> statement-breakpoint
CREATE INDEX "turns_conversation" ON "turns" USING btree ("conversation_id","created_at","id");