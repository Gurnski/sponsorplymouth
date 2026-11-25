// API and page checks. Needs `npm run dev` running and a fresh copy of the demo
// data (the migrations, then db/demo.sql). Leaves test records behind, so only
// run it locally.
//
//   node scripts/e2e.mjs .dev.vars [--skip-flood]
//
// The last section posts dares until the hourly limit refuses them, so a second
// run within the hour fails at its first dare. --skip-flood leaves that section
// out. Each run also makes three wrong sign-ins on purpose, and ten of those in
// 15 minutes lock the admin page for everyone on this machine.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const skipFlood = args.includes('--skip-flood');
const varsFile = args.find((arg) => !arg.startsWith('--'));
const base = process.env.E2E_BASE ?? 'http://127.0.0.1:8787';
const SITE_NAME = 'Sponsor University of Plymouth';
const pw = readFileSync(varsFile, 'utf8').match(/ADMIN_PASSWORD=(.*)/)[1].trim();

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); if (!ok) fails++; };
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const page = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const unescape = (html) => html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const titleOf = (html) => unescape(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
const csp = (response) => response.headers.get('content-security-policy') ?? '';
// A section that throws is reported as one failure, and the sections after it still run.
const section = async (name, run) => {
  try { await run(); } catch (error) { check(`${name}: ran to the end`, false, error.stack); }
};

const overview = async (token = pw) => (await call('GET', '/api/admin/overview', null, token)).data;
const adminBoard = async (id) => (await call('GET', `/api/admin/fundraisers/${id}`, null, pw)).data;
const boards = async () => (await call('GET', '/api/board')).data.boards;
const group = async () => (await boards()).find((b) => b.slug === 'group');
const daniel = async () => (await boards()).find((b) => b.slug === 'daniel');
const voter = (n) => `e2e-voter-${String(n).padStart(8, '0')}`;

// Suggests a dare and returns its row from the waiting list, which has the id but not the code.
const suggest = async (name, targetId, title) => {
  const made = await call('POST', '/api/dares', { target_id: targetId, title, suggested_by: 'E2E' });
  const hint = made.status === 429 ? 'the hourly dare limit is used up: wait an hour or start from fresh demo data' : JSON.stringify(made);
  check(name, made.status === 201, hint);
  return (await overview()).queue.dares.find((x) => x.title === title);
};
const codeOf = async (dareId) => (await adminBoard(1)).dares.find((x) => x.id === dareId)?.code;

// PUT /api/admin/fundraisers/<id> wants every field, so this builds them all from what the API returned.
const pounds = (pence) => (pence / 100).toFixed(2);
const formFor = (f, changes = {}) => ({
  type: f.type, title: f.title, summary: f.summary, body: f.body, photo_url: f.photo_url, target: pounds(f.target_pence),
  event_date: f.event_date, place: f.place, status: f.status,
  ...(f.type === 'dare'
    ? { closes_at: f.closes_at, group_enabled: Boolean(f.group_enabled), group_winners: f.group_winners, walker_winners: f.walker_winners }
    : { donate_url: f.donate_url, manual_total: pounds(f.manual_total_pence) }),
  ...changes,
});
// Runs checks that change a fundraiser, then puts it back as it was whatever happened, because the demo data is shared.
const withFundraiser = async (id, run) => {
  const original = (await adminBoard(id)).fundraiser;
  const save = (changes) => call('PUT', `/api/admin/fundraisers/${id}`, formFor(original, changes), pw);
  try {
    await run(save, original);
  } finally {
    const restored = await save({});
    const now = (await adminBoard(id)).fundraiser;
    check(`${original.slug} left as it was found`, restored.status === 200 && JSON.stringify(now) === JSON.stringify(original), JSON.stringify(now));
  }
};

// Stop before anything else if the server is not there or the password is not its password.
let signedIn;
try {
  signedIn = await call('GET', '/api/admin/overview', null, pw);
} catch (error) {
  console.error(`Nothing answered at ${base}. Start it with npm run dev. (${error.cause?.code ?? error.message})`);
  process.exit(2);
}
if (signedIn.status !== 200) {
  console.error(`Could not sign in with the password in ${varsFile}: HTTP ${signedIn.status} ${JSON.stringify(signedIn.data)}`);
  process.exit(2);
}
const draft = signedIn.data.fundraisers.find((f) => f.slug === 'plymouth-hoe');

await section('pages', async () => {
  const home = await page('/');
  check('home page serves', home.status === 200 && home.html.includes(SITE_NAME));
  check('CSP header on page', csp(home).includes("script-src 'self'"));
  check('admin page serves', (await page('/admin')).status === 200);
  for (const path of ['/fundraisers', '/about', '/our-challenge']) check(`${path} serves`, (await page(path)).status === 200);

  const dartmoor = (await call('GET', '/api/fundraisers/dartmoor')).data.fundraiser;
  const board = await page('/f/dartmoor');
  check('/f/dartmoor serves', board.status === 200, String(board.status));
  check('/f/dartmoor has the fundraiser title in <title>', titleOf(board.html).includes(dartmoor.title), titleOf(board.html));
  check('/f/dartmoor has the CSP header', csp(board).includes("script-src 'self'"), csp(board));
  const quiz = await page('/f/quiz-night');
  check('/f/quiz-night serves with its own title', quiz.status === 200 && titleOf(quiz.html).includes('Charity Quiz Night'), titleOf(quiz.html));
  check('/f/nope is a 404', (await page('/f/nope')).status === 404);
  const hidden = await page('/f/plymouth-hoe');
  check('/f/<draft> serves the page with noindex', hidden.status === 200 && hidden.headers.get('x-robots-tag') === 'noindex', `${hidden.status} ${hidden.headers.get('x-robots-tag')}`);
  check('/f/<draft> has nothing about the draft in its HTML', !hidden.html.includes(draft.title) && !unescape(hidden.html).includes(draft.title));
});

await section('site API', async () => {
  const site = (await call('GET', '/api/site')).data;
  const card = (slug) => site.fundraisers.find((f) => f.slug === slug);
  const slugs = site.fundraisers.map((f) => f.slug);
  check('/api/site lists the demo fundraisers', ['dartmoor', 'quiz-night', 'sponsored-walk', 'bake-sale'].every((slug) => slugs.includes(slug)), slugs.join());
  check('/api/site leaves the draft out', !slugs.includes('plymouth-hoe') && !JSON.stringify(site).includes(draft.title));
  check('/api/site features the Dartmoor board', site.featured === 'dartmoor', String(site.featured));
  const board = (await call('GET', '/api/board')).data;
  check('dare board card total matches the board', card('dartmoor').total_pence === 2400 && board.total_pence === 2400, `${card('dartmoor').total_pence} ${board.total_pence}`);
  check('dare board card counts the listed dares', card('dartmoor').dares === 7 && card('dartmoor').closed === false, JSON.stringify(card('dartmoor')));
  check('event card shows the typed-in total', card('quiz-night').total_pence === 11000 && card('quiz-night').percent === 36, JSON.stringify(card('quiz-night')));
  check('finished fundraiser still listed', card('bake-sale').status === 'finished');
  check('everest is a total or null', site.everest === null || (Number.isInteger(site.everest.raised_pence) && site.everest.pages > 0), JSON.stringify(site.everest));
  const about = await call('GET', '/api/site?page=about');
  check('/api/site?page=about has the page text', about.status === 200 && typeof about.data.page?.body === 'string' && about.data.page.body.length > 0);
  check('/api/site?page=<unknown> is a 404', (await call('GET', '/api/site?page=nope')).status === 404);
});

await section('event page API', async () => {
  const quiz = await call('GET', '/api/fundraisers/quiz-night');
  const f = quiz.data.fundraiser;
  check('event page API', quiz.status === 200 && f.type === 'event' && f.title === 'Charity Quiz Night' && f.total_pence === 11000 && f.target_pence === 30000, JSON.stringify(quiz.data));
  check('event page has its text and JustGiving link', f.body.includes('Doors open') && f.donate_url.startsWith('https://www.justgiving.com/'), JSON.stringify(f));
  check('live fundraiser is not a preview', quiz.data.preview === false);
  check('event has no dare board', (await call('GET', '/api/board?f=quiz-night')).status === 404);
  check('unknown fundraiser is a 404', (await call('GET', '/api/fundraisers/nope')).status === 404);
  check('draft hidden from the public', (await call('GET', '/api/fundraisers/plymouth-hoe')).status === 404);
  const preview = await call('GET', '/api/fundraisers/plymouth-hoe', null, pw);
  check('draft shown to a signed-in leader as a preview', preview.status === 200 && preview.data.preview === true, JSON.stringify(preview.data));
});

const first = await call('GET', '/api/board');
check('board has fundraiser, preview, closed, total_pence and boards', ['fundraiser', 'preview', 'closed', 'total_pence', 'boards'].every((key) => key in first.data), Object.keys(first.data).join());
check('/api/board with no fundraiser named is the Dartmoor board', first.data.fundraiser.slug === 'dartmoor' && JSON.stringify((await call('GET', '/api/board?f=dartmoor')).data) === JSON.stringify(first.data));
const all = first.data.boards;
check('13 walkers plus the group', all.length === 14, String(all.length));
check('every walker has a JustGiving link', all.filter((b) => b.kind === 'walker').every((b) => b.jg_url.includes('justgiving.com/fundraising/')));

let g = await group();
let d = await daniel();
check('group ranked by votes', g.dares[0].code === 'DARE-K7QM' && g.dares[0].votes === 6, JSON.stringify(g.dares[0]));
check('group winners capped at 3', g.winners === 3, String(g.winners));
check('pending dare hidden', !JSON.stringify(g).includes('DARE-P6ZD'));
check('walker ranked by money', d.dares[0].code === 'DARE-T4BN' && d.dares[0].total_pence === 1200, JSON.stringify(d.dares[0]));
check('walker winners capped at 1', d.winners === 1, String(d.winners));
const q5 = d.dares.find((x) => x.code === 'DARE-Q5JH');
check('unconfirmed money not counted', q5.total_pence === 500 && q5.pending_pence === 1000, JSON.stringify(q5));

// Votes.
const votesAtStart = g.dares.find((x) => x.code === 'DARE-M2XR').votes;
const v1 = await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(1) });
check('vote counts', v1.status === 200 && v1.data.voted === true && (await group()).dares.find((x) => x.code === 'DARE-M2XR').votes === 2, JSON.stringify(v1));
const v2 = await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(1) });
check('voting again takes it back', v2.data.voted === false && (await group()).dares.find((x) => x.code === 'DARE-M2XR').votes === 1, JSON.stringify(v2));
await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(2) });
await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(3) });
await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(4) });
g = await group();
check('votes change the ranking', g.dares.findIndex((x) => x.code === 'DARE-M2XR') < 3 && g.dares.findIndex((x) => x.code === 'DARE-W9PC') === 3, g.dares.map((x) => x.code).join());
check('bad voter id refused', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: 'x' })).status === 400);
check('no voting on walker dares', (await call('POST', '/api/votes', { code: 'DARE-T4BN', voter: voter(5) })).status === 404);
check('no voting on unapproved dares', (await call('POST', '/api/votes', { code: 'DARE-P6ZD', voter: voter(5) })).status === 404);

