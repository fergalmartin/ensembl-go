import { svg as c } from "lit";
import { STRUCTURAL_VARIANT_LENGTH_CUTOFF as i, COLORS as p, RULER_HEIGHT as f, VARIANT_HEIGHT as g, ALIGNMENT_AREA_HEIGHT as h } from "../constants/constants.js";
const G = ({
  variants: t,
  scale: e
}) => {
  const o = t.map((n) => T({
    variant: n,
    scale: e
  })).filter((n) => n !== null);
  return c`
    <g>
      ${o}
    </g>
  `;
}, T = ({
  variant: t,
  scale: e
}) => {
  if (t.type === "snv")
    return null;
  const o = t.location.start, n = t.location.end, s = t.extent >= i, [l, d] = e.domain(), x = d - l, r = x <= 2.5e5, m = e(o), u = t.type === "insertion" ? f + h - g : f;
  const [bStart, bEnd] = e.range();
  const sequenceThresholdSpan = 1e3;
  const useExactWidth = x <= sequenceThresholdSpan;
  const sequenceFloorWidth = Math.max(1, Math.abs(bEnd - bStart) / sequenceThresholdSpan);
  let a = e(n + 1) - e(o), $ = p[t.type] || "#000000";
  const widthBoost = t.type === "snv" ? 1 : 0;
  const y = useExactWidth ? 1 : x <= 2.5e4 ? Math.max(sequenceFloorWidth + widthBoost, t.type === "snv" ? 8 : 7) : x <= 1e5 ? Math.max(sequenceFloorWidth + widthBoost, t.type === "snv" ? 7 : 6) : x <= 5e5 ? Math.max(sequenceFloorWidth + widthBoost, t.type === "snv" ? 6 : 5) : Math.max(sequenceFloorWidth + widthBoost, t.type === "snv" ? 5 : 4);
  if (t.extent < i && !r)
    return null;
  if (!a)
    if (s || r)
      a = 1;
    else
      return null;
  const B = Math.max(a, y), F = m - (B - a) / 2;
  return c`
    <rect
      x=${F}
      y=${u}
      width=${B}
      height=${g}
      fill=${$}
      class="variant"
      data-feature-type="variant"
      data-name=${t.name}
      data-variant-type=${t.type}
      data-variant-region-name=${t.location.region_name}
      data-variant-start=${t.location.start}
      data-variant-end=${t.location.end}
      data-variant-extent=${t.extent}
      data-variant-consequence=${t.consequence}
      data-variant-ref-length=${t.ref_length ?? 0}
      data-variant-alt-length=${t.alt_length ?? 0}
    />
  `;
};
export {
  G as renderVariants
};
