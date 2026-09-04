-- D1 schema for ministry/staff data — replaces data/ministries.csv as the
-- app's persistence layer. See the migration plan for the full rationale
-- behind each design choice below; this file is just the DDL.

CREATE TABLE ministries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  city          TEXT NOT NULL,
  country       TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  date_opened   TEXT NOT NULL DEFAULT '',
  is_developing INTEGER NOT NULL DEFAULT 0,   -- SQLite has no boolean; 0/1
  universities  TEXT NOT NULL DEFAULT '[]',   -- JSON [{"name","year"}]
  blurb         TEXT NOT NULL DEFAULT '',
  photos        TEXT NOT NULL DEFAULT '[]',   -- JSON array of R2 image filenames (images/<value>)
  video_url     TEXT NOT NULL DEFAULT '',
  video_label   TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL                 -- ISO 8601; doubles as the optimistic-concurrency token
);

-- A staff member has exactly one home ministry (name/role/photo live
-- here); showing up elsewhere is a staff_assignments row, not a copy.
-- `slug` is deliberately NOT unique: two different people slugifying to
-- the same value is a pre-existing ambiguity in the name->photo-filename
-- scheme (they'd share a photo) that today's system already silently
-- tolerates rather than rejects — and a brief same-slug window can also
-- happen legitimately mid-"Move…" (bigtime/admin.js's confirmMoveStaff
-- adds the new home row before the old one is necessarily removed by a
-- separate save). A hard UNIQUE constraint would turn both into a write
-- failure instead of the harmless collision they've always been.
CREATE TABLE staff (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  home_ministry_id  INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_staff_home_ministry ON staff(home_ministry_id);
CREATE INDEX idx_staff_name ON staff(name);

-- A staffer shown at a ministry that isn't their home one. Deleting
-- either side cleans this up automatically (a real bug fix vs. today's
-- CSV-based system, where a deleted/renamed home staffer left dangling
-- assigned_staff references elsewhere that nothing cleaned up).
CREATE TABLE staff_assignments (
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  ministry_id INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, ministry_id)
);
CREATE INDEX idx_assignments_ministry ON staff_assignments(ministry_id);

-- Replaces data/deploy-version.txt's role: a single freshness token the
-- report/map cache-freshness checks compare against. No more public
-- marker file or HTTP polling for it — see worker/lib/dataVersion.js.
CREATE TABLE data_version (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  token      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Lightweight audit trail replacing git's free per-edit history for data.
-- Not full git-style versioning — one row per write, before/after as
-- JSON, enough to answer "what changed and when" without building
-- anything git-shaped. Deliberately no FK/cascade on ministry_id: a row
-- must survive its own ministry's later deletion.
CREATE TABLE ministry_edits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ministry_id  INTEGER NOT NULL,
  changed_at   TEXT NOT NULL,
  action       TEXT NOT NULL,        -- 'create' | 'update' | 'delete'
  old_json     TEXT,                 -- full ministry+staff snapshot before, NULL on create
  new_json     TEXT                  -- full ministry+staff snapshot after, NULL on delete
);
CREATE INDEX idx_ministry_edits_ministry ON ministry_edits(ministry_id);
