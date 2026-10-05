// The play HUD's single feedback line (round 6, "the words are in the way of seeing the ball"):
// every transient message of play — miss reasons, the last shot (stroke + km/h), "Perfect timing!",
// coaching notes, achievements, toasts, point banners — goes through ONE queue and ONE line at the
// top of the picture, instead of cards and callouts over the court. Pure module (no DOM): the UI
// feeds it messages and asks it every frame what to show.
//
// Rules:
//   - one message at a time, each for at most FEEDBACK.maxMs (banners FEEDBACK.bannerMs);
//   - priority (PRIORITY): a much more important message preempts the one showing, otherwise it waits;
//   - merge: a message with the key of one already queued or showing updates it in place (the shot
//     card's result after the hit, the same miss from the bus and the HUD tick), and a 'tag' message
//     (e.g. "Perfect") joins the shot line it belongs to;
//   - hold: while the ball is coming to the player nothing is shown (the line hides at once and the
//     queue waits until the shot resolves), except 'urgent' messages (the camera lost the player);
//   - stale: a message that waited longer than FEEDBACK.staleMs is dropped (it would be about an old ball).
//   - a persistent prompt ("Get ready", "Your serve…") fills the line while it is idle and not held.

export const FEEDBACK = Object.freeze({
  maxMs: 1600,
  bannerMs: 1200,
  staleMs: 4000,
  maxQueue: 4,
  /** A message shown for less than this when the ball comes is put back in the queue (else dropped). */
  requeueMs: 500,
  /** A 'tag' message joins a shot line pushed within this time. */
  tagMs: 900,
  /** Priority gap that lets a new message preempt the one showing. */
  preempt: 2,
});

export const PRIORITY = Object.freeze({ banner: 5, urgent: 6, miss: 3, shot: 2, perfect: 2, combo: 2, note: 1, achievement: 1, info: 0 });

/**
 * @param {{ maxMs?: number }} [o]
 * @returns {{ push(msg, now): object|null, update(now, { hold }): object|null, setPrompt(p), clear(),
 *   current: object|null, size: number, queue: object[] }}
 *   msg: { kind, text, sub?, tone? ('good'|'warn'|'bad'|'info'|'gold'), key?, priority?, ms?, tag? (joins
 *   a shot line), replace? (RegExp: chips of that shot line it supersedes), tags? (chips), urgent?, power? (0..1:
 *   the swing's effort, drawn as pips), supersedes? (kinds of queued messages it drops, e.g. ['miss']) }. The shown object is { ...msg, shownAt, until, tags: [] }.
 */