// Money stays off group dares.
check('donor cannot log money on group dare', (await call('POST', '/api/pledges', { code: 'DARE-K7QM', amount: '5' })).status === 400);
check('admin cannot add money to group dare', (await call('POST', '/api/admin/pledges', { code: 'DARE-K7QM', amount: '5' }, pw)).status === 400);

// Auth and input checks.
check('admin needs a password', (await call('GET', '/api/admin/overview')).status === 401);
check('wrong password refused', (await call('GET', '/api/admin/overview', null, 'nope')).status === 401);
const signedInOverview = await call('GET', '/api/admin/overview', null, pw);
check('right password works', signedInOverview.status === 200 && signedInOverview.data.me.role === 'owner', JSON.stringify(signedInOverview.data.me));
check('overview has me, fundraisers, featured_id, queue, everest and site', ['me', 'fundraisers', 'featured_id', 'queue', 'everest', 'site'].every((key) => key in signedInOverview.data), Object.keys(signedInOverview.data).join());
check('overview lists the draft for leaders', signedInOverview.data.fundraisers.some((f) => f.slug === 'plymouth-hoe' && f.status === 'draft'));
check('pending dare waits in the queue', signedInOverview.data.queue.dares.some((x) => x.title === 'Swap boots at every checkpoint' && x.fundraiser_id === 1), JSON.stringify(signedInOverview.data.queue.dares));
check('bad amount refused', (await call('POST', '/api/pledges', { code: 'DARE-T4BN', amount: '-5' })).status === 400);
check('blank dare refused', (await call('POST', '/api/dares', { target_id: g.id, title: '' })).status === 400);
check('long dare refused', (await call('POST', '/api/dares', { target_id: g.id, title: 'x'.repeat(81) })).status === 400);
check('unknown target refused', (await call('POST', '/api/dares', { target_id: 9999, title: 'Valid title' })).status === 400);
check('non-JSON refused', (await fetch(base + '/api/dares', { method: 'POST', body: 'hello' })).status === 400);
const trap = await call('POST', '/api/dares', { target_id: g.id, title: 'Bot dare', website: 'x' });
check('honeypot silently dropped', trap.status === 201 && !JSON.stringify(await overview()).includes('Bot dare'));
check('non-JustGiving link refused', (await call('POST', '/api/admin/walkers', { name: 'Evil', jg_url: 'https://evil.test/' }, pw)).status === 400);
check('only a live fundraiser can be featured', (await call('PUT', '/api/admin/featured', { id: draft.id }, pw)).status === 400 && (await overview()).featured_id === signedIn.data.featured_id);

