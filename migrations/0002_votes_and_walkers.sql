-- Group dares are free to vote on, one vote per person per dare.
-- voter is a random id the browser keeps. Enough for fun stakes, not an election.
CREATE TABLE votes (
  dare_id INTEGER NOT NULL REFERENCES dares(id),
  voter TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (dare_id, voter)
);

INSERT INTO settings (key, value) VALUES ('group_enabled', '1');

INSERT INTO targets (slug, name, kind, jg_url, sort) VALUES
  ('daniel', 'Daniel', 'walker', 'https://www.justgiving.com/fundraising/cachpage-daniel-rea', 1),
  ('emma', 'Emma', 'walker', 'https://www.justgiving.com/fundraising/cachpage-emma-binda', 2),
  ('finley', 'Finley', 'walker', 'https://www.justgiving.com/fundraising/cachpage-finley-hopper', 3),
  ('frankie', 'Frankie', 'walker', 'https://www.justgiving.com/fundraising/cachpage-frankie-hodson', 4),
  ('gabrielle', 'Gabrielle', 'walker', 'https://www.justgiving.com/fundraising/cachpage-gabrielle-slater', 5),
  ('jack', 'Jack', 'walker', 'https://www.justgiving.com/fundraising/cachpage-jack-de-vere', 6),
  ('josh', 'Josh', 'walker', 'https://www.justgiving.com/fundraising/cachpage-joshua-cordes', 7),
  ('kaity', 'Kaity', 'walker', 'https://www.justgiving.com/fundraising/kptrekseverest', 8),
  ('mya', 'Mya', 'walker', 'https://www.justgiving.com/fundraising/cachpage-mya-preece', 9),
  ('natasha', 'Natasha', 'walker', 'https://www.justgiving.com/fundraising/cachpage-natasha-hughes', 10),
  ('pratham', 'Pratham', 'walker', 'https://www.justgiving.com/fundraising/cachpage-pratham-mahendra', 11),
  ('ted', 'Ted', 'walker', 'https://www.justgiving.com/fundraising/cachpage-ted-taylor', 12),
  ('vriti', 'Vriti', 'walker', 'https://www.justgiving.com/fundraising/cachpage-vriti-tangri', 13);
