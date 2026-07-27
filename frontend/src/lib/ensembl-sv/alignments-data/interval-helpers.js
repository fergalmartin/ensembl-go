const r = ({
  intervals: t,
  queryInterval: n
}) => {
  const s = [n], i = [], g = [];
  if (!t.length)
    return {
      overlappingIntervals: [],
      nonOverlappingIntervals: s
    };
  for (; s.length; ) {
    const d = s.shift();
    for (const [c, p] of t.entries()) {
      const {
        intersecting: o,
        nonIntersecting: a
      } = h({
        referenceInterval: p,
        queryInterval: d
      });
      if (!o && c === t.length - 1)
        g.push(d);
      else if (o) {
        i.push(o), a.length && s.push(...a);
        break;
      }
    }
  }
  return {
    overlappingIntervals: i,
    nonOverlappingIntervals: g
  };
}, h = ({
  referenceInterval: t,
  queryInterval: n
}) => {
  if (t.start <= n.start && t.end >= n.end)
    return {
      intersecting: n,
      nonIntersecting: []
    };
  if (n.start < t.start && n.end > t.end) {
    const s = {
      start: n.start,
      end: t.start - 1
    }, i = {
      start: t.end + 1,
      end: n.end
    };
    return {
      intersecting: { start: t.start, end: t.end },
      nonIntersecting: [s, i]
    };
  } else if (n.end > t.start && n.end <= t.end) {
    const s = {
      start: n.start,
      end: t.start - 1
    };
    return {
      intersecting: { start: t.start, end: n.end },
      nonIntersecting: [s]
    };
  } else if (n.start < t.end && n.start >= t.start) {
    const s = {
      start: t.end + 1,
      end: n.end
    };
    return {
      intersecting: { start: n.start, end: t.end },
      nonIntersecting: [s]
    };
  } else
    return {
      intersecting: null,
      nonIntersecting: [n]
    };
};
export {
  r as checkIntervalOverlap,
  h as compareIntervals
};
