import { SimpleArrayCache as f } from "./simple-array-cache.js";
import { checkIntervalOverlap as q, compareIntervals as m } from "./interval-helpers.js";
class O {
  #e;
  #n;
  #t = /* @__PURE__ */ new Map();
  constructor({
    loader: t,
    getFeatureId: s,
    getFeatureStart: i,
    getFeatureEnd: o,
    cache: c
  }) {
    this.#e = c ?? new f({
      getFeatureId: s,
      getFeatureStart: i,
      getFeatureEnd: o
    }), this.#n = t;
  }
  async get(t) {
    const { start: s, end: i } = t, o = { start: s, end: i }, c = this.#e.getCachedIntervals(), {
      nonOverlappingIntervals: I,
      overlappingIntervals: R
    } = q({
      intervals: c,
      queryInterval: o
    });
    let v = [...I], n = [];
    const u = /* @__PURE__ */ new Set();
    this.#t.size || (n = v);
    const h = [...this.#t.values()];
    for (let e = 0; e < h.length; e++) {
      const r = h[e], a = r.interval;
      for (const l of v) {
        const {
          intersecting: d,
          nonIntersecting: p
        } = m({
          referenceInterval: a,
          queryInterval: l
        });
        d === null ? n.push(l) : (u.add(r.promise), n.push(...p));
      }
      v = [...n], e < h.length - 1 && (n = []);
    }
    const g = [];
    for (const e of n) {
      const r = this.#s(e), a = this.#n({
        ...t,
        start: e.start,
        end: e.end
      }).then((l) => {
        this.#e.add({
          interval: e,
          features: l
        });
      }).finally(() => {
        this.#t.delete(r);
      });
      this.#t.set(r, {
        interval: e,
        promise: a
      }), g.push(a);
    }
    const results = await Promise.allSettled([...u, ...g]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
    return this.#e.get(t);
  }
  #s({ start: t, end: s }) {
    return `${t}-${s}`;
  }
}
export {
  O as DataService
};
