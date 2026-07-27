function buildAlignmentRangeIndex(xValues, yValues) {
  const count = Math.min(xValues?.length || 0, yValues?.length || 0);
  if (!count) return null;
  const order = Array.from({ length: count }, (_, index) => index);
  order.sort((a, b) => (xValues[a] - xValues[b]) || (a - b));

  let leafCount = 1;
  while (leafCount < count) leafCount *= 2;
  const xs = new Float64Array(count);
  const sourceIndexes = new Int32Array(count);
  const maxY = new Float64Array(leafCount * 2);
  maxY.fill(-Infinity);
  for (let sortedIndex = 0; sortedIndex < count; sortedIndex += 1) {
    const sourceIndex = order[sortedIndex];
    xs[sortedIndex] = xValues[sourceIndex];
    sourceIndexes[sortedIndex] = sourceIndex;
    maxY[leafCount + sortedIndex] = yValues[sourceIndex];
  }
  for (let node = leafCount - 1; node > 0; node -= 1) {
    maxY[node] = Math.max(maxY[node * 2], maxY[node * 2 + 1]);
  }
  return { count, leafCount, xs, sourceIndexes, maxY };
}

function addAlignmentRangeMatches(index, maxX, minY, matches) {
  if (!index || !matches) return;
  let low = 0;
  let high = index.count;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (index.xs[mid] <= maxX) low = mid + 1;
    else high = mid;
  }
  const lastPosition = low - 1;
  if (lastPosition < 0) return;

  const visit = (node, left, right) => {
    if (left > lastPosition || index.maxY[node] < minY) return;
    if (left === right) {
      if (left < index.count) matches.add(index.sourceIndexes[left]);
      return;
    }
    const mid = Math.floor((left + right) / 2);
    visit(node * 2, left, mid);
    if (mid < lastPosition) visit(node * 2 + 1, mid + 1, right);
  };
  visit(1, 0, index.leafCount - 1);
}

export { addAlignmentRangeMatches, buildAlignmentRangeIndex };
