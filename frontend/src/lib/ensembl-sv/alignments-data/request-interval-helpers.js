const f = ({
  start: o,
  end: c,
  step: l
}) => (o % l === 0 && (o -= 1), o = Math.floor(o / l) * l + 1, c = Math.ceil(c / l) * l, { start: o, end: c });
export {
  f as getStepBasedInterval
};
