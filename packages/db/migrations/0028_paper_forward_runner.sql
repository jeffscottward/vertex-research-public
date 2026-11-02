ALTER TABLE "forward_drift_monitors" ADD COLUMN "paper_note" text;--> statement-breakpoint
ALTER TABLE "forward_drift_monitors" ADD COLUMN "paper_status" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "forward_drift_monitors" ADD COLUMN "paper_ticked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forward_drift_monitors" ADD CONSTRAINT "forward_drift_monitors_paper_status_check" CHECK ("forward_drift_monitors"."paper_status" in ('off', 'running'));--> statement-breakpoint
ALTER TABLE "forward_drift_monitors" ADD CONSTRAINT "forward_drift_monitors_paper_note_check" CHECK ("forward_drift_monitors"."paper_note" is null or char_length("forward_drift_monitors"."paper_note") between 1 and 500);