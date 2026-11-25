// Runs the worker against a real SQLite database through the D1 stand-in in
// helpers/d1.js. Every test builds its own database, because all requests here
// come from one address and would otherwise share the rate limits.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';
import { applyMigrations, exec, freshDatabase, row, rows } from './helpers/d1.js';

const PASSWORD = 'test-password';
const APP_ID = 'test-app-id';
const MINUTE = 60 * 1000;

/* The network. Nothing may leave the machine, and JustGiving is faked per test. */

const realFetch = globalThis.fetch;
const strayRequests = [];
const refuseFetch = async (input) => {
  strayRequests.push(String(input?.url ?? input));
  throw new Error('The tests must not reach the network.');
};

before(() => { globalThis.fetch = refuseFetch; });
after(() => { globalThis.fetch = realFetch; });
// The worker swallows JustGiving errors, so a stray request has to be caught here.
afterEach(() => assert.deepEqual(strayRequests.splice(0), [], 'unexpected outbound requests'));

// Answers JustGiving page requests from `pages`, keyed by short name. A name
// that is not there is a 404, and `down = true` makes every request fail.
function stubJustGiving(t, pages) {
  const justGiving = { pages, down: false, requests: [] };
  const prefix = `https://api.justgiving.com/${APP_ID}/v1/fundraising/pages/`;
  globalThis.fetch = async (input) => {
    const address = String(input?.url ?? input);
    if (!address.startsWith(prefix)) return refuseFetch(address);
    const name = decodeURIComponent(address.slice(prefix.length));
    justGiving.requests.push(name);
    if (justGiving.down) throw new TypeError('fetch failed');
    const page = justGiving.pages[name];
    return page ? Response.json(page) : new Response('', { status: 404 });
  };
  t.after(() => { globalThis.fetch = refuseFetch; });
  return justGiving;
}

/* A site: a database, the worker's env, and ways to call it. */

