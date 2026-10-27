#!/usr/bin/env node
// Watches a signed-in profile for notes written in the app — including in a workout still running
// on the phone — and prints each new or changed one as a JSON line on stdout, so whatever spawned
// it (an agent's monitor, a shell pipe) wakes on it.
//
// Read-only: it calls GET /api/data/rev every POLL_SEC and fetches GET /api/data and GET
// /api/data/live only when that number moved. It never writes the profile. Auth is a bearer
// token from pairing (Settings → Pair the mobile app, redeemed at POST /api/pair/redeem), read
// from a file so it never sits in the environment or a shell history.
//
//   OPENGYM_API=https://your.instance node scripts/notes-listener.mjs
//
// Env: OPENGYM_API (required), OPENGYM_TOKEN_FILE (~/.config/opengym/token),
//      OPENGYM_SEEN_FILE (~/.config/opengym/notes-seen.json), POLL_SEC (60).
//
// A note is seen once per text: editing it prints it again. On a first run (no seen file) every
// note already in the profile is printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const str = v => (typeof v === 'string' ? v.trim() : '');

// A workout's session note and the notes on its exercises. The running workout (GET
// /api/data/live) is keyed like the finished one it becomes, so a note seen mid-session is not
// reported again when the workout is filed.
function workoutNotes(w, out, live) {
  if (!w?.id) return;
  const base = { kind: 'workout', date: w.d || null, session: w.name || null, ...(live ? { live: true } : {}) };
  const text = str(w.note);
  if (text) out.push({ id: 'workout:' + w.id, ...base, text });
  // One note per exercise: a session can hold the same exercise twice (two routines combined), and
  // two notes under one key would each look new against the other on every poll.
  const byEx = new Map();
  for (const e of Array.isArray(w.entries) ? w.entries : []) {
    const t = str(e?.note);
    if (t && e.id != null) byEx.set(String(e.id), [...(byEx.get(String(e.id)) || []), t]);
  }
  for (const [ex, texts] of byEx) out.push({ id: `workout:${w.id}:ex:${ex}`, ...base, exercise: ex, text: texts.join(' / ') });
}

/** Every note in a profile document — a workout's session note and its exercise notes, a day-off
 *  note, a standing per-exercise note — and in the workout running on a device (`live`, from
 *  GET /api/data/live). Routine cues (`routines[].ex[].note`, and their copies in an entry's
 *  `target`) are plan text, not the person writing, and are left out. */
export function collectNotes(S, live = null) {
  const out = [];
  for (const w of Array.isArray(S?.workouts) ? S.workouts : []) workoutNotes(w, out, false);
  if (live && typeof live === 'object') workoutNotes(live, out, true);
  for (const [date, e] of Object.entries(S?.dayNotes || {})) {
    const text = [str(e?.tag), str(e?.text)].filter(Boolean).join(': ');
    if (text) out.push({ id: 'day:' + date, kind: 'day', date, session: null, text });
  }
  for (const [exId, note] of Object.entries(S?.exNotes || {})) {
    const text = str(note);
    if (text) out.push({ id: 'ex:' + exId, kind: 'exercise', date: null, session: null, exercise: exId, text });
  }
  return out;
}

const fingerprint = n => crypto.createHash('sha256').update(n.text).digest('hex').slice(0, 16);

/** The notes not yet seen with their current text, and the seen map to save after printing. */
export function newNotes(notes, seen = {}) {
  const fresh = notes.filter(n => seen[n.id] !== fingerprint(n));
  const next = { ...seen };
  for (const n of fresh) next[n.id] = fingerprint(n);
  return { fresh, seen: next };
}

async function main() {
  const api = (process.env.OPENGYM_API || '').replace(/\/+$/, '');
  if (!api) { console.error('OPENGYM_API is required'); process.exit(2); }
  const home = path.join(os.homedir(), '.config', 'opengym');
  const tokenFile = process.env.OPENGYM_TOKEN_FILE || path.join(home, 'token');
  const seenFile = process.env.OPENGYM_SEEN_FILE || path.join(home, 'notes-seen.json');
  const pollMs = Math.max(10, +process.env.POLL_SEC || 60) * 1000;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const get = async p => {
    const r = await fetch(api + p, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw Object.assign(new Error(`GET ${p}: ${r.status}`), { status: r.status });
    return r.json();
  };
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch { /* first run */ }
  let lastRev = null;
  for (;;) {
    try {
      const { rev } = await get('/api/data/rev');
      if (rev !== lastRev) {
        const { state } = await get('/api/data');
        // A push from the phone mid-workout moves the revision too, so this is read on the same beat.
        // A server from before that route answers 404: notes then wait for the finished workout.
        const { live } = await get('/api/data/live').catch(e => (e.status === 404 ? {} : Promise.reject(e)));
        const r = newNotes(collectNotes(state, live), seen);
        for (const n of r.fresh) console.log(JSON.stringify(n));
        // Taken before saving, so a seen file that cannot be written repeats a note on the next
        // start, not on every poll.
        seen = r.seen;
        lastRev = rev;
        if (r.fresh.length) {
          fs.mkdirSync(path.dirname(seenFile), { recursive: true, mode: 0o700 });
          fs.writeFileSync(seenFile, JSON.stringify(r.seen), { mode: 0o600 });
        }
      }
    } catch (e) {
      console.error(new Date().toISOString(), e.message);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
