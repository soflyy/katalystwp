// Per-session event bus + bounded ring buffer. Live turn events are published
// here; SSE subscribers replay the recent backlog (ring) then receive live
// events. Full history lives in each session's ndjson log (see claude.js).

export class SessionBus {
  constructor(ringSize = 500) {
    this.ringSize = ringSize;
    this.rings = new Map(); // sessionId -> event[]
    this.subs = new Map(); // sessionId -> Set<fn>
  }

  publish(sessionId, event) {
    const ring = this.rings.get(sessionId) || [];
    ring.push(event);
    if (ring.length > this.ringSize) ring.shift();
    this.rings.set(sessionId, ring);
    const set = this.subs.get(sessionId);
    if (set) for (const fn of set) { try { fn(event); } catch { /* a bad subscriber can't break others */ } }
  }

  backlog(sessionId) {
    return this.rings.get(sessionId) || [];
  }

  subscribe(sessionId, fn) {
    let set = this.subs.get(sessionId);
    if (!set) this.subs.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(sessionId);
    };
  }

  // Drop a finished/destroyed session's buffer (subscribers should be gone).
  clear(sessionId) {
    this.rings.delete(sessionId);
    this.subs.delete(sessionId);
  }
}
