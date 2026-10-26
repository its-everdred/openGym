// node --test scripts/notes-listener.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNotes, newNotes } from './notes-listener.mjs';

const S = {
  workouts: [
    { id: 'w1', d: '2026-10-20', name: 'Upper Vertical', note: 'curls should not be optional', entries: [{ target: { note: 'Brace' } }] },
    { id: 'w2', d: '2026-10-21', name: 'Lower', note: '   ' }
  ],
  dayNotes: { '2026-10-22': { tag: 'sick', text: 'Flu', _ts: 1 }, '2026-10-23': { _ts: 2 } },
  exNotes: { '1162': 'seat 4, pin 7', '9': '' },
  routines: [{ ex: [{ note: 'OPTIONAL — skip if short on time.' }] }]
};

test('collects what the person wrote, not the plan cues the app ships with', () => {
  // Routine and per-entry target notes are plan text; acting on them would turn every cue into
  // a change request.
  assert.deepEqual(collectNotes(S).map(n => n.id), ['workout:w1', 'day:2026-10-22', 'ex:1162']);
});

test('a cleared day note (a stamped empty entry) and a blank session note are not notes', () => {
  assert.equal(collectNotes(S).some(n => n.id === 'day:2026-10-23' || n.id === 'workout:w2'), false);
});

test('a note fires once, and again only when its text changes', () => {
  const first = newNotes(collectNotes(S), {});
  assert.equal(first.fresh.length, 3);
  assert.equal(newNotes(collectNotes(S), first.seen).fresh.length, 0);
  // An edited note is a new request: the listener must not swallow it as already handled.
  const edited = { ...S, workouts: [{ ...S.workouts[0], note: 'curls required twice a week' }] };
  assert.deepEqual(newNotes(collectNotes(edited), first.seen).fresh.map(n => n.text), ['curls required twice a week']);
});

test('a malformed or empty document yields no notes instead of throwing', () => {
  assert.deepEqual(collectNotes(null), []);
  assert.deepEqual(collectNotes({ workouts: 'x', dayNotes: null }), []);
});
