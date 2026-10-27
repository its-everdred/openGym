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

test('notes on single exercises of a finished workout are the person writing too', () => {
  const S2 = { workouts: [{ id: 'w3', d: '2026-10-26', name: 'Lower Push', entries: [{ id: '0463', note: 'make this a timer', target: { note: 'Brace' } }] }] };
  assert.deepEqual(collectNotes(S2).map(n => [n.id, n.text]), [['workout:w3:ex:0463', 'make this a timer']]);
});

test('notes in the workout still running on the phone are reported mid-session', () => {
  const live = { id: 'w4', d: '2026-10-27', name: 'Lower Push', note: 'stretch before cardio', entries: [{ id: '0463', note: 'timer pls', done: 1, sets: 2 }] };
  const notes = collectNotes({ workouts: [] }, live);
  assert.deepEqual(notes.map(n => [n.id, n.text, n.live]), [['workout:w4', 'stretch before cardio', true], ['workout:w4:ex:0463', 'timer pls', true]]);
  assert.equal(notes[0].session, 'Lower Push');
});

test('a note seen mid-session is not reported again when that workout is finished', () => {
  // The running workout's id is the finished workout's id, so the two share a key: the agent is
  // not asked twice about a note it already acted on.
  const live = { id: 'w5', name: 'Upper', note: 'curls required', entries: [] };
  const seen = newNotes(collectNotes({ workouts: [] }, live), {}).seen;
  const filed = { workouts: [{ id: 'w5', name: 'Upper', note: 'curls required', entries: [] }] };
  assert.equal(newNotes(collectNotes(filed, null), seen).fresh.length, 0);
});

test('no running workout, or a malformed one, adds nothing', () => {
  assert.deepEqual(collectNotes({ workouts: [] }, null), []);
  assert.deepEqual(collectNotes({ workouts: [] }, { note: 'no id' }), []);
  assert.deepEqual(collectNotes({ workouts: [] }, 'x'), []);
});
