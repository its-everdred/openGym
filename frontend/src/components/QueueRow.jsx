import { queueView } from '../lib/queue.js'
import { effectiveRoutineIds } from '../lib/history.js'
import { fmtDate } from '../lib/format.js'
import { t } from '../lib/i18n.js'

// Home's progress row for a coach week (S.queue) — it stands in for the seven weekday dots
// while a planner-written queue runs the week, because its sessions have no weekday: they are done in
// order, on whatever days you train. It leads with what is next and how far the round has got;
// the full list of sessions lives in Plan.
// Reads through queueView so the words here and the today row (effectiveRoutineIds →
// queueNext) can never disagree about which is next.
export default function QueueRow({ S, today, managed }) {
  const v = queueView(S, today)
  if (!v) return null
  const next = v.items.find(i => i.state === 'next')
  // With every remaining session pinned to its own day nothing floats, so there is no next
  // session; the status line then names the soonest pinned one with its day.
  const pinned = v.items.filter(i => i.state === 'pinned').sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))[0]
  // "today" only when the today row really offers it: a 'rest' or routine override for today
  // wins over the queue there (effectiveRoutineIds), and this line must not contradict it.
  const shownToday = !!next && effectiveRoutineIds(S, today, today).includes(next.id)
  // A pass this app manages refills itself (lib/rotation.js) — "ask the coach" and naming a
  // whole week are a planner's copy, wrong for a pass with no coach and no week shape at all.
  const status = v.complete ? (managed ? t('Round complete') : t('Week complete, ask the coach'))
    : v.waiting ? (managed ? t('Next round starts {0}.', fmtDate(v.startsOn, true)) : t('Next week starts {0}', fmtDate(v.startsOn, true)))
    : shownToday ? t('Next: {0}, today', next.name)
    : next ? t('Next: {0}', next.name)
    : t('Next: {0}', pinned.name + ' · ' + fmtDate(pinned.on, true))
  return <div className="queue">
    <div className="row between">
      <div className="small queue-status" style={{ fontWeight: 500 }}>{status}</div>
      {/* Your own loop speaks in rounds, as Plan does; a coach's week keeps its plain count. */}
      <div className="small muted">{managed ? t('{0} of {1} done this round.', v.items.length - v.remaining.length, v.items.length) : `${v.items.length - v.remaining.length} / ${v.items.length}`}</div>
    </div>
  </div>
}
