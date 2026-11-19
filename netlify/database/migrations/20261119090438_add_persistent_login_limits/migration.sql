CREATE TABLE "login_attempts" (
	"key" text PRIMARY KEY,
	"attempts" integer NOT NULL,
	"window_start" bigint NOT NULL
);