// Full journey on a walker: suggest, approve, log, confirm, climb. The dare stays
// on the list until after the closing checks, which add a late donation to it.
let journey = null;
await section('walker journey', async () => {
  d = await daniel();
  const xss = '<img src=x onerror=alert(1)>';
  const dare = await suggest('dare submitted', d.id, xss);
  if (!dare) return;
  check('new dare not public until approved', !JSON.stringify(await daniel()).includes('onerror'));
  check('approve', (await call('PUT', `/api/admin/dares/${dare.id}`, { status: 'approved' }, pw)).status === 200);
  dare.code = await codeOf(dare.id);
  check('approved dare has a code and the approver on the admin list', /^DARE-/.test(dare.code ?? '') && (await adminBoard(1)).dares.find((x) => x.id === dare.id).reviewed_by === 'Owner', String(dare.code));
  journey = dare;
  check('log donation', (await call('POST', '/api/pledges', { code: dare.code, amount: '£50', donor_name: 'E2E' })).status === 201);
  const row = (await daniel()).dares.find((x) => x.code === dare.code);
  check('logged donation does not move rank', row.total_pence === 0 && row.pending_pence === 5000, JSON.stringify(row));
  const pledge = (await overview()).queue.pledges.find((p) => p.code === dare.code);
  check('confirm', (await call('PUT', `/api/admin/pledges/${pledge.id}`, { status: 'confirmed' }, pw)).status === 200);
  d = await daniel();
  check('confirmed donation takes the lead', d.dares[0].code === dare.code && d.dares[0].total_pence === 5000);
  check('admin add donation', (await call('POST', '/api/admin/pledges', { code: dare.code.toLowerCase(), amount: '1.50' }, pw)).status === 201);
  check('admin donation counts immediately', (await daniel()).dares[0].total_pence === 5150);
  check('board and site card totals follow', (await call('GET', '/api/board')).data.total_pence === 7550 && (await call('GET', '/api/site')).data.fundraisers.find((f) => f.slug === 'dartmoor').total_pence === 7550);
});

