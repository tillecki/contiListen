-- Run once against an existing database. New installs get this from schema.sql.
--   npx wrangler d1 execute contilisten --remote --file=./migrations/001-sleep-timer.sql

ALTER TABLE users ADD COLUMN sleep_until INTEGER;
