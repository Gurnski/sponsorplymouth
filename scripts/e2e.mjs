// API checks. Needs `npm run dev` running and a fresh copy of db/demo.sql.
// Leaves test records behind, so only run it locally.
import { readFileSync } from 'node:fs';
const base = 'http://127.0.0.1:8787';
const pw = readFileSync(process.argv[2], 'utf8').match(/ADMIN_PASSWORD=(.*)/)[1].trim();
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); if (!ok) fails++; };
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const boards = async () => (await call('GET', '/api/board')).data.boards;
const group = async () => (await boards()).find((b) => b.slug === 'group');
const daniel = async () => (await boards()).find((b) => b.slug === 'daniel');
const voter = (n) => `e2e-voter-${String(n).padStart(8, '0')}`;

const home = await fetch(base + '/');
check('home page serves', home.status === 200 && (await home.text()).includes('Dare us on Dartmoor'));
check('CSP header on page', (home.headers.get('content-security-policy') ?? '').includes("script-src 'self'"));
check('admin page serves', (await fetch(base + '/admin')).status === 200);

const all = await boards();
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
check('right password works', (await call('GET', '/api/admin/overview', null, pw)).status === 200);
check('bad amount refused', (await call('POST', '/api/pledges', { code: 'DARE-T4BN', amount: '-5' })).status === 400);
check('blank dare refused', (await call('POST', '/api/dares', { target_id: g.id, title: '' })).status === 400);
check('long dare refused', (await call('POST', '/api/dares', { target_id: g.id, title: 'x'.repeat(81) })).status === 400);
check('unknown target refused', (await call('POST', '/api/dares', { target_id: 9999, title: 'Valid title' })).status === 400);
check('non-JSON refused', (await fetch(base + '/api/dares', { method: 'POST', body: 'hello' })).status === 400);
const trap = await call('POST', '/api/dares', { target_id: g.id, title: 'Bot dare', website: 'x' });
check('honeypot silently dropped', trap.status === 201 && !JSON.stringify((await call('GET', '/api/admin/overview', null, pw)).data).includes('Bot dare'));
check('non-JustGiving link refused', (await call('POST', '/api/admin/walkers', { name: 'Evil', jg_url: 'https://evil.test/' }, pw)).status === 400);

// Full journey on a walker: suggest, approve, log, confirm, climb.
d = await daniel();
const xss = '<img src=x onerror=alert(1)>';
check('dare submitted', (await call('POST', '/api/dares', { target_id: d.id, title: xss, suggested_by: 'E2E' })).status === 201);
check('new dare not public until approved', !JSON.stringify(await daniel()).includes('onerror'));
const dare = (await call('GET', '/api/admin/overview', null, pw)).data.dares.find((x) => x.title === xss);
check('approve', (await call('PUT', `/api/admin/dares/${dare.id}`, { status: 'approved' }, pw)).status === 200);
check('log donation', (await call('POST', '/api/pledges', { code: dare.code, amount: '£50', donor_name: 'E2E' })).status === 201);
let row = (await daniel()).dares.find((x) => x.code === dare.code);
check('logged donation does not move rank', row.total_pence === 0 && row.pending_pence === 5000, JSON.stringify(row));
const pledge = (await call('GET', '/api/admin/overview', null, pw)).data.pledges.find((p) => p.code === dare.code);
check('confirm', (await call('PUT', `/api/admin/pledges/${pledge.id}`, { status: 'confirmed' }, pw)).status === 200);
d = await daniel();
check('confirmed donation takes the lead', d.dares[0].code === dare.code && d.dares[0].total_pence === 5000);
check('admin add donation', (await call('POST', '/api/admin/pledges', { code: dare.code.toLowerCase(), amount: '1.50' }, pw)).status === 201);
check('admin donation counts immediately', (await daniel()).dares[0].total_pence === 5150);
check('take off list', (await call('PUT', `/api/admin/dares/${dare.id}`, { status: 'rejected' }, pw)).status === 200);
check('removed dare gone', !(await daniel()).dares.some((x) => x.code === dare.code));

// Settings, closing and the group switch.
const s = (await call('GET', '/api/admin/overview', null, pw)).data.settings;
check('winner count validated', (await call('PUT', '/api/admin/settings', { ...s, group_winners: '0' }, pw)).status === 400);
check('close list', (await call('PUT', '/api/admin/settings', { ...s, closes_at: '2020-01-01T00:00:00Z' }, pw)).status === 200);
check('closed refuses dares', (await call('POST', '/api/dares', { target_id: g.id, title: 'Too late' })).status === 403);
check('closed refuses donor logs', (await call('POST', '/api/pledges', { code: 'DARE-T4BN', amount: '5' })).status === 403);
check('closed refuses votes', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: voter(6) })).status === 403);
check('board reports closed', (await call('GET', '/api/board')).data.closed === true);
const { group_enabled: _ignored, ...withoutGroup } = s;
check('switch group off', (await call('PUT', '/api/admin/settings', withoutGroup, pw)).status === 200);
check('group board gone', !(await boards()).some((b) => b.kind === 'group'));
check('switched off refuses votes', (await call('POST', '/api/votes', { code: 'DARE-K7QM', voter: voter(7) })).status === 400);
check('switched off refuses suggestions', (await call('POST', '/api/dares', { target_id: g.id, title: 'Group dare' })).status === 400);
check('walkers still there', (await boards()).filter((b) => b.kind === 'walker').length === 13);
check('reopen with group on', (await call('PUT', '/api/admin/settings', { ...s, closes_at: '' }, pw)).status === 200);
check('group board back', (await boards()).some((b) => b.kind === 'group'));

// Rate limit: 20 suggestions an hour, a few already used above.
let limited = false;
for (let i = 0; i < 21; i++) {
  if ((await call('POST', '/api/dares', { target_id: g.id, title: `Spam ${i}` })).status === 429) limited = true;
}
check('dare rate limit kicks in', limited);
const spam = (await call('GET', '/api/admin/overview', null, pw)).data.dares.filter((x) => x.title.startsWith('Spam'));
for (const x of spam) await call('PUT', `/api/admin/dares/${x.id}`, { status: 'rejected' }, pw);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