// A leader key: made by the owner, used, refused for logins, revoked.
await section('leader key', async () => {
  const made = await call('POST', '/api/admin/logins', { name: 'E2E leader' }, pw);
  const key = made.data.key;
  check('owner makes a leader key', made.status === 201 && /^leader-[2-9a-z]{40}$/.test(key ?? ''), JSON.stringify(made.data).replace(key, '(key)'));
  const me = (await overview(key)).me;
  check('leader key signs in', me?.name === 'E2E leader' && me?.role === 'leader', JSON.stringify(me));
  check('leader cannot list logins', (await call('GET', '/api/admin/logins', null, key)).status === 403);
  check('leader cannot make logins', (await call('POST', '/api/admin/logins', { name: 'E2E friend' }, key)).status === 403);

  const dare = await suggest('dare submitted for the leader', g.id, 'E2E leader approval');
  if (dare) {
    check('leader approves a dare', (await call('PUT', `/api/admin/dares/${dare.id}`, { status: 'approved' }, key)).status === 200);
    check('approval recorded under the leader\'s name', (await adminBoard(1)).dares.find((x) => x.id === dare.id)?.reviewed_by === 'E2E leader');
    check('leader takes it off again', (await call('PUT', `/api/admin/dares/${dare.id}`, { status: 'rejected' }, key)).status === 200);
  }

  const { logins } = (await call('GET', '/api/admin/logins', null, pw)).data;
  const login = logins.filter((x) => x.name === 'E2E leader' && !x.revoked).at(-1);
  check('login listed without its key', Boolean(login) && !JSON.stringify(logins).includes(key) && !('key_hash' in login), JSON.stringify(login));
  check('leader cannot revoke logins', (await call('PUT', `/api/admin/logins/${login.id}`, null, key)).status === 403);
  check('owner revokes the key', (await call('PUT', `/api/admin/logins/${login.id}`, null, pw)).status === 200);
  check('revoked key refused', (await call('GET', '/api/admin/overview', null, key)).status === 401);
  check('login shows as revoked', (await call('GET', '/api/admin/logins', null, pw)).data.logins.find((x) => x.id === login.id).revoked === 1);
});

