// analyticsData.js — pure data/calculation helpers for the Analytics module.
// No DOM access here; safe to unit test or reuse elsewhere.

export function computeStats(arr) {
  if (!arr || !arr.length) return { current: 0, avg: 0, min: 0, max: 0 };
  const current = arr[arr.length - 1];
  const avg = Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
  return { current, avg, min: Math.min(...arr), max: Math.max(...arr) };
}

// Compares the mean of the most recent `window` samples against the prior
// `window` samples to classify a metric as trending up/down/flat.
export function trendOf(arr, window = 10) {
  if (!arr || arr.length < window * 2) return { dir: 'flat', pct: 0 };
  const recent = arr.slice(-window);
  const prior = arr.slice(-window * 2, -window);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const r = avg(recent), p = avg(prior);
  const diffPct = p !== 0 ? ((r - p) / Math.abs(p)) * 100 : 0;
  if (diffPct > 2) return { dir: 'up', pct: Math.abs(diffPct) };
  if (diffPct < -2) return { dir: 'down', pct: Math.abs(diffPct) };
  return { dir: 'flat', pct: Math.abs(diffPct) };
}

export function airQualityIndex(avgGasPpm) {
  if (avgGasPpm < 200) return 'Good';
  if (avgGasPpm < 400) return 'Moderate';
  if (avgGasPpm < 600) return 'Poor';
  return 'Hazardous';
}

export function healthScore({ cpu, heapPercent, flame, smoke, gasLevel, wifiRSSI }) {
  let score = 100;
  if (cpu > 70) score -= 15; else if (cpu > 50) score -= 5;
  if (heapPercent < 30) score -= 15; else if (heapPercent < 55) score -= 5;
  if (flame === 'fire') score -= 20;
  if (smoke) score -= 15;
  if (gasLevel > 600) score -= 10;
  if (wifiRSSI < -75) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Buckets alert timestamps into hourly counts over the last `hours` hours.
export function bucketAlertsByHour(alerts, types, hours = 24) {
  const arr = Array.isArray(types) ? types : [types];
  const now = Date.now();
  const buckets = new Array(hours).fill(0);
  alerts.forEach(a => {
    if (!arr.includes(a.type)) return;
    const ageH = (now - a.t) / 3600000;
    if (ageH >= 0 && ageH < hours) {
      const idx = hours - 1 - Math.floor(ageH);
      if (idx >= 0 && idx < hours) buckets[idx]++;
    }
  });
  return buckets;
}

// Generates a plausible synthetic historical series (used for 7D/30D filters
// where no real long-term backend history exists yet).
export function generateSyntheticSeries(base, variance, points) {
  const arr = [];
  let v = base;
  for (let i = 0; i < points; i++) {
    v = Math.max(base - variance, Math.min(base + variance, v + (Math.random() - 0.5) * variance * 0.4));
    arr.push(Number(v.toFixed(1)));
  }
  return arr;
}

// Builds a normalized SVG polyline "x,y x,y ..." string for a 100x24 viewBox sparkline.
export function sparklinePoints(arr, count = 16) {
  const slice = (arr || []).slice(-count);
  if (!slice.length) return '';
  const min = Math.min(...slice), max = Math.max(...slice);
  const range = (max - min) || 1;
  const stepX = 100 / (slice.length - 1 || 1);
  return slice.map((v, i) => `${(i * stepX).toFixed(1)},${(22 - ((v - min) / range) * 20).toFixed(1)}`).join(' ');
}
