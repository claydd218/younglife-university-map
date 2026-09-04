-- Adds an admin role to per-user accounts (scripts/schema-users.sql),
-- replacing superbigtime's separate shared-password gate for user
-- management with an in-app Admin tab restricted to is_admin users.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-admin-flag.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-admin-flag.sql

ALTER TABLE admin_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Every account that exists at migration time (Clay, Brett, Clark) becomes
-- an admin — explicit, one-time bootstrap so there's no gap where nobody
-- can manage users. Accounts created afterward default to is_admin=0
-- unless the creating admin checks the box.
UPDATE admin_users SET is_admin = 1;
