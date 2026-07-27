const u = (i) => i.id, d = (i) => i.start, o = (i) => i.end;
class l {
  #t = [];
  #r = /* @__PURE__ */ new Set();
  #a;
  #s;
  #n;
  #e = [];
  // just put features in an array
  constructor(t = {}) {
    this.#a = t.getFeatureId ?? u, this.#s = t.getFeatureStart ?? d, this.#n = t.getFeatureEnd ?? o;
  }
  /**
   * Part of the public api; serves to add features to the cache.
   * The cache receives an array of features, and an interval that these features were requested from.
   * Q: Why is the interval necessary? Why can't it be inferred from start and end coordinates of features?
   * A: Because a feature can be only partly included in the requested interval
   *    (e.g. feature's start is outside) the interval. Thus, if you infer the interval
   *    from the smallest start and the largest end coordinates of all features,
   *    you may wrongly extend the interval beyond the one that was requested,
   *    and may miss small features that are just outside the requested interval.
   * Because a feature may be only partially included in an interval,
   * it is possible to receive the same feature in two (or more) requested intervals.
   * Therefore, storing features in the cache should be accompanied by checking
   * whether a feature with the same id has already been stored.
   */
  add({
    interval: t,
    features: e
  }) {
    const s = { index: 0 };
    for (const r of e)
      this.#i({ feature: r, state: s });
    this.#t.push(t), this.#h();
  }
  /**
   * Part of the public api; serves to retrieve features from the cache
   */
  get({
    start: t,
    end: e
  }) {
    const s = [];
    for (const r of this.#e) {
      const n = this.#s(r), a = this.#n(r);
      (n >= t && n <= e || a >= t && a <= e || n <= t && a >= e) && s.push(r);
    }
    return s;
  }
  getCachedIntervals() {
    return this.#t;
  }
  #i({
    feature: t,
    state: e
  }) {
    const s = this.#a(t);
    if (this.#r.has(s))
      return;
    const r = this.#s(t);
    let n = !1;
    for (let a = e.index; a < this.#e.length; a++) {
      e.index = a;
      const h = this.#e[a], c = this.#s(h);
      if (r <= c) {
        if (!n) {
          this.#e.splice(a, 0, t), n = !0;
          break;
        }
      } else
        continue;
    }
    n || this.#e.push(t), this.#r.add(s);
  }
  /**
   * The purpose of this function is to merge overlapping cached intervals,
   * as well as adjacent cached intervals (e.g. an interval that starts right after previous interval ends)
   */
  #h() {
    this.#t.sort((e, s) => e.start - s.start);
    const t = [this.#t[0]];
    for (let e = 1; e < this.#t.length; e++) {
      const s = this.#t[e], r = t.at(-1);
      s.start <= r.end + 1 ? t[t.length - 1] = {
        start: Math.min(s.start, r.start),
        end: Math.max(s.end, r.end)
      } : t.push(s);
    }
    this.#t = t;
  }
}
export {
  l as SimpleArrayCache
};
