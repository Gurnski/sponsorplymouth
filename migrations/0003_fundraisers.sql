-- The site becomes an umbrella for several fundraisers. The Dartmoor dare board
-- is fundraiser 1 and keeps every target, dare, donation and vote it had.
--
-- Nothing here removes or renames anything, so the previous worker keeps
-- working until the new one is deployed. The old settings rows stay for the
-- same reason, even though the new worker reads the copies on fundraisers.

CREATE TABLE fundraisers (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('dare', 'event', 'challenge')),
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  target_pence INTEGER NOT NULL DEFAULT 0,
  event_date TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  -- Events and challenges: where the donate button goes, and a total typed in by a leader.
  donate_url TEXT NOT NULL DEFAULT '',
  manual_total_pence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'finished')),
  sort INTEGER NOT NULL DEFAULT 0,
  -- Dare boards only.
  closes_at TEXT NOT NULL DEFAULT '',
  group_enabled INTEGER NOT NULL DEFAULT 1,
  group_winners INTEGER NOT NULL DEFAULT 3,
  walker_winners INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO fundraisers (id, slug, title, type, summary, body, event_date, status, sort, closes_at, group_enabled, group_winners, walker_winners)
SELECT 1, 'dartmoor', 'Dartmoor Dares', 'dare',
  'Dare us on Dartmoor. Suggest something daft for us to do on the walk, vote for group dares for free, or donate to push a dare up one walker''s list.',
  '',
  COALESCE((SELECT value FROM settings WHERE key = 'walk_date'), ''),
  'live', 1,
  COALESCE((SELECT value FROM settings WHERE key = 'closes_at'), ''),
  CASE WHEN (SELECT value FROM settings WHERE key = 'group_enabled') = '0' THEN 0 ELSE 1 END,
  MAX(1, MIN(10, COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'group_winners'), 3))),
  MAX(1, MIN(10, COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'walker_winners'), 1)));

-- A draft for Emma to fill in and publish herself. Drafts never show on the public site.
INSERT INTO fundraisers (id, slug, title, type, summary, body, place, status, sort) VALUES
  (2, 'plymouth-hoe', 'Sponsored activity on Plymouth Hoe', 'challenge',
   'PLACEHOLDER for Emma to replace: one or two sentences saying what you are doing on the Hoe and why.',
   'PLACEHOLDER for Emma to replace.' || char(10) || char(10) ||
   'Say what the activity is, when it happens, who is taking part and how people can sponsor it. Add the JustGiving link and a target below, then set the status to Live to publish it.',
   'Plymouth Hoe', 'draft', 2);

-- Dares, donations and votes all hang off a target, so this is the only link needed.
-- SQLite refuses ADD COLUMN with a REFERENCES clause and a non-null default, so there is none.
ALTER TABLE targets ADD COLUMN fundraiser_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX targets_fundraiser ON targets(fundraiser_id, active);

-- Which leader approved, confirmed or added it. Blank for anything older than this.
ALTER TABLE dares ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE pledges ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';

-- Leader logins. ADMIN_PASSWORD stays the owner login and is not stored here.
-- key_hash is the SHA-256 of a long random key that is shown once when it is made.
CREATE TABLE admins (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'leader' CHECK (role IN ('owner', 'leader')),
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked INTEGER NOT NULL DEFAULT 0
);

-- The JustGiving pages that add up to the Everest total, with the last figures read
-- from each. A page that fails to load keeps its previous figures.
CREATE TABLE everest_pages (
  short_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  raised_pence INTEGER,
  target_pence INTEGER,
  fetched_at INTEGER,
  failed INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO everest_pages (short_name)
SELECT replace(jg_url, 'https://www.justgiving.com/fundraising/', '') FROM targets
WHERE kind = 'walker' AND active = 1
  AND jg_url LIKE 'https://www.justgiving.com/fundraising/_%'
  AND replace(jg_url, 'https://www.justgiving.com/fundraising/', '') NOT GLOB '*[^A-Za-z0-9_-]*'
ORDER BY sort, id;

INSERT INTO settings (key, value) VALUES
  ('featured_fundraiser_id', '1'),
  ('everest_checked_at', '0'),
  ('site_intro', 'We''re University of Plymouth students trekking to Everest Base Camp in summer 2027 for Amnesty International. Dare us, come to an event or sponsor a challenge.'),
  ('about_text',
   'We''re a group of University of Plymouth students raising money for Amnesty International. In summer 2027 we''re trekking to Everest Base Camp, and between now and then we''re running smaller fundraisers to get there. This site is where they all live.'
   || char(10) || char(10) ||
   'Some of them are daft. Dartmoor Dares lets you suggest things for us to do on a walk across the moor, then vote or donate to decide which ones we actually have to do. Others are events you can come to, or challenges you can sponsor.'
   || char(10) || char(10) ||
   'The site never handles money. Every donate button opens JustGiving, and your donation goes from there to the charity. All we do here is keep track of the dares and the totals.'
   || char(10) || char(10) ||
   'Each fundraiser is looked after by one of us, a challenge leader, who reads every suggestion before it appears.'),
  ('challenge_text',
   'In summer 2027 we''re trekking to Everest Base Camp for Amnesty International.'
   || char(10) || char(10) ||
   'Each of us has our own JustGiving page and our own target. The total on this page adds up what has been raised across all of them, and it''s checked against JustGiving every 15 minutes or so.'
   || char(10) || char(10) ||
   'The fundraisers on this site are how we plan to get there: dares on Dartmoor, events, sponsored challenges. Whichever one you back, your money goes through JustGiving to Amnesty International.');
