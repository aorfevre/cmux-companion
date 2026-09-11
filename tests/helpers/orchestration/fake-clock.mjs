export class FakeClock {
  constructor() { this.now = 0; this.next = 0; this.pending = new Map(); this.waiters = []; }
  schedule(callback, delay) {
    const id = ++this.next; this.pending.set(id, { at: this.now + delay, callback });
    this.waiters = this.waiters.filter((waiter) => { if (id >= waiter.count) { waiter.resolve(); return false; } return true; });
    return id;
  }
  cancel(id) { this.pending.delete(id); }
  scheduled(count) {
    if (this.next >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }
  advance(duration) {
    const until = this.now + duration;
    for (;;) {
      const first = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first || first[1].at > until) break;
      this.now = first[1].at; this.pending.delete(first[0]); first[1].callback();
    }
    this.now = until;
  }
}
