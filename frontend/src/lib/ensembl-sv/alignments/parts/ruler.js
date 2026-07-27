import { svg as l } from "lit";
import { RULER_HEIGHT as i } from "../constants/constants.js";
const m = new Intl.NumberFormat("en-US"), p = ({
  scale: t,
  offsetTop: r
}) => {
  const e = t.ticks(5).map((n) => f({
    coord: n,
    scale: t,
    offsetTop: r
  }));
  return l`
    <g>
      ${e}
    </g>
  `;
}, f = ({
  coord: t,
  scale: r,
  offsetTop: s
}) => {
  const o = r(t), e = s, n = e + i, c = 1, k = o + c + 1, $ = n - 3;
  return l`
    <line
      x1=${o}
      x2=${o}
      y1=${e}
      y2=${n}
      stroke-width=${c}
      stroke=${"#7ea6cf"}
    />
    <text
      x=${k}
      y=${$}
      fill=${"#d8e6f7"}
      font-size=${i - 1}
      font-family="'IBM Plex Mono', sans-serif"
      font-weight="500"
    >${m.format(t)}</text>
  `;
};
export {
  p as renderRuler
};
