import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanMultiline, cleanText, everestSummary, fundraiserTotal, isClosed, isHttpsUrl, isJustGivingUrl, isRefreshDue, isTakingDares,
  isVoterId, justGivingShortName, looksLikeLeaderKey, makeCode, makeLeaderKey, parseOptionalPounds, parsePounds, parseWinnerCount,
  percentOf, poundsToPence, rankBoard, slugify, uniqueSlug,
} from '../src/logic.js';

test('parsePounds converts valid amounts to pence', () => {
  assert.equal(parsePounds('5'), 500);
  assert.equal(parsePounds('5.5'), 550);
  assert.equal(parsePounds('£12.50'), 1250);
  assert.equal(parsePounds(' 0.01 '), 1);
  assert.equal(parsePounds('19.99'), 1999);
});

test('parsePounds rejects zero, junk and huge amounts', () => {
  for (const bad of ['0', '0.00', '', 'abc', '-5', '1.999', '100000', '1e3', null, undefined]) {
    assert.equal(parsePounds(bad), null, String(bad));
  }
});

test('rankBoard sorts by total and breaks ties by earliest suggestion', () => {
  const { dares } = rankBoard([
    { id: 3, total_pence: 500 },
    { id: 2, total_pence: 500 },
    { id: 1, total_pence: 100 },
  ], 2);
  assert.deepEqual(dares.map((d) => d.id), [2, 3, 1]);
});

test('rankBoard never lets a dare with no confirmed money win', () => {
  assert.equal(rankBoard([{ id: 1, total_pence: 500 }, { id: 2, total_pence: 0 }], 3).winners, 1);
  assert.equal(rankBoard([{ id: 1, total_pence: 0 }], 1).winners, 0);
  assert.equal(rankBoard([], 3).winners, 0);
});

test('rankBoard can rank group dares by votes', () => {
  const board = rankBoard([
    { id: 1, votes: 1, total_pence: 0 },
    { id: 2, votes: 5, total_pence: 0 },
    { id: 3, votes: 0, total_pence: 0 },
  ], 3, 'votes');
  assert.deepEqual(board.dares.map((d) => d.id), [2, 1, 3]);
  assert.equal(board.winners, 2);
});

test('isVoterId accepts browser ids and rejects junk', () => {
  assert.ok(isVoterId('3f2a6c1e-8b7d-4e21-9c55-0a1b2c3d4e5f'));
  for (const bad of ['', 'short', 'x'.repeat(65), "1' OR '1'='1 and more", null, 5]) assert.equal(isVoterId(bad), false, String(bad));
});

test('isJustGivingUrl only accepts https JustGiving hosts', () => {
  assert.ok(isJustGivingUrl('https://www.justgiving.com/page/alex'));
  assert.ok(isJustGivingUrl('https://justgiving.com/page/alex'));
  for (const bad of ['http://www.justgiving.com/page/a', 'https://justgiving.com.evil.test/', 'https://evil.test/justgiving.com', 'javascript:alert(1)', '']) {
    assert.equal(isJustGivingUrl(bad), false, bad);
  }
});

test('cleanText collapses whitespace and rejects long input', () => {
  assert.equal(cleanText('  a \n\t b ', 10), 'a b');
  assert.equal(cleanText('abcdef', 5), null);
  assert.equal(cleanText(undefined, 5), '');
});

test('makeCode uses only unambiguous characters', () => {
  assert.match(makeCode([0, 25, 26, 255]), /^DARE-[2-9BCDFGHJKMNPQRTVWXZ]{4}$/);
});

test('isClosed treats a blank date as open', () => {
  assert.equal(isClosed(''), false);
  assert.equal(isClosed('2026-01-01T00:00:00Z', Date.parse('2026-01-02T00:00:00Z')), true);
  assert.equal(isClosed('2026-01-03T00:00:00Z', Date.parse('2026-01-02T00:00:00Z')), false);
});

test('parseWinnerCount accepts 1 to 10 only', () => {
  assert.equal(parseWinnerCount('3'), 3);
  for (const bad of ['0', '11', '1.5', 'x']) assert.equal(parseWinnerCount(bad), null, bad);
});

test('slugify makes URL-safe names', () => {
  assert.equal(slugify("Sam O'Neil"), 'sam-o-neil');
  assert.equal(slugify('!!!'), 'walker');
});

test('slugify uses the fallback it is given when nothing is left', () => {
  assert.equal(slugify('!!!', 'fundraiser'), 'fundraiser');
  assert.equal(slugify('', 'fundraiser'), 'fundraiser');
});

test('slugify cuts long names to the maximum length', () => {
  assert.equal(slugify('a'.repeat(50)).length, 40);
  assert.equal(slugify('Charity Quiz Night', 'fundraiser', 12), 'charity-quiz');
});

