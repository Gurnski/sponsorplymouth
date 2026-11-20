import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isClosed, isJustGivingUrl, isVoterId, makeCode, parsePounds, parseWinnerCount, rankBoard, slugify } from '../src/logic.js';

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
