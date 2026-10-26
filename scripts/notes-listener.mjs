#!/usr/bin/env node
// Watches a signed-in profile for notes written in the app and prints each new or changed one as
// a JSON line on stdout, so whatever spawned it (an agent's monitor, a shell pipe) wakes on it.
//
// Read-only: it calls GET /api/data/rev every POLL_SEC and fetches GET /api/data only when that
// number moved. It never writes the profile. Auth is a bearer token from pairing (Settings →
// Pair the mobile app, redeemed at POST /api/pair/redeem), read from a file so it never sits in
// the environment or a shell history.
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

/** Every note in a profile document: a workout's session note, a day-off note, a standing
 *  per-exercise note. Routine cues (`routines[].ex[].note`) are plan text, not the person
 *  writing, and are left out. */
export function collectNotes(S) {
  const out = [];
  for (const w of Array.isArray(S?.workouts) ? S.workouts : []) {
    const text = str(w?.note);
    if (text && w.id) out.push({ id: 'workout:' + w.id, kind: 'workout', date: w.d || null, session: w.name || null, text });
  }
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
    if (!r.ok) throw new Error(`GET ${p}: ${r.status}`);
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
        const r = newNotes(collectNotes(state), seen);
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