test('slugify never leaves a hyphen at the cut', () => {
  assert.equal(slugify('abcd efgh', 'fundraiser', 5), 'abcd');
});

test('parseOptionalPounds reads blank and zero as no amount', () => {
  for (const blank of ['', '   ', null, undefined, '0', '0.00']) assert.equal(parseOptionalPounds(blank), 0, String(blank));
});

test('parseOptionalPounds converts pounds to pence', () => {
  assert.equal(parseOptionalPounds('500'), 50000);
  assert.equal(parseOptionalPounds('52.3'), 5230);
  assert.equal(parseOptionalPounds('£1,250.50'), 125050);
  assert.equal(parseOptionalPounds(4580), 458000);
  assert.equal(parseOptionalPounds('9999999.99'), 999999999);
});

test('parseOptionalPounds rejects junk and amounts of ten million or more', () => {
  for (const bad of ['abc', '-5', '1.999', '10000000', '1e3', '£', '5 pounds']) assert.equal(parseOptionalPounds(bad), null, bad);
});

test('poundsToPence reads the strings JustGiving sends', () => {
  assert.equal(poundsToPence('252.39'), 25239);
  assert.equal(poundsToPence('4580'), 458000);
  assert.equal(poundsToPence('0'), 0);
  assert.equal(poundsToPence(19.99), 1999);
  assert.equal(poundsToPence('0.29'), 29);
});

test('poundsToPence returns null when there is no readable amount', () => {
  for (const bad of [null, undefined, '', 'abc', '-1', 'Infinity', NaN]) assert.equal(poundsToPence(bad), null, String(bad));
});

test('cleanMultiline keeps line breaks and tidies the spaces around them', () => {
  assert.equal(cleanMultiline('  First   line \r\n second\tline  ', 100), 'First line\nsecond line');
  assert.equal(cleanMultiline('old Mac\rline endings', 100), 'old Mac\nline endings');
});

test('cleanMultiline leaves one blank line between paragraphs at most', () => {
  assert.equal(cleanMultiline('one\n\n\n\n\ntwo\n\nthree', 100), 'one\n\ntwo\n\nthree');
});

test('cleanMultiline strips control characters', () => {
  assert.equal(cleanMultiline('a\u0000b\u007fc', 100), 'a b c');
});

test('cleanMultiline measures the length after tidying and rejects long text', () => {
  assert.equal(cleanMultiline('  abcde  ', 5), 'abcde');
  assert.equal(cleanMultiline('abcdef', 5), null);
  assert.equal(cleanMultiline(undefined, 5), '');
});

test('isHttpsUrl only accepts https addresses', () => {
  assert.ok(isHttpsUrl('https://example.org/photo.jpg'));
  for (const bad of ['http://example.org/photo.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/photo.jpg', 'example.org/photo.jpg', '', null]) {
    assert.equal(isHttpsUrl(bad), false, String(bad));
  }
});

test('justGivingShortName reads the name out of a page link', () => {
  assert.equal(justGivingShortName('https://www.justgiving.com/fundraising/cachpage-daniel-rea'), 'cachpage-daniel-rea');
  assert.equal(justGivingShortName('https://www.justgiving.com/page/alex-walks/'), 'alex-walks');
  assert.equal(justGivingShortName('  https://justgiving.com/fundraising/kptrekseverest?utm_source=copy  '), 'kptrekseverest');
});

test('justGivingShortName accepts a bare short name', () => {
  assert.equal(justGivingShortName('kptrekseverest'), 'kptrekseverest');
  assert.equal(justGivingShortName('Page_2-b'), 'Page_2-b');
});

test('justGivingShortName rejects other sites, other paths and odd names', () => {
  const bad = [
    'https://evil.test/fundraising/alex',
    'http://www.justgiving.com/fundraising/alex',
    'https://www.justgiving.com/',
    'https://www.justgiving.com/campaign/alex',
    'https://www.justgiving.com/fundraising/alex/donate',
    'www.justgiving.com/fundraising/alex',
    '-alex',
    'two words',
    'a'.repeat(101),
    '',
    null,
  ];
  for (const input of bad) assert.equal(justGivingShortName(input), null, String(input));
});

test('uniqueSlug keeps a free slug and remembers it', () => {
  const taken = new Set(['emma']);
  assert.equal(uniqueSlug('daniel', taken), 'daniel');
  assert.ok(taken.has('daniel'));
});

test('uniqueSlug adds the first free number to a taken slug', () => {
  assert.equal(uniqueSlug('daniel', new Set(['daniel'])), 'daniel-2');
  assert.equal(uniqueSlug('daniel', new Set(['daniel', 'daniel-2'])), 'daniel-3');
});

