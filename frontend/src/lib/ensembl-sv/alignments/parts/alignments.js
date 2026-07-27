import { svg as A } from "lit";
import { RULER_HEIGHT as u, COLORS as v, ALIGNMENT_AREA_HEIGHT as X } from "../constants/constants.js";
const L = ({
  alignments: t,
  referenceScale: n,
  altScale: s
}) => {
  t.length > 3e3 && (t = E({
    alignments: t,
    referenceScale: n,
    altScale: s
  }));
  const o = [], l = t.map((e) => {
    if (p(e))
      return o.push(e), null;
    const c = v.alignment;
    return I({
      alignment: e,
      referenceScale: n,
      altScale: s,
      color: c
    });
  }), r = o.map((e) => R({
    alignment: e,
    referenceScale: n,
    altScale: s
  }));
  return A`
    <g>
      ${l}
      ${r}
    </g>
  `;
}, E = ({
  alignments: t,
  referenceScale: n,
  altScale: s
}) => {
  const o = [];
  for (const r of t) {
    if (!o.length) {
      o.push(structuredClone(r));
      continue;
    }
    const e = o.at(-1);
    if (p(e) || p(r)) {
      o.push(structuredClone(r));
      continue;
    }
    const c = n(e.reference.start + e.reference.length), f = n(r.reference.start), a = s(e.alt.start + e.alt.length), h = s(r.alt.start), i = f - c >= 1, d = h - a >= 1;
    if (i || d)
      o.push(structuredClone(r));
    else {
      const $ = r.reference.start + r.reference.length - e.reference.start, g = r.alt.start + r.alt.length - e.alt.start;
      if ($ < 0 || g < 0)
        continue;
      e.reference.length = $, e.alt.length = g;
    }
  }
  return o;
}, I = ({
  alignment: t,
  referenceScale: n,
  altScale: s,
  color: o
}) => {
  if (p(t))
    return R({
      alignment: t,
      referenceScale: n,
      altScale: s
    });
  const l = n(t.reference.start), r = n(t.reference.start + t.reference.length), e = u, c = s(t.alt.start), f = s(t.alt.start + t.alt.length), a = X + u, i = [
    [l, e],
    [r, e],
    [f, a],
    [c, a]
  ].map((d) => d.join(" ")).join(", ");
  return A`
    <polygon
      points=${i}
      fill=${o}
      fill-opacity=${0.28}
      stroke="none"
      data-reference-start=${t.reference.start}
      data-reference-end=${t.reference.start + t.reference.length - 1}
      data-alt-start=${t.alt.start}
      data-alt-end=${t.alt.start + t.alt.length - 1}
    />
  `;
}, R = ({
  alignment: t,
  referenceScale: n,
  altScale: s
}) => {
  const o = n(t.reference.start), l = n(t.reference.start + t.reference.length), r = v.inversion, e = u, c = s(t.alt.start), f = s(t.alt.start + t.alt.length), a = X + u, i = [
    [o, e],
    [l, e],
    [c, a],
    [f, a]
  ].map((d) => d.join(" ")).join(", ");
  return A`
    <polygon
      points=${i}
      fill=${r}
      fill-opacity="0.52"
      stroke="none"
      data-reference-start=${t.reference.start}
      data-reference-end=${t.reference.start + t.reference.length - 1}
      data-alt-start=${t.alt.start}
      data-alt-end=${t.alt.start + t.alt.length - 1}
      data-type="inverted-alignment"
    />
  `;
}, p = (t) => t.reference.strand !== t.alt.strand;
export {
  L as renderAlignments
};
