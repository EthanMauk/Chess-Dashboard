export function rolling(values, window = 10) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const weight = index - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

export function quartiles(values) {
  return {
    q1: percentile(values, 0.25),
    median: percentile(values, 0.5),
    q3: percentile(values, 0.75),
  };
}

export function quartileAverages(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { bottom25Avg: 0, top25Avg: 0 };

  const quartileCount = Math.max(1, Math.ceil(sorted.length * 0.25));
  const bottom = sorted.slice(0, quartileCount);
  const top = sorted.slice(-quartileCount);

  return {
    bottom25Avg: bottom.reduce((a, b) => a + b, 0) / bottom.length,
    top25Avg: top.reduce((a, b) => a + b, 0) / top.length,
  };
}