export function createFeedbackQueue({ maxMs = FEEDBACK.maxMs } = {}) {
  let cur = null;
  let prompt = null; // { text, sub?, urgent? }
  let held = false;
  const q = [];
  let seq = 0;
  // Keys already shown (key -> { sig, at }): a source that repeats the same message (the HUD tick
  // re-sends the last miss for 3.5 s) does not bring it back once it has had its turn.
  const shown = new Map();
  const sigOf = (m) => `${m.text}|${(m.tags || []).join(',')}|${m.sub || ''}`;

  const prio = (m) => (Number.isFinite(m.priority) ? m.priority : PRIORITY[m.kind] ?? 0);
  const durOf = (m) => Math.min(maxMs, Number.isFinite(m.ms) ? m.ms : m.kind === 'banner' ? FEEDBACK.bannerMs : maxMs);

  function findKey(key) {
    if (!key) return null;
    if (cur && cur.key === key) return cur;
    return q.find((m) => m.key === key) || null;
  }

  function insert(m) {
    // Highest priority first, then oldest first.
    let i = q.length;
    while (i > 0 && prio(q[i - 1]) < prio(m)) i--;
    q.splice(i, 0, m);
    while (q.length > FEEDBACK.maxQueue) {
      // Drop the lowest priority (the last one), never the one just added if it outranks it.
      q.splice(q.length - 1, 1);
    }
  }

  /** Adds (or merges) a message. Returns the stored message or null when dropped. */
  function push(msg, now) {
    if (!msg || !msg.text) return null;
    const m = { ...msg, text: String(msg.text), at: now, id: ++seq, tags: Array.isArray(msg.tags) ? msg.tags.slice() : [] };
    // Same key: update in place (text, sub, tone), keep the place and the showing time.
    const same = findKey(m.key);
    if (!same && m.key && shown.has(m.key)) {
      const prev = shown.get(m.key);
      if (now - prev.at <= FEEDBACK.staleMs && prev.sig === sigOf(m)) return null;
    }
    if (same) {
      same.text = m.text;
      if (m.sub !== undefined) same.sub = m.sub;
      if (m.tone) same.tone = m.tone;
      if (Number.isFinite(m.power)) same.power = m.power;
      // New chips first, the ones merged in since (e.g. "Perfect") kept.
      if (Array.isArray(msg.tags)) same.tags = [...new Set([...msg.tags, ...same.tags])];
      if (prio(m) > prio(same)) same.priority = prio(m);
      return same;
    }
    // supersedes: kinds of queued messages about an earlier ball that this one makes stale (a new
    // hit drops the miss of the ball before, which waited while this one was coming).
    if (Array.isArray(m.supersedes) && m.supersedes.length) {
      for (let i = q.length - 1; i >= 0; i--) if (m.supersedes.includes(q[i].kind) && !q[i].urgent) q.splice(i, 1);
    }
    // A tag joins the shot line it belongs to (showing or queued, pushed moments ago).
    if (m.tag) {
      const host = [cur, ...q].find((x) => x && x.kind === 'shot' && now - x.at <= FEEDBACK.tagMs);
      if (host) {
        // replace: a pattern of chips the new one supersedes (the meter's "Early 120 ms" over "Early").
        if (m.replace instanceof RegExp) host.tags = host.tags.filter((t) => !m.replace.test(t));
        if (!host.tags.includes(m.text)) host.tags.push(m.text);
        if (m.tone === 'good' || m.tone === 'gold') host.tone = m.tone;
        return host;
      }
    }
    if (cur && !held && prio(m) >= prio(cur) + FEEDBACK.preempt) {
      // Preempt: the one showing goes back to the front of the queue if it was barely seen.
      if (now - cur.shownAt < FEEDBACK.requeueMs) insert(cur);
      cur = null;
    }
    insert(m);
    return m;
  }

  /** The message to show at `now` (or null). hold: the ball is coming to the player. */
  function update(now, { hold = false } = {}) {
    held = !!hold;
    if (cur && hold && !cur.urgent) {
      // The ball is coming: the line goes at once; a message barely seen waits for the next gap.
      if (now - cur.shownAt < FEEDBACK.requeueMs) insert(cur);
      cur = null;
    }
    if (cur && now >= cur.until) {
      if (cur.key) shown.set(cur.key, { sig: sigOf(cur), at: now });
      cur = null;
    }
    // Stale messages are about an old ball.
    for (let i = q.length - 1; i >= 0; i--) if (now - q[i].at > FEEDBACK.staleMs && !q[i].urgent) q.splice(i, 1);
    if (!cur) {
      const i = hold ? q.findIndex((m) => m.urgent) : 0;
      if (i >= 0 && q.length > i) {
        cur = q.splice(i, 1)[0];
        cur.shownAt = now;
        cur.until = now + durOf(cur);
        if (cur.key) shown.set(cur.key, { sig: sigOf(cur), at: now });
        if (shown.size > 64) shown.delete(shown.keys().next().value);
      }
    }
    if (cur) return cur;
    if (prompt && (!hold || prompt.urgent)) return { kind: 'prompt', ...prompt, tags: [] };
    return null;
  }

  return {
    push,
    update,
    /** A persistent prompt shown while the line is idle (null clears it). */
    setPrompt(p) {
      prompt = p && p.text ? { text: String(p.text), sub: p.sub || '', urgent: !!p.urgent, tone: p.tone || (p.urgent ? 'warn' : 'info') } : null;
    },
    clear() {
      cur = null;
      q.length = 0;
      prompt = null;
      shown.clear();
    },
    get current() { return cur; },
    get size() { return q.length; },
    get queue() { return q.slice(); },
    get prompt() { return prompt; },
  };
}