test('uniqueSlug never gives the same slug twice from one set', () => {
  const taken = new Set();
  assert.deepEqual([uniqueSlug('sam', taken), uniqueSlug('sam', taken), uniqueSlug('sam', taken)], ['sam', 'sam-2', 'sam-3']);
});

test('fundraiserTotal counts dare donations for a dare board', () => {
  assert.equal(fundraiserTotal({ type: 'dare', manual_total_pence: 9999 }, 2400), 2400);
  assert.equal(fundraiserTotal({ type: 'dare', manual_total_pence: 9999 }), 0);
});

test('fundraiserTotal uses the typed-in total for events and challenges', () => {
  assert.equal(fundraiserTotal({ type: 'event', manual_total_pence: 11000 }, 2400), 11000);
  assert.equal(fundraiserTotal({ type: 'challenge', manual_total_pence: 5239 }, 2400), 5239);
});

test('percentOf rounds down so nearly there never reads as done', () => {
  assert.equal(percentOf(2500, 10000), 25);
  assert.equal(percentOf(9999, 10000), 99);
  assert.equal(percentOf(0, 10000), 0);
  assert.equal(percentOf(15000, 10000), 150);
});

test('percentOf is null without a target', () => {
  for (const target of [0, null, undefined, -100]) assert.equal(percentOf(500, target), null, String(target));
});

test('isTakingDares needs a live dare board that has not closed', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const board = { type: 'dare', status: 'live', closes_at: '' };
  assert.equal(isTakingDares(board, now), true);
  assert.equal(isTakingDares({ ...board, closes_at: '2026-01-03T00:00:00Z' }, now), true);
  assert.equal(isTakingDares({ ...board, closes_at: '2026-01-01T00:00:00Z' }, now), false);
  assert.equal(isTakingDares({ ...board, status: 'draft' }, now), false);
  assert.equal(isTakingDares({ ...board, status: 'finished' }, now), false);
  assert.equal(isTakingDares({ ...board, type: 'event' }, now), false);
});

test('everestSummary is null until a page has been read', () => {
  assert.equal(everestSummary([]), null);
  assert.equal(everestSummary([{ raised_pence: null, target_pence: null, fetched_at: null }]), null);
});

test('everestSummary adds up the pages that have been read', () => {
  const summary = everestSummary([
    { raised_pence: 25239, target_pence: 458000, fetched_at: 1000 },
    { raised_pence: 0, target_pence: null, fetched_at: 3000 },
    { raised_pence: 10000, target_pence: 300000, fetched_at: 2000 },
    { raised_pence: null, target_pence: null, fetched_at: null },
  ]);
  assert.deepEqual(summary, { raised_pence: 35239, target_pence: 758000, pages: 3, updated_at: 3000 });
});

test('isRefreshDue waits for the whole interval', () => {
  const now = 10_000_000;
  assert.equal(isRefreshDue(String(now - 899_999), now, 900_000), false);
  assert.equal(isRefreshDue(String(now - 900_000), now, 900_000), true);
  assert.equal(isRefreshDue('0', now, 900_000), true);
});

test('isRefreshDue treats a missing or unreadable time as due', () => {
  assert.equal(isRefreshDue(undefined, 10_000_000, 900_000), true);
  assert.equal(isRefreshDue('yesterday', 10_000_000, 900_000), true);
});

test('makeLeaderKey makes a 40-character key from unambiguous characters', () => {
  const key = makeLeaderKey(Uint8Array.from({ length: 40 }, (_, i) => i * 7));
  assert.match(key, /^leader-[2-9a-hjkmnp-z]{40}$/);
  assert.doesNotMatch(key.slice('leader-'.length), /[01ilo]/);
  assert.equal(makeLeaderKey([0, 30, 31, 255]), 'leader-2z29');
});

test('looksLikeLeaderKey accepts every key makeLeaderKey can produce', () => {
  const everyByte = Uint8Array.from({ length: 280 }, (_, i) => i % 256);
  for (let start = 0; start < 280; start += 40) {
    assert.ok(looksLikeLeaderKey(makeLeaderKey(everyByte.subarray(start, start + 40))));
  }
});

test('looksLikeLeaderKey rejects anything that is not a whole key', () => {
  const good = `leader-${'a'.repeat(40)}`;
  assert.ok(looksLikeLeaderKey(good));
  const bad = [good.slice(0, -1), `${good}a`, good.toUpperCase(), good.replace('leader-', 'owner-'), ` ${good}`, `leader-${'i'.repeat(40)}`, `leader-${'0'.repeat(40)}`, '', null, 40];
  for (const input of bad) assert.equal(looksLikeLeaderKey(input), false, String(input));
});