function site({ justGiving = false, sqliteAndDb = freshDatabase() } = {}) {
  const { sqlite, db } = sqliteAndDb;
  const pending = [];
  const env = {
    DB: db,
    ADMIN_PASSWORD: PASSWORD,
    ASSETS: {
      fetch: async (request) => new Response(`<html>${new URL(request.url).pathname}</html>`, { headers: { 'content-type': 'text/html' } }),
    },
  };
  if (justGiving) env.JUSTGIVING_APP_ID = APP_ID;
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  const api = async (method, path, body, token) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const request = new Request(`http://test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await worker.fetch(request, env, ctx);
    const text = await response.text();
    // A 500 is the worker or the D1 stand-in falling over, never an answer a test wants.
    assert.notEqual(response.status, 500, `${method} ${path} broke the server: ${text}`);
    let data = text;
    try { data = JSON.parse(text); } catch { /* An HTML page. */ }
    return { status: response.status, data, headers: response.headers };
  };

  return {
    sqlite,
    env,
    pending,
    api,
    admin: (method, path, body) => api(method, path, body, PASSWORD),
    // Waits for work the worker left running after its response.
    settle: () => Promise.all(pending.splice(0)),
  };
}

/* Fundraisers */

const dareBoard = (fields = {}) => ({
  type: 'dare', title: 'Tor Dares', summary: 'Dares on the tors.', body: '', photo_url: '', target: '', event_date: '', place: '',
  status: 'live', closes_at: '', group_enabled: true, group_winners: 3, walker_winners: 1, ...fields,
});

const eventPage = (fields = {}) => ({
  type: 'event', title: 'Quiz Night', summary: 'Trivia and prizes.', body: '', photo_url: '', target: '', event_date: '', place: '',
  status: 'live', donate_url: '', manual_total: '', ...fields,
});

async function createFundraiser(s, fields) {
  const created = await s.admin('POST', '/api/admin/fundraisers', fields);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data; // { id, slug }
}

// The API wants every field on each save, so this reads the fundraiser back and changes only what the test names.
async function updateFundraiser(s, id, changes) {
  const { fundraiser } = (await s.admin('GET', `/api/admin/fundraisers/${id}`)).data;
  return s.admin('PUT', `/api/admin/fundraisers/${id}`, {
    ...fundraiser,
    target: String(fundraiser.target_pence / 100),
    manual_total: String(fundraiser.manual_total_pence / 100),
    ...changes,
  });
}

const targetId = (sqlite, slug) => row(sqlite, 'SELECT id FROM targets WHERE slug = ?', slug).id;
const groupOf = (sqlite, fundraiserId) => row(sqlite, "SELECT id FROM targets WHERE fundraiser_id = ? AND kind = 'group'", fundraiserId).id;
const walkersOf = (sqlite, fundraiserId) => rows(sqlite, "SELECT id, slug, name, jg_url, active FROM targets WHERE fundraiser_id = ? AND kind = 'walker' ORDER BY sort, id", fundraiserId);

/* Dares, donations and votes put straight into the database, for arranging a test. */

let dareNumber = 0;

function addDare(sqlite, target, status = 'approved') {
  const code = `DARE-TEST${++dareNumber}`;
  const { id } = exec(sqlite, 'INSERT INTO dares (code, target_id, title, status) VALUES (?, ?, ?, ?)', code, target, `Dare ${code}`, status);
  return { id, code };
}

const addPledge = (sqlite, dareId, pence, status = 'confirmed') =>
  exec(sqlite, 'INSERT INTO pledges (dare_id, amount_pence, status) VALUES (?, ?, ?)', dareId, pence, status).id;

const voter = (n) => `test-voter-${String(n).padStart(8, '0')}`;
const count = (sqlite, table) => row(sqlite, `SELECT COUNT(*) AS n FROM ${table}`).n;

const getBoard = (s, slug, token) => s.api('GET', slug ? `/api/board?f=${slug}` : '/api/board', undefined, token);
const listOn = (board, slug) => board.data.boards.find((list) => list.slug === slug);
const cardFor = async (s, slug) => (await s.api('GET', '/api/site')).data.fundraisers.find((card) => card.slug === slug);

/* Migration 0003 on a database that already has dares in it */

const OLD_CLOSES_AT = '2999-05-01T17:00:00.000Z';

function oldSiteBeforeMigration() {
  const sqliteAndDb = freshDatabase({ upTo: '0002' });
  const { sqlite } = sqliteAndDb;
  const group = targetId(sqlite, 'group');
  const daniel = targetId(sqlite, 'daniel');
  const groupDare = addDare(sqlite, group);
  const walkerDare = addDare(sqlite, daniel);
  addDare(sqlite, daniel, 'pending');
  addDare(sqlite, targetId(sqlite, 'emma'), 'rejected');
  addPledge(sqlite, walkerDare.id, 1200, 'confirmed');
  addPledge(sqlite, walkerDare.id, 500, 'unconfirmed');
  addPledge(sqlite, walkerDare.id, 300, 'rejected');
  exec(sqlite, 'INSERT INTO votes (dare_id, voter) VALUES (?, ?), (?, ?)', groupDare.id, voter(1), groupDare.id, voter(2));
  const set = (key, value) => exec(sqlite, 'UPDATE settings SET value = ? WHERE key = ?', value, key);
  set('closes_at', OLD_CLOSES_AT);
  set('group_enabled', '0');
  set('group_winners', '5');
  set('walk_date', 'Saturday 14 November');
  set('challenge_title', 'Our own title');
  exec(sqlite, "UPDATE targets SET active = 0 WHERE slug = 'ted'");
  return { sqliteAndDb, sqlite, groupDare, walkerDare };
}

const OLD_TABLES = {
  targets: 'SELECT id, slug, name, kind, jg_url, active, sort FROM targets ORDER BY id',
  dares: 'SELECT id, code, target_id, title, detail, suggested_by, status, created_at FROM dares ORDER BY id',
  pledges: 'SELECT id, dare_id, amount_pence, donor_name, source, status, created_at FROM pledges ORDER BY id',
  votes: 'SELECT dare_id, voter, created_at FROM votes ORDER BY dare_id, voter',
};

for (const [table, query] of Object.entries(OLD_TABLES)) {
  test(`migration 0003 keeps every row of ${table} as it was`, () => {
    const { sqlite } = oldSiteBeforeMigration();
    const before = rows(sqlite, query);
    assert.ok(before.length > 0);
    applyMigrations(sqlite, { after: '0002' });
    assert.deepEqual(rows(sqlite, query), before);
  });
}

function migratedOldSite() {
  const old = oldSiteBeforeMigration();
  applyMigrations(old.sqlite, { after: '0002' });
  return old;
}

test('migration 0003 gives every existing target to fundraiser 1', () => {
  const { sqlite } = migratedOldSite();
  const targets = rows(sqlite, 'SELECT fundraiser_id FROM targets');
  assert.equal(targets.length, 14);
  assert.ok(targets.every((target) => target.fundraiser_id === 1));
});

test('migration 0003 makes the Dartmoor board fundraiser 1 with the old settings', () => {
  const { sqlite } = migratedOldSite();
  const dartmoor = row(sqlite, 'SELECT slug, type, status, event_date, closes_at, group_enabled, group_winners, walker_winners FROM fundraisers WHERE id = 1');
  assert.deepEqual(dartmoor, {
    slug: 'dartmoor', type: 'dare', status: 'live', event_date: 'Saturday 14 November',
    closes_at: OLD_CLOSES_AT, group_enabled: 0, group_winners: 5, walker_winners: 1,
  });
});

test('migration 0003 leaves the old settings rows where they were', () => {
  const { sqlite } = oldSiteBeforeMigration();
  const before = rows(sqlite, 'SELECT key, value FROM settings ORDER BY key');
  applyMigrations(sqlite, { after: '0002' });
  const now = new Map(rows(sqlite, 'SELECT key, value FROM settings').map((setting) => [setting.key, setting.value]));
  for (const setting of before) assert.equal(now.get(setting.key), setting.value, setting.key);
});

test('migration 0003 keeps odd winner counts between 1 and 10', () => {
  const { sqlite } = freshDatabase({ upTo: '0002' });
  exec(sqlite, "UPDATE settings SET value = '99' WHERE key = 'group_winners'");
  exec(sqlite, "UPDATE settings SET value = 'lots' WHERE key = 'walker_winners'");
  applyMigrations(sqlite, { after: '0002' });
  assert.deepEqual(row(sqlite, 'SELECT group_winners, walker_winners FROM fundraisers WHERE id = 1'), { group_winners: 10, walker_winners: 1 });
});

test('migration 0003 lists the JustGiving pages of active walkers only', () => {
  const { sqlite } = migratedOldSite();
  const names = rows(sqlite, 'SELECT short_name FROM everest_pages ORDER BY rowid').map((page) => page.short_name);
  assert.equal(names.length, 12);
  assert.equal(names[0], 'cachpage-daniel-rea');
  assert.ok(names.includes('kptrekseverest'));
  assert.ok(!names.includes('cachpage-ted-taylor'), 'the hidden walker is left out');
});

test('migration 0003 starts every JustGiving page with no figures', () => {
  const { sqlite } = migratedOldSite();
  const read = rows(sqlite, 'SELECT short_name FROM everest_pages WHERE raised_pence IS NOT NULL OR fetched_at IS NOT NULL OR failed != 0');
  assert.deepEqual(read, []);
});

test('migration 0003 leaves out a walker with no JustGiving link', () => {
  const { sqlite } = freshDatabase({ upTo: '0002' });
  exec(sqlite, "UPDATE targets SET jg_url = '' WHERE slug = 'emma'");
  applyMigrations(sqlite, { after: '0002' });
  const names = rows(sqlite, 'SELECT short_name FROM everest_pages').map((page) => page.short_name);
  assert.equal(names.length, 12);
  assert.ok(!names.includes(''));
});

// The page names 0003 lists when the walkers' links are set to `links`, keyed by walker slug.
function seededPages(links) {
  const { sqlite } = freshDatabase({ upTo: '0002' });
  exec(sqlite, "UPDATE targets SET jg_url = '' WHERE kind = 'walker'");
  for (const [slug, link] of Object.entries(links)) exec(sqlite, 'UPDATE targets SET jg_url = ? WHERE slug = ?', link, slug);
  applyMigrations(sqlite, { after: '0002' });
  return rows(sqlite, 'SELECT short_name FROM everest_pages ORDER BY rowid').map((page) => page.short_name);
}

test('migration 0003 lists a page once when two walkers share it', () => {
  const shared = 'https://www.justgiving.com/fundraising/shared-page';
  assert.deepEqual(seededPages({ daniel: shared, emma: shared }), ['shared-page']);
});

// These are all links the admin page accepts for a walker. Their pages have to be
// added by hand under Everest after the migration.
test('migration 0003 leaves out links that are not exactly https://www.justgiving.com/fundraising/<name>', () => {
  const pages = seededPages({
    daniel: 'https://www.justgiving.com/page/daniel-new',
    emma: 'https://justgiving.com/fundraising/emma-no-www',
    finley: 'https://www.justgiving.com/fundraising/finley-slash/',
    frankie: 'https://www.justgiving.com/fundraising/frankie-query?utm_source=copy',
    josh: 'https://www.JustGiving.com/fundraising/josh-capital-host',
  });
  assert.deepEqual(pages, []);
});

// A name with a # or a % in it can never be read from JustGiving, so the migration
// leaves such links out. If one gets in anyway, the admin API can still remove it.
test('migration 0003 lists only page names the admin page can remove', () => {
  const pages = seededPages({
    daniel: 'https://www.justgiving.com/fundraising/daniel-page#donate',
    emma: 'https://www.justgiving.com/fundraising/emma%20page',
    finley: 'https://www.justgiving.com/fundraising/finley-page',
  });
  assert.deepEqual(pages.filter((name) => !/^[A-Za-z0-9_-]{1,100}$/.test(name)), []);
});

test('an Everest page with an odd name can still be removed through the admin API', async () => {
  const s = site();
  exec(s.sqlite, "INSERT INTO everest_pages (short_name) VALUES ('daniel-page#donate')");
  const removed = await s.admin('DELETE', `/api/admin/everest/pages/${encodeURIComponent('daniel-page#donate')}`);
  assert.equal(removed.status, 200);
});

test('migration 0003 adds the Plymouth Hoe draft', () => {
  const { sqlite } = migratedOldSite();
  const hoe = row(sqlite, "SELECT id, type, status, place FROM fundraisers WHERE slug = 'plymouth-hoe'");
  assert.deepEqual(hoe, { id: 2, type: 'challenge', status: 'draft', place: 'Plymouth Hoe' });
});

test('migration 0003 features fundraiser 1', () => {
  const { sqlite } = migratedOldSite();
  assert.equal(row(sqlite, "SELECT value FROM settings WHERE key = 'featured_fundraiser_id'").value, '1');
});

test('migration 0003 leaves older dares and donations with no reviewer', () => {
  const { sqlite } = migratedOldSite();
  const reviewed = rows(sqlite, "SELECT reviewed_by FROM dares WHERE reviewed_by != '' UNION ALL SELECT reviewed_by FROM pledges WHERE reviewed_by != ''");
  assert.deepEqual(reviewed, []);
});

test('the worker shows the migrated dares on the Dartmoor board', async () => {
  const { sqliteAndDb, walkerDare } = migratedOldSite();
  const board = await getBoard(site({ sqliteAndDb }));
  const dare = listOn(board, 'daniel').dares.find((item) => item.code === walkerDare.code);
  assert.equal(board.data.fundraiser.slug, 'dartmoor');
  assert.equal(dare.total_pence, 1200);
  assert.equal(dare.pending_pence, 500);
  assert.equal(board.data.total_pence, 1200);
});

test('the worker keeps the group board switched off after the migration', async () => {
  const { sqliteAndDb } = migratedOldSite();
  const board = await getBoard(site({ sqliteAndDb }));
  assert.equal(listOn(board, 'group'), undefined);
  assert.equal(board.data.boards.length, 12, '13 walkers less the hidden one');
});

/* Several dare boards side by side */

async function twoBoards() {
  const s = site();
  const tors = await createFundraiser(s, dareBoard({ title: 'Tor Dares', copy_walkers_from: 1 }));
  return { ...s, tors };
}

test('a new dare board gets its own group list', async () => {
  const { sqlite, tors } = await twoBoards();
  const groups = rows(sqlite, "SELECT slug, fundraiser_id FROM targets WHERE kind = 'group' ORDER BY id");
  assert.deepEqual(groups, [{ slug: 'group', fundraiser_id: 1 }, { slug: 'tor-dares-group', fundraiser_id: tors.id }]);
});

test('a new dare board can copy the walkers of another board', async () => {
  const { sqlite, tors } = await twoBoards();
  const original = walkersOf(sqlite, 1);
  const copies = walkersOf(sqlite, tors.id);
  assert.equal(copies.length, 13);
  assert.deepEqual(copies.map((walker) => [walker.name, walker.jg_url]), original.map((walker) => [walker.name, walker.jg_url]));
});

test('copied walkers get slugs of their own', async () => {
  const { sqlite, tors } = await twoBoards();
  const copies = walkersOf(sqlite, tors.id).map((walker) => walker.slug);
  assert.equal(copies[0], 'daniel-2');
  const all = rows(sqlite, 'SELECT slug FROM targets').map((target) => target.slug);
  assert.equal(new Set(all).size, all.length);
});

test('a walker hidden on the original board is hidden in the copy', async () => {
  const s = site();
  exec(s.sqlite, "UPDATE targets SET active = 0 WHERE slug = 'ted'");
  const tors = await createFundraiser(s, dareBoard({ copy_walkers_from: 1 }));
  const board = await getBoard(s, tors.slug);
  assert.equal(board.data.boards.filter((list) => list.kind === 'walker').length, 12);
});

test('a new dare board without copied walkers has only its group list', async () => {
  const s = site();
  const tors = await createFundraiser(s, dareBoard());
  const board = await getBoard(s, tors.slug);
  assert.deepEqual(board.data.boards.map((list) => list.kind), ['group']);
});

test('two fundraisers with the same title get different slugs', async () => {
  const s = site();
  const first = await createFundraiser(s, eventPage({ title: 'Bake Sale' }));
  const second = await createFundraiser(s, eventPage({ title: 'Bake Sale' }));
  assert.deepEqual([first.slug, second.slug], ['bake-sale', 'bake-sale-2']);
});

test('a dare suggested on one board does not show on the other', async () => {
  const s = await twoBoards();
  const suggested = await s.api('POST', '/api/dares', { target_id: groupOf(s.sqlite, s.tors.id), title: 'Sing on every tor' });
  assert.equal(suggested.status, 201);
  const waiting = (await s.admin('GET', '/api/admin/overview')).data.queue.dares;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].fundraiser_id, s.tors.id);
  await s.admin('PUT', `/api/admin/dares/${waiting[0].id}`, { status: 'approved' });

  assert.deepEqual(listOn(await getBoard(s, s.tors.slug), 'tor-dares-group').dares.map((dare) => dare.title), ['Sing on every tor']);
  assert.deepEqual(listOn(await getBoard(s, 'dartmoor'), 'group').dares, []);
});

test('the admin page lists approved dares under their own fundraiser only', async () => {
  const s = await twoBoards();
  const dare = addDare(s.sqlite, groupOf(s.sqlite, s.tors.id));
  const dartmoor = (await s.admin('GET', '/api/admin/fundraisers/1')).data;
  const tors = (await s.admin('GET', `/api/admin/fundraisers/${s.tors.id}`)).data;
  assert.deepEqual(dartmoor.dares, []);
  assert.deepEqual(tors.dares.map((item) => item.code), [dare.code]);
  assert.equal(tors.targets.length, 14);
});

test('a vote counts only on the board its dare is on', async () => {
  const s = await twoBoards();
  addDare(s.sqlite, groupOf(s.sqlite, 1));
  const dare = addDare(s.sqlite, groupOf(s.sqlite, s.tors.id));
  const vote = await s.api('POST', '/api/votes', { code: dare.code, voter: voter(1) });
  assert.deepEqual(vote.data, { voted: true });
  assert.deepEqual(listOn(await getBoard(s, s.tors.slug), 'tor-dares-group').dares.map((item) => item.votes), [1]);
  assert.deepEqual(listOn(await getBoard(s, 'dartmoor'), 'group').dares.map((item) => item.votes), [0]);
});

test('a donation counts only towards the board its dare is on', async () => {
  const s = await twoBoards();
  const dare = addDare(s.sqlite, targetId(s.sqlite, 'daniel-2'));
  const logged = await s.api('POST', '/api/pledges', { code: dare.code, amount: '15' });
  assert.equal(logged.status, 201);
  const { pledges } = (await s.admin('GET', '/api/admin/overview')).data.queue;
  assert.equal(pledges[0].fundraiser_id, s.tors.id);
  await s.admin('PUT', `/api/admin/pledges/${pledges[0].id}`, { status: 'confirmed' });

  assert.equal((await getBoard(s, s.tors.slug)).data.total_pence, 1500);
  assert.equal((await getBoard(s, 'dartmoor')).data.total_pence, 0);
  assert.equal((await cardFor(s, s.tors.slug)).total_pence, 1500);
  assert.equal((await cardFor(s, 'dartmoor')).total_pence, 0);
});

test('/api/board with no fundraiser named is the Dartmoor board', async () => {
  const s = await twoBoards();
  const board = await getBoard(s);
  assert.equal(board.status, 200);
  assert.equal(board.data.fundraiser.slug, 'dartmoor');
  assert.deepEqual(board.data.boards.map((list) => list.slug).slice(0, 2), ['group', 'daniel']);
});

test('/api/board?f=<slug> is that fundraiser\'s board', async () => {
  const s = await twoBoards();
  const board = await getBoard(s, s.tors.slug);
  assert.equal(board.data.fundraiser.title, 'Tor Dares');
  assert.deepEqual(board.data.boards.map((list) => list.slug).slice(0, 2), ['tor-dares-group', 'daniel-2']);
});

test('/api/board answers with the fundraiser, preview, closed, total and lists', async () => {
  const board = await getBoard(site());
  assert.deepEqual(Object.keys(board.data).sort(), ['boards', 'closed', 'fundraiser', 'preview', 'total_pence']);
  assert.equal(board.data.preview, false);
  assert.equal(board.data.closed, false);
});

test('/api/board is not found for an unknown fundraiser', async () => {
  assert.equal((await getBoard(site(), 'nope')).status, 404);
});

test('/api/board is not found for an event, which has no dares', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  assert.equal((await getBoard(s, quiz.slug)).status, 404);
});

test('a new walker joins the board named in the request', async () => {
  const s = await twoBoards();
  const added = await s.admin('POST', '/api/admin/walkers', { name: 'Robin', jg_url: '', fundraiser_id: s.tors.id });
  assert.equal(added.status, 201);
  assert.ok(listOn(await getBoard(s, s.tors.slug), 'robin'));
  assert.equal(listOn(await getBoard(s, 'dartmoor'), 'robin'), undefined);
});

test('a new walker joins the Dartmoor board when none is named', async () => {
  const s = await twoBoards();
  await s.admin('POST', '/api/admin/walkers', { name: 'Robin', jg_url: '' });
  assert.ok(listOn(await getBoard(s, 'dartmoor'), 'robin'));
});

test('a walker cannot be added to an event', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  assert.equal((await s.admin('POST', '/api/admin/walkers', { name: 'Robin', jg_url: '', fundraiser_id: quiz.id })).status, 400);
});

/* Totals */

// One counted donation of £10 on Daniel's list, surrounded by money that must not count.
function boardWithMoneyThatDoesNotCount() {
  const s = site();
  const daniel = targetId(s.sqlite, 'daniel');
  const counted = addDare(s.sqlite, daniel);
  addPledge(s.sqlite, counted.id, 1000, 'confirmed');
  addPledge(s.sqlite, counted.id, 500, 'unconfirmed');
  addPledge(s.sqlite, counted.id, 300, 'rejected');
  addPledge(s.sqlite, addDare(s.sqlite, daniel, 'pending').id, 700, 'confirmed');
  addPledge(s.sqlite, addDare(s.sqlite, daniel, 'rejected').id, 2000, 'confirmed');
  addPledge(s.sqlite, addDare(s.sqlite, targetId(s.sqlite, 'ted')).id, 4000, 'confirmed');
  exec(s.sqlite, "UPDATE targets SET active = 0 WHERE slug = 'ted'");
  return s;
}

test('a dare board total on the board counts confirmed donations on listed dares of visible walkers only', async () => {
  const board = await getBoard(boardWithMoneyThatDoesNotCount());
  assert.equal(board.data.total_pence, 1000);
});

test('a dare board total on the site card matches the board', async () => {
  const card = await cardFor(boardWithMoneyThatDoesNotCount(), 'dartmoor');
  assert.equal(card.total_pence, 1000);
  assert.equal(card.dares, 1);
});

test('a dare board total on the admin page matches the board', async () => {
  const s = boardWithMoneyThatDoesNotCount();
  const dartmoor = (await s.admin('GET', '/api/admin/overview')).data.fundraisers.find((f) => f.id === 1);
  assert.equal(dartmoor.total_pence, 1000);
  assert.equal(dartmoor.dares, 1);
});

test('the site card counts dares on the group list while it is switched on', async () => {
  const s = site();
  addDare(s.sqlite, groupOf(s.sqlite, 1));
  addDare(s.sqlite, targetId(s.sqlite, 'daniel'));
  assert.equal((await cardFor(s, 'dartmoor')).dares, 2);
  await updateFundraiser(s, 1, { group_enabled: false });
  assert.equal((await cardFor(s, 'dartmoor')).dares, 1);
});

test('a dare board ignores a typed-in total', async () => {
  const s = site();
  exec(s.sqlite, 'UPDATE fundraisers SET manual_total_pence = 99900 WHERE id = 1');
  assert.equal((await cardFor(s, 'dartmoor')).total_pence, 0);
});

test('an event total is the figure a leader typed in', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage({ manual_total: '110', target: '300' }));
  const card = await cardFor(s, quiz.slug);
  assert.equal(card.total_pence, 11000);
  assert.equal(card.target_pence, 30000);
  assert.equal(card.percent, 36);
});

test('a challenge total is the figure a leader typed in', async () => {
  const s = site();
  const walk = await createFundraiser(s, eventPage({ type: 'challenge', title: 'Sponsored Walk', manual_total: '52.39' }));
  assert.equal((await cardFor(s, walk.slug)).total_pence, 5239);
});

test('percent is rounded down', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage({ manual_total: '299.99', target: '300' }));
  assert.equal((await cardFor(s, quiz.slug)).percent, 99);
});

test('percent is left out when there is no target', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage({ manual_total: '110', target: '' }));
  assert.equal((await cardFor(s, quiz.slug)).percent, null);
});

test('a dare board shows its percent of the target', async () => {
  const s = boardWithMoneyThatDoesNotCount();
  await updateFundraiser(s, 1, { target: '40' });
  const board = await getBoard(s);
  assert.equal(board.data.fundraiser.target_pence, 4000);
  assert.equal(board.data.fundraiser.percent, 25);
  assert.equal((await cardFor(s, 'dartmoor')).percent, 25);
});

test('/api/site gives each fundraiser a card', async () => {
  const s = site();
  await createFundraiser(s, eventPage({ summary: 'Trivia and prizes.', event_date: 'Thursday 3 December', place: 'Students\' Union', photo_url: 'https://example.org/quiz.jpg' }));
  assert.deepEqual(await cardFor(s, 'quiz-night'), {
    slug: 'quiz-night', title: 'Quiz Night', type: 'event', summary: 'Trivia and prizes.', photo_url: 'https://example.org/quiz.jpg',
    event_date: 'Thursday 3 December', place: 'Students\' Union', status: 'live', total_pence: 0, target_pence: 0, percent: null,
  });
});

test('/api/site gives a dare board card its dare count and whether it is closed', async () => {
  const card = await cardFor(site(), 'dartmoor');
  assert.equal(card.type, 'dare');
  assert.equal(card.dares, 0);
  assert.equal(card.closed, false);
});

test('/api/site lists fundraisers in the order the leaders chose', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  const walk = await createFundraiser(s, eventPage({ type: 'challenge', title: 'Sponsored Walk' }));
  const order = async () => (await s.api('GET', '/api/site')).data.fundraisers.map((card) => card.slug);
  assert.deepEqual(await order(), ['dartmoor', 'quiz-night', 'sponsored-walk']);
  assert.equal((await s.admin('PUT', '/api/admin/fundraisers/order', { ids: [walk.id, 1, quiz.id] })).status, 200);
  assert.deepEqual(await order(), ['sponsored-walk', 'dartmoor', 'quiz-night']);
});

test('/api/site lists a finished fundraiser', async () => {
  const s = site();
  await createFundraiser(s, eventPage({ title: 'Bake Sale', status: 'finished' }));
  assert.equal((await cardFor(s, 'bake-sale')).status, 'finished');
});

test('/api/site features the fundraiser the leaders chose', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  assert.equal((await s.api('GET', '/api/site')).data.featured, 'dartmoor');
  assert.equal((await s.admin('PUT', '/api/admin/featured', { id: quiz.id })).status, 200);
  assert.equal((await s.api('GET', '/api/site')).data.featured, 'quiz-night');
});

for (const status of ['finished', 'draft']) {
  test(`/api/site features the first live fundraiser when the chosen one is ${status}`, async () => {
    const s = site();
    const quiz = await createFundraiser(s, eventPage());
    await s.admin('PUT', '/api/admin/featured', { id: quiz.id });
    assert.equal((await updateFundraiser(s, quiz.id, { status })).status, 200);
    assert.equal((await s.api('GET', '/api/site')).data.featured, 'dartmoor');
  });
}

test('/api/site features nothing when no fundraiser is live', async () => {
  const s = site();
  await updateFundraiser(s, 1, { status: 'finished' });
  assert.equal((await s.api('GET', '/api/site')).data.featured, null);
});

test('/api/site?page=about adds the About text', async () => {
  const s = site();
  await s.admin('PUT', '/api/admin/site', { about_text: 'Who we are.\n\nWhat we do.' });
  assert.deepEqual((await s.api('GET', '/api/site?page=about')).data.page, { body: 'Who we are.\n\nWhat we do.' });
});

test('/api/site?page=<unknown> is not found', async () => {
  assert.equal((await site().api('GET', '/api/site?page=secrets')).status, 404);
});

/* Drafts */

// A draft dare board with one approved dare on its group list and one on a walker's.
async function draftBoard() {
  const s = site();
  const secret = await createFundraiser(s, dareBoard({ title: 'Secret Dares', status: 'draft', copy_walkers_from: 1 }));
  const group = groupOf(s.sqlite, secret.id);
  const walker = walkersOf(s.sqlite, secret.id)[0].id;
  return { ...s, secret, group, walker, groupDare: addDare(s.sqlite, group), walkerDare: addDare(s.sqlite, walker) };
}

async function addLeader(s, name = 'Emma') {
  const created = await s.admin('POST', '/api/admin/logins', { name });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { id } = row(s.sqlite, 'SELECT id FROM admins WHERE name = ?', name);
  return { id, key: created.data.key };
}

test('/api/site leaves drafts out', async () => {
  const s = await draftBoard();
  const { data } = await s.api('GET', '/api/site');
  assert.deepEqual(data.fundraisers.map((card) => card.slug), ['dartmoor']);
  assert.doesNotMatch(JSON.stringify(data), /Secret Dares|Plymouth Hoe/);
});

test('/api/site leaves drafts out even for a signed-in leader', async () => {
  const s = await draftBoard();
  const { data } = await s.admin('GET', '/api/site');
  assert.deepEqual(data.fundraisers.map((card) => card.slug), ['dartmoor']);
});

for (const path of ['/api/fundraisers/plymouth-hoe', '/api/fundraisers/secret-dares', '/api/board?f=secret-dares']) {
  test(`${path} is not found for the public while it is a draft`, async () => {
    const s = await draftBoard();
    const answer = await s.api('GET', path);
    assert.equal(answer.status, 404);
    assert.doesNotMatch(JSON.stringify(answer.data), /Secret|Hoe/);
  });

  test(`${path} is not found with a wrong password`, async () => {
    const s = await draftBoard();
    assert.equal((await s.api('GET', path, undefined, 'not-the-password')).status, 404);
  });

  test(`${path} shows the draft to the owner as a preview`, async () => {
    const s = await draftBoard();
    const answer = await s.admin('GET', path);
    assert.equal(answer.status, 200);
    assert.equal(answer.data.preview, true);
    assert.equal(answer.data.fundraiser.status, 'draft');
  });

  test(`${path} shows the draft to a leader as a preview`, async () => {
    const s = await draftBoard();
    const leader = await addLeader(s);
    const answer = await s.api('GET', path, undefined, leader.key);
    assert.equal(answer.status, 200);
    assert.equal(answer.data.preview, true);
  });
}

test('a live fundraiser is not marked as a preview, signed in or not', async () => {
  const s = site();
  assert.equal((await s.api('GET', '/api/fundraisers/dartmoor')).data.preview, false);
  assert.equal((await s.admin('GET', '/api/fundraisers/dartmoor')).data.preview, false);
});

test('a draft board preview includes its lists and dares', async () => {
  const s = await draftBoard();
  const board = await getBoard(s, 'secret-dares', PASSWORD);
  assert.equal(listOn(board, 'secret-dares-group').dares[0].code, s.groupDare.code);
  assert.equal(board.data.closed, true, 'a draft takes no dares yet');
});

test('a draft board refuses a suggested dare', async () => {
  const s = await draftBoard();
  const before = count(s.sqlite, 'dares');
  const answer = await s.api('POST', '/api/dares', { target_id: s.group, title: 'Sneak a dare in early' });
  assert.equal(answer.status, 400);
  assert.equal(count(s.sqlite, 'dares'), before);
});

test('a draft board answers a suggested dare the same as an unknown list', async () => {
  const s = await draftBoard();
  const draft = await s.api('POST', '/api/dares', { target_id: s.group, title: 'Sneak a dare in early' });
  const unknown = await s.api('POST', '/api/dares', { target_id: 9999, title: 'Sneak a dare in early' });
  assert.deepEqual([draft.status, draft.data], [unknown.status, unknown.data]);
});

test('a draft board refuses a logged donation', async () => {
  const s = await draftBoard();
  const answer = await s.api('POST', '/api/pledges', { code: s.walkerDare.code, amount: '5' });
  assert.equal(answer.status, 404);
  assert.equal(count(s.sqlite, 'pledges'), 0);
});

test('a draft board refuses a vote', async () => {
  const s = await draftBoard();
  const answer = await s.api('POST', '/api/votes', { code: s.groupDare.code, voter: voter(1) });
  assert.equal(answer.status, 404);
  assert.equal(count(s.sqlite, 'votes'), 0);
});

test('a draft board takes dares once it is made live', async () => {
  const s = await draftBoard();
  assert.equal((await updateFundraiser(s, s.secret.id, { status: 'live' })).status, 200);
  assert.equal((await s.api('POST', '/api/dares', { target_id: s.group, title: 'Now it is allowed' })).status, 201);
  assert.equal((await s.api('GET', '/api/board?f=secret-dares')).status, 200);
});

/* Pages at /f/<slug> */

const getPage = (s, path, method = 'GET') => s.api(method, path);

test('/f/<dare board> serves the board page', async () => {
  const page = await getPage(site(), '/f/dartmoor');
  assert.equal(page.status, 200);
  assert.equal(page.data, '<html>/board</html>');
  assert.equal(page.headers.get('x-robots-tag'), null);
});

test('/f/<event> serves the fundraiser page', async () => {
  const s = site();
  await createFundraiser(s, eventPage());
  const page = await getPage(s, '/f/quiz-night');
  assert.equal(page.status, 200);
  assert.equal(page.data, '<html>/fundraiser</html>');
});

test('/f/<draft> serves the page but tells search engines to stay away', async () => {
  const page = await getPage(site(), '/f/plymouth-hoe');
  assert.equal(page.status, 200);
  assert.equal(page.data, '<html>/fundraiser</html>');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
});

test('/f/<draft dare board> serves the board page with noindex', async () => {
  const s = await draftBoard();
  const page = await getPage(s, '/f/secret-dares');
  assert.equal(page.data, '<html>/board</html>');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
});

test('/f/<unknown> is a 404 with the not-found page', async () => {
  const page = await getPage(site(), '/f/nope');
  assert.equal(page.status, 404);
  assert.equal(page.data, '<html>/404</html>');
});

test('/f/<slug>/ works with a trailing slash', async () => {
  assert.equal((await getPage(site(), '/f/dartmoor/')).status, 200);
});

test('/f/ pages are never served from a stale cache', async () => {
  assert.equal((await getPage(site(), '/f/dartmoor')).headers.get('cache-control'), 'no-cache');
});

test('/f/<slug> refuses anything but GET and HEAD', async () => {
  assert.equal((await getPage(site(), '/f/dartmoor', 'POST')).status, 405);
});

test('other paths go straight to the static files', async () => {
  const page = await getPage(site(), '/about');
  assert.equal(page.data, '<html>/about</html>');
});

// Node has no HTMLRewriter, so the worker normally skips it here. This one only
// notes what the worker asks to be written into the page, keyed by selector.
function fakeHtmlRewriter(t) {
  const written = [];
  globalThis.HTMLRewriter = class {
    #handlers = [];

    on(selector, handler) {
      this.#handlers.push([selector, handler]);
      return this;
    }

    transform(response) {
      const page = {};
      const element = (selector) => ({
        setInnerContent(text) { page[selector] = text; },
        setAttribute(name, value) { page[selector] = value; },
      });
      for (const [selector, handler] of this.#handlers) handler.element(element(selector));
      written.push(page);
      return response;
    }
  };
  t.after(() => { delete globalThis.HTMLRewriter; });
  return written;
}

test('/f/<slug> writes the fundraiser\'s title and summary into the page for link previews', async (t) => {
  const written = fakeHtmlRewriter(t);
  const s = site();
  await createFundraiser(s, eventPage({ summary: 'Trivia and prizes.' }));
  await getPage(s, '/f/quiz-night');
  assert.equal(written.length, 1);
  // The worker may fill in other parts of the page too. These are the ones a shared link needs.
  const wanted = {
    title: 'Quiz Night | Sponsor University of Plymouth',
    'meta[name="description"]': 'Trivia and prizes.',
    'meta[property="og:title"]': 'Quiz Night',
    'meta[property="og:description"]': 'Trivia and prizes.',
    'meta[property="og:url"]': 'http://test/f/quiz-night',
  };
  for (const [selector, text] of Object.entries(wanted)) assert.equal(written[0][selector], text, selector);
  assert.equal(written[0]['meta[property="og:image"]'], undefined, 'no photo, so the page keeps its own image');
});

test('/f/<slug> uses the fundraiser\'s photo as the preview image when it has one', async (t) => {
  const written = fakeHtmlRewriter(t);
  const s = site();
  await createFundraiser(s, eventPage({ photo_url: 'https://example.org/quiz.jpg' }));
  await getPage(s, '/f/quiz-night');
  assert.equal(written[0]['meta[property="og:image"]'], 'https://example.org/quiz.jpg');
});

test('/f/<draft> writes nothing about the draft into the page', async (t) => {
  const written = fakeHtmlRewriter(t);
  await getPage(site(), '/f/plymouth-hoe');
  assert.deepEqual(written, []);
});

test('/f/<unknown> is not rewritten', async (t) => {
  const written = fakeHtmlRewriter(t);
  await getPage(site(), '/f/nope');
  assert.deepEqual(written, []);
});

/* Finished and closed boards */

const ENDINGS = {
  finished: { status: 'finished' },
  closed: { closes_at: '2020-01-01T00:00:00.000Z' },
};

// The Dartmoor board with an approved dare on the group list and one on Daniel's, then ended.
async function endedBoard(ending) {
  const s = site();
  const group = groupOf(s.sqlite, 1);
  const dares = { groupDare: addDare(s.sqlite, group), walkerDare: addDare(s.sqlite, targetId(s.sqlite, 'daniel')) };
  assert.equal((await updateFundraiser(s, 1, ENDINGS[ending])).status, 200);
  return { ...s, group, ...dares };
}

for (const ending of Object.keys(ENDINGS)) {
  test(`a ${ending} board refuses a suggested dare with 403`, async () => {
    const s = await endedBoard(ending);
    assert.equal((await s.api('POST', '/api/dares', { target_id: s.group, title: 'Too late for this' })).status, 403);
    assert.equal(count(s.sqlite, 'dares'), 2);
  });

  test(`a ${ending} board refuses a logged donation with 403`, async () => {
    const s = await endedBoard(ending);
    assert.equal((await s.api('POST', '/api/pledges', { code: s.walkerDare.code, amount: '5' })).status, 403);
    assert.equal(count(s.sqlite, 'pledges'), 0);
  });

  test(`a ${ending} board refuses a vote with 403`, async () => {
    const s = await endedBoard(ending);
    assert.equal((await s.api('POST', '/api/votes', { code: s.groupDare.code, voter: voter(1) })).status, 403);
    assert.equal(count(s.sqlite, 'votes'), 0);
  });

  test(`a ${ending} board still lets a leader add a late donation`, async () => {
    const s = await endedBoard(ending);
    assert.equal((await s.admin('POST', '/api/admin/pledges', { code: s.walkerDare.code, amount: '7.50' })).status, 201);
    assert.equal((await getBoard(s)).data.total_pence, 750);
  });

  test(`a ${ending} board is still shown, marked as closed`, async () => {
    const s = await endedBoard(ending);
    const board = await getBoard(s);
    assert.equal(board.status, 200);
    assert.equal(board.data.closed, true);
    assert.equal((await cardFor(s, 'dartmoor')).closed, true);
  });
}

test('a board with a closing time still to come takes dares', async () => {
  const s = site();
  await updateFundraiser(s, 1, { closes_at: '2999-01-01T00:00:00.000Z' });
  assert.equal((await s.api('POST', '/api/dares', { target_id: groupOf(s.sqlite, 1), title: 'Plenty of time' })).status, 201);
});

/* Dares, donations and votes on a live board */

// The Dartmoor board with an approved dare on the group list and one on Daniel's.
function liveBoard() {
  const s = site();
  const group = groupOf(s.sqlite, 1);
  const daniel = targetId(s.sqlite, 'daniel');
  return { ...s, group, daniel, groupDare: addDare(s.sqlite, group), walkerDare: addDare(s.sqlite, daniel) };
}

test('a suggested dare waits for approval before it shows', async () => {
  const s = liveBoard();
  await s.api('POST', '/api/dares', { target_id: s.daniel, title: 'Walk backwards for a mile' });
  assert.doesNotMatch(JSON.stringify((await getBoard(s)).data), /Walk backwards/);
  const waiting = (await s.admin('GET', '/api/admin/overview')).data.queue.dares;
  assert.deepEqual(waiting.map((dare) => dare.title), ['Walk backwards for a mile']);
});

test('a logged donation does not count until it is confirmed', async () => {
  const s = liveBoard();
  await s.api('POST', '/api/pledges', { code: s.walkerDare.code, amount: '£50' });
  const dare = listOn(await getBoard(s), 'daniel').dares[0];
  assert.equal(dare.total_pence, 0);
  assert.equal(dare.pending_pence, 5000);
});

test('a second vote from the same browser takes the vote back', async () => {
  const s = liveBoard();
  const vote = () => s.api('POST', '/api/votes', { code: s.groupDare.code, voter: voter(1) });
  assert.deepEqual((await vote()).data, { voted: true });
  assert.deepEqual((await vote()).data, { voted: false });
  assert.equal(count(s.sqlite, 'votes'), 0);
});

test('group dares take no money from donors or leaders', async () => {
  const s = liveBoard();
  assert.equal((await s.api('POST', '/api/pledges', { code: s.groupDare.code, amount: '5' })).status, 400);
  assert.equal((await s.admin('POST', '/api/admin/pledges', { code: s.groupDare.code, amount: '5' })).status, 400);
});

test('walker dares take no votes', async () => {
  const s = liveBoard();
  assert.equal((await s.api('POST', '/api/votes', { code: s.walkerDare.code, voter: voter(1) })).status, 404);
});

test('a board with its group list switched off hides it and refuses group dares and votes', async () => {
  const s = liveBoard();
  await updateFundraiser(s, 1, { group_enabled: false });
  assert.equal(listOn(await getBoard(s), 'group'), undefined);
  assert.equal((await s.api('POST', '/api/dares', { target_id: s.group, title: 'A group dare' })).status, 400);
  assert.equal((await s.api('POST', '/api/votes', { code: s.groupDare.code, voter: voter(1) })).status, 400);
});

test('a dare cannot be suggested for a hidden walker', async () => {
  const s = liveBoard();
  exec(s.sqlite, 'UPDATE targets SET active = 0 WHERE id = ?', s.daniel);
  assert.equal((await s.api('POST', '/api/dares', { target_id: s.daniel, title: 'For someone not walking' })).status, 400);
});

// A donor can still have the code of a dare the board no longer shows.
test('a donation cannot be logged on a hidden walker\'s dare', async () => {
  const s = liveBoard();
  exec(s.sqlite, 'UPDATE targets SET active = 0 WHERE id = ?', s.daniel);
  const answer = await s.api('POST', '/api/pledges', { code: s.walkerDare.code, amount: '5' });
  assert.equal(answer.status, 404);
  assert.equal(count(s.sqlite, 'pledges'), 0);
});

// Only /api/board falls back to the Dartmoor board when no fundraiser is named.
test('/api/fundraisers/ with no slug is not found', async () => {
  assert.equal((await site().api('GET', '/api/fundraisers/')).status, 404);
});

test('/api/board?f= with an empty slug is not found', async () => {
  assert.equal((await site().api('GET', '/api/board?f=')).status, 404);
});

/* Signing in */

test('the admin API refuses a request with no password', async () => {
  assert.equal((await site().api('GET', '/api/admin/overview')).status, 401);
});

test('the admin API refuses a wrong password', async () => {
  assert.equal((await site().api('GET', '/api/admin/overview', undefined, 'not-the-password')).status, 401);
});

test('the admin API refuses a made-up leader key', async () => {
  const madeUp = `leader-${'a'.repeat(40)}`;
  assert.equal((await site().api('GET', '/api/admin/overview', undefined, madeUp)).status, 401);
});

test('the owner signs in with ADMIN_PASSWORD', async () => {
  const overview = await site().admin('GET', '/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.me, { name: 'Owner', role: 'owner' });
});

test('the admin overview has everything the admin page reads', async () => {
  const { data } = await site().admin('GET', '/api/admin/overview');
  assert.deepEqual(Object.keys(data).sort(), ['everest', 'featured_id', 'fundraisers', 'me', 'queue', 'site']);
  assert.deepEqual(Object.keys(data.queue).sort(), ['dares', 'pledges']);
  assert.deepEqual(data.fundraisers.map((f) => [f.id, f.slug, f.status]), [[1, 'dartmoor', 'live'], [2, 'plymouth-hoe', 'draft']]);
  assert.equal(data.featured_id, 1);
});

test('the admin API is switched off when no password has been set', async () => {
  const s = site();
  delete s.env.ADMIN_PASSWORD;
  assert.equal((await s.api('GET', '/api/admin/overview', undefined, PASSWORD)).status, 503);
});

test('a new leader key is shown once and has the leader key shape', async () => {
  const s = site();
  const created = await s.admin('POST', '/api/admin/logins', { name: 'Emma' });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'Emma');
  assert.match(created.data.key, /^leader-[2-9a-hjkmnp-z]{40}$/);
  assert.doesNotMatch(JSON.stringify((await s.admin('GET', '/api/admin/logins')).data), /leader-/);
});

test('a leader key is stored only as its SHA-256 hash', async () => {
  const s = site();
  const leader = await addLeader(s);
  const stored = rows(s.sqlite, 'SELECT * FROM admins');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key_hash, createHash('sha256').update(leader.key).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(leader.key));
  assert.ok(!JSON.stringify(stored).includes(leader.key.slice('leader-'.length)));
});

test('a leader signs in with their key', async () => {
  const s = site();
  const leader = await addLeader(s);
  const overview = await s.api('GET', '/api/admin/overview', undefined, leader.key);
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.me, { name: 'Emma', role: 'leader' });
});

test('a leader can do ordinary admin work', async () => {
  const s = site();
  const leader = await addLeader(s);
  assert.equal((await s.api('POST', '/api/admin/fundraisers', eventPage(), leader.key)).status, 201);
  assert.equal((await s.api('PUT', '/api/admin/site', { site_intro: 'Hello.' }, leader.key)).status, 200);
});

for (const [method, path, body] of [['GET', '/api/admin/logins'], ['POST', '/api/admin/logins', { name: 'Friend' }], ['PUT', '/api/admin/logins/1']]) {
  test(`a leader gets 403 from ${method} ${path}`, async () => {
    const s = site();
    const leader = await addLeader(s);
    assert.equal((await s.api(method, path, body, leader.key)).status, 403);
    assert.equal(count(s.sqlite, 'admins'), 1);
    assert.equal(row(s.sqlite, 'SELECT revoked FROM admins').revoked, 0);
  });
}

test('a revoked leader key gets 401', async () => {
  const s = site();
  const leader = await addLeader(s);
  assert.equal((await s.admin('PUT', `/api/admin/logins/${leader.id}`)).status, 200);
  assert.equal((await s.api('GET', '/api/admin/overview', undefined, leader.key)).status, 401);
});

test('revoking one leader leaves the others signed in', async () => {
  const s = site();
  const emma = await addLeader(s, 'Emma');
  const jack = await addLeader(s, 'Jack');
  await s.admin('PUT', `/api/admin/logins/${emma.id}`);
  assert.equal((await s.api('GET', '/api/admin/overview', undefined, jack.key)).status, 200);
});

test('revoking a login that does not exist is a 404', async () => {
  assert.equal((await site().admin('PUT', '/api/admin/logins/99')).status, 404);
});

test('a leader login needs a name', async () => {
  assert.equal((await site().admin('POST', '/api/admin/logins', { name: '  ' })).status, 400);
});

test('a dare approved by a leader records the leader\'s name', async () => {
  const s = liveBoard();
  const leader = await addLeader(s);
  const waiting = addDare(s.sqlite, s.daniel, 'pending');
  assert.equal((await s.api('PUT', `/api/admin/dares/${waiting.id}`, { status: 'approved' }, leader.key)).status, 200);
  assert.deepEqual(row(s.sqlite, 'SELECT status, reviewed_by FROM dares WHERE id = ?', waiting.id), { status: 'approved', reviewed_by: 'Emma' });
});

test('a dare approved by the owner is recorded as Owner', async () => {
  const s = liveBoard();
  const waiting = addDare(s.sqlite, s.daniel, 'pending');
  await s.admin('PUT', `/api/admin/dares/${waiting.id}`, { status: 'approved' });
  assert.equal(row(s.sqlite, 'SELECT reviewed_by FROM dares WHERE id = ?', waiting.id).reviewed_by, 'Owner');
});

test('the admin page shows who approved each dare', async () => {
  const s = liveBoard();
  const leader = await addLeader(s);
  const waiting = addDare(s.sqlite, s.daniel, 'pending');
  await s.api('PUT', `/api/admin/dares/${waiting.id}`, { status: 'approved' }, leader.key);
  const { dares } = (await s.admin('GET', '/api/admin/fundraisers/1')).data;
  assert.equal(dares.find((dare) => dare.id === waiting.id).reviewed_by, 'Emma');
});

test('a donation confirmed by a leader records the leader\'s name', async () => {
  const s = liveBoard();
  const leader = await addLeader(s);
  const pledge = addPledge(s.sqlite, s.walkerDare.id, 500, 'unconfirmed');
  assert.equal((await s.api('PUT', `/api/admin/pledges/${pledge}`, { status: 'confirmed' }, leader.key)).status, 200);
  assert.deepEqual(row(s.sqlite, 'SELECT status, reviewed_by FROM pledges WHERE id = ?', pledge), { status: 'confirmed', reviewed_by: 'Emma' });
});

test('a donation added by a leader records the leader\'s name', async () => {
  const s = liveBoard();
  const leader = await addLeader(s);
  await s.api('POST', '/api/admin/pledges', { code: s.walkerDare.code, amount: '12' }, leader.key);
  assert.deepEqual(row(s.sqlite, 'SELECT amount_pence, source, status, reviewed_by FROM pledges'), {
    amount_pence: 1200, source: 'admin', status: 'confirmed', reviewed_by: 'Emma',
  });
});

test('a status that is not allowed is refused', async () => {
  const s = liveBoard();
  assert.equal((await s.admin('PUT', `/api/admin/dares/${s.walkerDare.id}`, { status: 'pending' })).status, 400);
});

test('ten wrong passwords lock the admin API for that address, even for the right password', async () => {
  const s = site();
  for (let attempt = 1; attempt <= 10; attempt++) {
    assert.equal((await s.api('GET', '/api/admin/overview', undefined, 'not-the-password')).status, 401, `attempt ${attempt}`);
  }
  assert.equal((await s.api('GET', '/api/admin/overview', undefined, 'not-the-password')).status, 429);
  assert.equal((await s.admin('GET', '/api/admin/overview')).status, 429);
});

test('nine wrong passwords do not lock the owner out', async () => {
  const s = site();
  for (let attempt = 1; attempt <= 9; attempt++) await s.api('GET', '/api/admin/overview', undefined, 'not-the-password');
  assert.equal((await s.admin('GET', '/api/admin/overview')).status, 200);
});

/* The Everest total, read from JustGiving */

const DANIEL = { grandTotalRaisedExcludingGiftAid: '252.39', fundraisingTarget: '4580', owner: 'Daniel Rea' };
const EMMA = { grandTotalRaisedExcludingGiftAid: '100.00', fundraisingTarget: '3000', owner: 'Emma Binda' };

// A site whose Everest list is exactly two pages, with JustGiving faked.
function everestSite(t, pages = { 'daniel-page': DANIEL, 'emma-page': EMMA }) {
  const s = site({ justGiving: true });
  exec(s.sqlite, 'DELETE FROM everest_pages');
  for (const name of ['daniel-page', 'emma-page']) exec(s.sqlite, 'INSERT INTO everest_pages (short_name) VALUES (?)', name);
  return { ...s, justGiving: stubJustGiving(t, pages) };
}

const everest = async (s) => (await s.api('GET', '/api/site')).data.everest;
const checkedAt = (sqlite) => Number(row(sqlite, "SELECT value FROM settings WHERE key = 'everest_checked_at'").value);
const makeRefreshDue = (sqlite) => exec(sqlite, "UPDATE settings SET value = ? WHERE key = 'everest_checked_at'", String(Date.now() - 16 * MINUTE));
const cachedPages = (sqlite) => rows(sqlite, 'SELECT short_name, owner, raised_pence, target_pence, failed FROM everest_pages ORDER BY rowid');

test('the first visit reads every JustGiving page and returns the sum', async (t) => {
  const s = everestSite(t);
  const total = await everest(s);
  assert.deepEqual(s.justGiving.requests.sort(), ['daniel-page', 'emma-page']);
  assert.equal(total.raised_pence, 35239);
  assert.equal(total.target_pence, 758000);
  assert.equal(total.pages, 2);
  assert.equal(total.percent, 4);
});

test('the first visit saves the figures it read', async (t) => {
  const s = everestSite(t);
  await everest(s);
  assert.deepEqual(cachedPages(s.sqlite), [
    { short_name: 'daniel-page', owner: 'Daniel Rea', raised_pence: 25239, target_pence: 458000, failed: 0 },
    { short_name: 'emma-page', owner: 'Emma Binda', raised_pence: 10000, target_pence: 300000, failed: 0 },
  ]);
});

test('a second visit within 15 minutes makes no JustGiving requests', async (t) => {
  const s = everestSite(t);
  const first = await everest(s);
  s.justGiving.requests.length = 0;
  const second = await everest(s);
  assert.deepEqual(s.justGiving.requests, []);
  assert.deepEqual(second, first);
});

test('a visit after 15 minutes gets the saved figures at once and refreshes them afterwards', async (t) => {
  const s = everestSite(t);
  await everest(s);
  s.justGiving.pages['daniel-page'] = { ...DANIEL, grandTotalRaisedExcludingGiftAid: '300.00' };
  makeRefreshDue(s.sqlite);

  assert.equal((await everest(s)).raised_pence, 35239, 'the visitor is not kept waiting for JustGiving');
  assert.equal(s.pending.length, 1);
  await s.settle();
  assert.equal((await everest(s)).raised_pence, 40000);
});

test('two visits arriving together after 15 minutes cause one refresh, not two', async (t) => {
  const s = everestSite(t);
  await everest(s);
  s.justGiving.requests.length = 0;
  makeRefreshDue(s.sqlite);

  const totals = await Promise.all([everest(s), everest(s)]);
  await s.settle();
  assert.deepEqual(totals.map((total) => total.raised_pence), [35239, 35239]);
  assert.equal(s.justGiving.requests.length, 2, 'one request for each of the two pages');
});

test('when JustGiving is down the saved figures are kept and still returned', async (t) => {
  const s = everestSite(t);
  await everest(s);
  s.justGiving.down = true;
  makeRefreshDue(s.sqlite);

  assert.equal((await everest(s)).raised_pence, 35239);
  await s.settle();
  assert.deepEqual(cachedPages(s.sqlite).map((page) => [page.raised_pence, page.failed]), [[25239, 1], [10000, 1]]);
  assert.equal((await everest(s)).raised_pence, 35239);
});

test('when one page fails it keeps its figures and the others are updated', async (t) => {
  const s = everestSite(t);
  await everest(s);
  delete s.justGiving.pages['daniel-page'];
  s.justGiving.pages['emma-page'] = { ...EMMA, grandTotalRaisedExcludingGiftAid: '150.00' };
  makeRefreshDue(s.sqlite);
  await everest(s);
  await s.settle();

  assert.deepEqual(cachedPages(s.sqlite).map((page) => [page.raised_pence, page.failed]), [[25239, 1], [15000, 0]]);
  assert.equal((await everest(s)).raised_pence, 40239);
});

test('with no saved figures and JustGiving down, everest is null', async (t) => {
  const s = everestSite(t);
  s.justGiving.down = true;
  assert.equal(await everest(s), null);
  assert.equal(s.justGiving.requests.length, 2);
});

test('after JustGiving fails altogether the next try is a minute later, not 15', async (t) => {
  const s = everestSite(t);
  s.justGiving.down = true;
  const before = Date.now();
  await everest(s);
  const retryAt = checkedAt(s.sqlite) + 15 * MINUTE;
  assert.ok(retryAt >= before + MINUTE && retryAt <= Date.now() + MINUTE, String(retryAt - before));

  s.justGiving.requests.length = 0;
  await everest(s);
  assert.deepEqual(s.justGiving.requests, [], 'no second try straight away');
});

test('a page JustGiving answers without a total counts as failed', async (t) => {
  const s = everestSite(t, { 'daniel-page': DANIEL, 'emma-page': { owner: 'Emma Binda' } });
  const total = await everest(s);
  assert.equal(total.pages, 1);
  assert.equal(total.raised_pence, 25239);
  assert.deepEqual(cachedPages(s.sqlite)[1], { short_name: 'emma-page', owner: '', raised_pence: null, target_pence: null, failed: 1 });
});

test('without a JustGiving key nothing is requested and everest is null', async () => {
  const s = site();
  assert.equal(await everest(s), null);
  assert.equal(checkedAt(s.sqlite), 0);
});

test('with no pages on the list nothing is requested and everest is null', async (t) => {
  const s = everestSite(t);
  exec(s.sqlite, 'DELETE FROM everest_pages');
  assert.equal(await everest(s), null);
  assert.deepEqual(s.justGiving.requests, []);
});

test('the admin overview shows each page with its figures', async (t) => {
  const s = everestSite(t);
  await everest(s);
  const overview = (await s.admin('GET', '/api/admin/overview')).data.everest;
  assert.equal(overview.has_key, true);
  assert.deepEqual(overview.pages.map((page) => [page.short_name, page.owner, page.raised_pence]), [['daniel-page', 'Daniel Rea', 25239], ['emma-page', 'Emma Binda', 10000]]);
  assert.equal(overview.summary.raised_pence, 35239);
});

const addEverestPage = (s, url) => s.admin('POST', '/api/admin/everest/pages', { url });

test('adding a page checks it with JustGiving and saves its figures', async (t) => {
  const s = everestSite(t, { 'jack-page': { grandTotalRaisedExcludingGiftAid: '40', fundraisingTarget: '2000', owner: 'Jack de Vere' } });
  const added = await addEverestPage(s, 'https://www.justgiving.com/fundraising/jack-page');
  assert.equal(added.status, 201);
  assert.deepEqual(s.justGiving.requests, ['jack-page']);
  assert.deepEqual(cachedPages(s.sqlite).at(-1), { short_name: 'jack-page', owner: 'Jack de Vere', raised_pence: 4000, target_pence: 200000, failed: 0 });
});

test('adding a page JustGiving does not have is refused with 400', async (t) => {
  const s = everestSite(t, {});
  const added = await addEverestPage(s, 'https://www.justgiving.com/fundraising/no-such-page');
  assert.equal(added.status, 400);
  assert.equal(count(s.sqlite, 'everest_pages'), 2);
});

test('adding a page while JustGiving is down is refused with 502', async (t) => {
  const s = everestSite(t);
  s.justGiving.down = true;
  assert.equal((await addEverestPage(s, 'https://www.justgiving.com/fundraising/jack-page')).status, 502);
  assert.equal(count(s.sqlite, 'everest_pages'), 2);
});

test('adding a page that is already on the list is refused without asking JustGiving', async (t) => {
  const s = everestSite(t);
  assert.equal((await addEverestPage(s, 'https://www.justgiving.com/page/Daniel-Page')).status, 400);
  assert.deepEqual(s.justGiving.requests, []);
});

test('adding a link that is not a JustGiving page is refused without asking JustGiving', async (t) => {
  const s = everestSite(t);
  assert.equal((await addEverestPage(s, 'https://evil.test/fundraising/jack-page')).status, 400);
  assert.deepEqual(s.justGiving.requests, []);
});

test('without a JustGiving key a page is added with no figures', async () => {
  const s = site();
  assert.equal((await addEverestPage(s, 'new-page')).status, 201);
  assert.deepEqual(cachedPages(s.sqlite).at(-1), { short_name: 'new-page', owner: '', raised_pence: null, target_pence: null, failed: 0 });
});

test('a page can be taken off the list', async (t) => {
  const s = everestSite(t);
  assert.equal((await s.admin('DELETE', '/api/admin/everest/pages/emma-page')).status, 200);
  assert.deepEqual(cachedPages(s.sqlite).map((page) => page.short_name), ['daniel-page']);
  assert.equal((await s.admin('DELETE', '/api/admin/everest/pages/emma-page')).status, 404);
});

test('a leader can refresh the figures by hand and is told how many pages failed', async (t) => {
  const s = everestSite(t, { 'daniel-page': DANIEL });
  const refreshed = await s.admin('POST', '/api/admin/everest/refresh');
  assert.deepEqual(refreshed.data, { ok: true, failed: 1 });
  assert.equal(cachedPages(s.sqlite)[0].raised_pence, 25239);
});

test('refreshing by hand needs the JustGiving key', async () => {
  assert.equal((await site().admin('POST', '/api/admin/everest/refresh')).status, 503);
});

/* What a leader may save */

test('a photo link must be https', async () => {
  const s = site();
  assert.equal((await s.admin('POST', '/api/admin/fundraisers', eventPage({ photo_url: 'http://example.org/quiz.jpg' }))).status, 400);
  assert.equal((await s.admin('POST', '/api/admin/fundraisers', eventPage({ photo_url: 'javascript:alert(1)' }))).status, 400);
  assert.equal(count(s.sqlite, 'fundraisers'), 2);
});

test('an https photo link is saved', async () => {
  const s = site();
  await createFundraiser(s, eventPage({ photo_url: 'https://example.org/quiz.jpg' }));
  assert.equal((await cardFor(s, 'quiz-night')).photo_url, 'https://example.org/quiz.jpg');
});

test('a photo link is checked when a fundraiser is edited too', async () => {
  const s = site();
  assert.equal((await updateFundraiser(s, 1, { photo_url: 'http://example.org/moor.jpg' })).status, 400);
  assert.equal(row(s.sqlite, 'SELECT photo_url FROM fundraisers WHERE id = 1').photo_url, '');
});

test('a donation link must be a JustGiving address', async () => {
  const s = site();
  for (const donate_url of ['https://evil.test/donate', 'http://www.justgiving.com/fundraising/quiz', 'https://justgiving.com.evil.test/quiz']) {
    assert.equal((await s.admin('POST', '/api/admin/fundraisers', eventPage({ donate_url }))).status, 400, donate_url);
  }
  assert.equal(count(s.sqlite, 'fundraisers'), 2);
});

test('a JustGiving donation link is saved and shown on the fundraiser page', async () => {
  const s = site();
  await createFundraiser(s, eventPage({ donate_url: 'https://www.justgiving.com/fundraising/quiz' }));
  assert.equal((await s.api('GET', '/api/fundraisers/quiz-night')).data.fundraiser.donate_url, 'https://www.justgiving.com/fundraising/quiz');
});

test('an event cannot be turned into a dare board', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  assert.equal((await updateFundraiser(s, quiz.id, { ...dareBoard({ title: 'Quiz Night' }) })).status, 400);
  assert.equal(row(s.sqlite, 'SELECT type FROM fundraisers WHERE id = ?', quiz.id).type, 'event');
});

test('a dare board stays a dare board whatever type is sent', async () => {
  const s = site();
  assert.equal((await updateFundraiser(s, 1, { type: 'event', donate_url: '', manual_total: '50' })).status, 200);
  assert.deepEqual(row(s.sqlite, 'SELECT type, manual_total_pence FROM fundraisers WHERE id = 1'), { type: 'dare', manual_total_pence: 0 });
});

test('an event can become a challenge', async () => {
  const s = site();
  const quiz = await createFundraiser(s, eventPage());
  assert.equal((await updateFundraiser(s, quiz.id, { type: 'challenge' })).status, 200);
  assert.equal((await cardFor(s, quiz.slug)).type, 'challenge');
});

test('a new fundraiser needs a known type', async () => {
  assert.equal((await site().admin('POST', '/api/admin/fundraisers', eventPage({ type: 'raffle' }))).status, 400);
});

test('only a live fundraiser can be featured', async () => {
  const s = site();
  const finished = await createFundraiser(s, eventPage({ title: 'Bake Sale', status: 'finished' }));
  assert.equal((await s.admin('PUT', '/api/admin/featured', { id: 2 })).status, 400, 'the Plymouth Hoe draft');
  assert.equal((await s.admin('PUT', '/api/admin/featured', { id: finished.id })).status, 400);
  assert.equal((await s.admin('PUT', '/api/admin/featured', { id: 99 })).status, 404);
  assert.equal((await s.admin('GET', '/api/admin/overview')).data.featured_id, 1);
});

for (const [name, change] of Object.entries({
  'a status other than draft, live or finished': { status: 'secret' },
  'a title under three characters': { title: 'Hi' },
  'a title over 60 characters': { title: 'x'.repeat(61) },
  'a target that is not an amount': { target: 'lots' },
  'a group winner count of 0': { group_winners: 0 },
  'a walker winner count of 11': { walker_winners: 11 },
  'a closing time that is not a date': { closes_at: 'next Tuesday' },
})) {
  test(`a fundraiser is not saved with ${name}`, async () => {
    const s = site();
    const before = row(s.sqlite, 'SELECT * FROM fundraisers WHERE id = 1');
    assert.equal((await updateFundraiser(s, 1, change)).status, 400);
    assert.deepEqual(row(s.sqlite, 'SELECT * FROM fundraisers WHERE id = 1'), before);
  });
}

test('saving a fundraiser keeps its slug when the title changes', async () => {
  const s = site();
  assert.equal((await updateFundraiser(s, 1, { title: 'Dares on the Moor' })).status, 200);
  assert.deepEqual(row(s.sqlite, 'SELECT slug, title FROM fundraisers WHERE id = 1'), { slug: 'dartmoor', title: 'Dares on the Moor' });
});

test('a title with no letters or digits gets the slug "fundraiser"', async () => {
  const s = site();
  assert.equal((await createFundraiser(s, eventPage({ title: '!!!' }))).slug, 'fundraiser');
});

test('a hidden walker drops off the board and comes back when shown again', async () => {
  const s = site();
  const save = (active) => s.admin('PUT', `/api/admin/targets/${targetId(s.sqlite, 'daniel')}`, { name: 'Daniel', jg_url: '', active });
  assert.equal((await save(false)).status, 200);
  assert.equal(listOn(await getBoard(s), 'daniel'), undefined);
  assert.equal((await save(true)).status, 200);
  assert.ok(listOn(await getBoard(s), 'daniel'));
});

test('the group list cannot be hidden', async () => {
  const s = site();
  const group = groupOf(s.sqlite, 1);
  assert.equal((await s.admin('PUT', `/api/admin/targets/${group}`, { name: 'The whole group', jg_url: '', active: false })).status, 400);
  assert.equal(row(s.sqlite, 'SELECT active FROM targets WHERE id = ?', group).active, 1);
});

test('a walker\'s donation link must be a JustGiving address', async () => {
  const s = site();
  assert.equal((await s.admin('POST', '/api/admin/walkers', { name: 'Robin', jg_url: 'https://evil.test/robin' })).status, 400);
  assert.equal(count(s.sqlite, 'targets'), 14);
});

test('the long description keeps its paragraphs', async () => {
  const s = site();
  await createFundraiser(s, eventPage({ body: 'Doors at 7pm.\r\n\r\n\r\nRaffle between rounds.  ' }));
  assert.equal((await s.api('GET', '/api/fundraisers/quiz-night')).data.fundraiser.body, 'Doors at 7pm.\n\nRaffle between rounds.');
});

test('saving the site text with nothing in it is refused', async () => {
  assert.equal((await site().admin('PUT', '/api/admin/site', {})).status, 400);
});

test('the homepage intro is limited to 300 characters', async () => {
  assert.equal((await site().admin('PUT', '/api/admin/site', { site_intro: 'x'.repeat(301) })).status, 400);
});
