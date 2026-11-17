ALTER TABLE "corrections" ADD COLUMN "amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "currency" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"correction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_project_created" ON "webhook_events" ("project_id","created_at");