// Dare settings, closing, finishing and the group switch, all on fundraiser 1.
await section('dare board settings', () => withFundraiser(1, async (save) => {
  check('winner count validated', (await save({ group_winners: 0 })).status === 400);
  check('photo link must be https', (await save({ photo_url: 'http://example.org/moor.jpg' })).status === 400);
  check('a dare board stays a dare board', (await save({ type: 'event' })).status === 200 && (await adminBoard(1)).fundraiser.type === 'dare');
  check('close list', (await save({ closes_at: '2020-01-01T00:00:00Z' })).status === 200);
  check('closed refuses dares', (await call('POST', '/api/dares', { target_id: g.id, title: 'Too late' })).status === 403);
  check('closed refuses donor logs', (await call('POST', '/api/pledges', { code: 'DARE-T4BN', amount: '5' })).status === 403);
  check('closed refuses votes', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: voter(6) })).status === 403);
  check('board reports closed', (await call('GET', '/api/board')).data.closed === true);
  if (journey) {
    check('admin can add a late donation', (await call('POST', '/api/admin/pledges', { code: journey.code, amount: '2' }, pw)).status === 201 && (await daniel()).dares[0].total_pence === 5350);
  }
  check('finish the fundraiser', (await save({ status: 'finished' })).status === 200);
  check('finished refuses dares', (await call('POST', '/api/dares', { target_id: g.id, title: 'All over' })).status === 403);
  check('finished refuses votes', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: voter(6) })).status === 403);
  const finished = await call('GET', '/api/board');
  check('finished board still shown, closed', finished.status === 200 && finished.data.closed === true && finished.data.fundraiser.status === 'finished');
  check('switch group off', (await save({ group_enabled: false })).status === 200);
  check('group board gone', !(await boards()).some((b) => b.kind === 'group'));
  check('switched off refuses votes', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: voter(7) })).status === 400);
  check('switched off refuses suggestions', (await call('POST', '/api/dares', { target_id: g.id, title: 'Group dare' })).status === 400);
  check('walkers still there', (await boards()).filter((b) => b.kind === 'walker').length === 13);
  check('reopen with group on', (await save({})).status === 200);
  check('group board back', (await boards()).some((b) => b.kind === 'group'));
}));

await section('event settings', () => withFundraiser(3, async (save) => {
  check('donation link must be JustGiving', (await save({ donate_url: 'https://evil.test/donate' })).status === 400);
  check('an event cannot become a dare board', (await save({ type: 'dare' })).status === 400);
  check('typed-in total validated', (await save({ manual_total: 'lots' })).status === 400);
}));

if (journey) {
  check('take off list', (await call('PUT', `/api/admin/dares/${journey.id}`, { status: 'rejected' }, pw)).status === 200);
  check('removed dare gone', !(await daniel()).dares.some((x) => x.code === journey.code));
  check('removed dare no longer counts', (await call('GET', '/api/board')).data.total_pence === 2400);
}

// Take the three test votes back, so the group ranking is left as it was found.
for (const n of [2, 3, 4]) await call('POST', '/api/votes', { code: 'DARE-M2XR', voter: voter(n) });
const votesAtEnd = (await group()).dares.find((x) => x.code === 'DARE-M2XR').votes;
check('test votes taken back', votesAtEnd === votesAtStart, `${votesAtStart} at the start, ${votesAtEnd} at the end`);

// Rate limit: 20 suggestions an hour, a few already used above.
if (skipFlood) {
  console.log('SKIP dare rate limit (--skip-flood)');
} else {
  let limited = false;
  for (let i = 0; i < 21; i++) {
    if ((await call('POST', '/api/dares', { target_id: g.id, title: `Spam ${i}` })).status === 429) limited = true;
  }
  check('dare rate limit kicks in', limited);
  const spam = (await overview()).queue.dares.filter((x) => x.title.startsWith('Spam'));
  for (const x of spam) await call('PUT', `/api/admin/dares/${x.id}`, { status: 'rejected' }, pw);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
