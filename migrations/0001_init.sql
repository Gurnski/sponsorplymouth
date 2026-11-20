CREATE TABLE targets (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'walker')),
  jg_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dares (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  target_id INTEGER NOT NULL REFERENCES targets(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  suggested_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX dares_target ON dares(target_id, status);

-- source is 'donor' (self-reported) or 'admin' (entered from JustGiving).
-- A future JustGiving API poller can add its own source without a schema change.
CREATE TABLE pledges (
  id INTEGER PRIMARY KEY,
  dare_id INTEGER NOT NULL REFERENCES dares(id),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  donor_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'donor',
  status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pledges_dare ON pledges(dare_id, status);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE rate_events (
  kind TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX rate_events_lookup ON rate_events(kind, ip_hash, at);

INSERT INTO targets (slug, name, kind, sort) VALUES ('group', 'The whole group', 'group', 0);

INSERT INTO settings (key, value) VALUES
  ('challenge_title', 'Dare us on Dartmoor'),
  ('group_name', ''),
  ('charity_name', ''),
  ('walk_date', ''),
  ('closes_at', ''),
  ('group_winners', '3'),
  ('walker_winners', '1');
