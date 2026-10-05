
'use strict';

const M = {};


M.VTYPES = {
  motorcycle: { key:'motorcycle', label:'Motorcycle', len:2.2,  vmax:1.05, acc:2.6, dec:3.4, share:0.34, maxFlood:0.10, color:'#f472b6', w:2.6 },
  car:        { key:'car',        label:'Car',        len:4.4,  vmax:1.00, acc:2.0, dec:3.0, share:0.36, maxFlood:0.24, color:'#60a5fa', w:3.2 },
  tricycle:   { key:'tricycle',   label:'Tricycle',   len:3.0,  vmax:0.62, acc:1.3, dec:2.6, share:0.14, maxFlood:0.18, color:'#34d399', w:2.9 },
  jeepney:    { key:'jeepney',    label:'Jeepney',    len:6.5,  vmax:0.80, acc:1.2, dec:2.5, share:0.08, maxFlood:0.34, color:'#fbbf24', w:3.6 },
  bus:        { key:'bus',        label:'Bus',        len:11.0, vmax:0.78, acc:0.9, dec:2.2, share:0.04, maxFlood:0.45, color:'#f97316', w:4.0 },
  truck:      { key:'truck',      label:'Truck',      len:9.5,  vmax:0.74, acc:0.8, dec:2.2, share:0.037,maxFlood:0.52,color:'#a78bfa', w:3.8 },
  emergency:  { key:'emergency',  label:'Emergency',  len:5.5,  vmax:1.22, acc:2.4, dec:3.2, share:0.003,maxFlood:0.60,color:'#ef4444', w:3.8 }
};
M.VLIST = Object.keys(M.VTYPES);


M.WEATHER = {
  sunny:      { key:'sunny',      label:'Sunny',      spd:1.00, cap:1.00, gap:1.00, icon:'☀', tint:null,      flood:0.00 },
  cloudy:     { key:'cloudy',     label:'Cloudy',     spd:0.95, cap:0.98, gap:1.03, icon:'☁', tint:null,      flood:0.00 },
  rainy:      { key:'rainy',      label:'Rainy',      spd:0.82, cap:0.90, gap:1.15, icon:'🌧', tint:'#2c4a63', flood:0.00 },
  heavy_rain: { key:'heavy_rain', label:'Heavy rain', spd:0.66, cap:0.76, gap:1.32, icon:'⛈', tint:'#23405a', flood:0.06 },
  storm:      { key:'storm',      label:'Storm',      spd:0.50, cap:0.62, gap:1.50, icon:'🌪', tint:'#1d3550', flood:0.16 },
  flooded:    { key:'flooded',    label:'Flooded',    spd:0.36, cap:0.44, gap:1.62, icon:'🌊', tint:'#1a3348', flood:0.34 }
};


M.RCOND = {
  good:        { key:'good',        label:'Good',            spd:1.00, cap:1.00, lane:0 },
  fair:        { key:'fair',        label:'Fair',            spd:0.92, cap:0.96, lane:0 },
  damaged:     { key:'damaged',     label:'Damaged',         spd:0.72, cap:0.82, lane:0 },
  poor:        { key:'poor',        label:'Poor',            spd:0.58, cap:0.68, lane:0 },
  roadworks:   { key:'roadworks',   label:'Road works',      spd:0.44, cap:0.50, lane:1 },
  obstruction: { key:'obstruction', label:'Road obstruction',spd:0.40, cap:0.46, lane:1 },
  flooded:     { key:'flooded',     label:'Flooded road',    spd:0.30, cap:0.34, lane:1 }
};


M.LEVELS = [
  { key:'LOW',       max:0.35, color:'#22c55e', cls:'lv-low'   },
  { key:'MEDIUM',    max:0.60, color:'#eab308', cls:'lv-med'   },
  { key:'HIGH',      max:0.85, color:'#f97316', cls:'lv-high'  },
  { key:'VERY HIGH', max:1e9,  color:'#ef4444', cls:'lv-vhigh' }
];
M.level = function (x) {
  for (const L of M.LEVELS) if (x < L.max) return L;
  return M.LEVELS[3];
};
M.BLOCK_COLOR = '#a855f7';


M.SCENARIOS = [
  { key:'rush_hour',    label:'Rush Hour',            group:'demand', desc:'Demand ×1.9, heavier bus and jeepney share' },
  { key:'accident',     label:'Accident',             group:'inc',    desc:'A lane is closed at a random main-road location' },
  { key:'roadworks',    label:'Road Works',           group:'inc',    desc:'Lane closure with reduced speed on a main road' },
  { key:'obstruction',  label:'Road Obstruction',     group:'inc',    desc:'Debris or a parked vehicle blocks part of the road' },
  { key:'double_park',  label:'Double Parking',       group:'loc',    at:'smnhs',    desc:'Parked vehicles narrow the road near SMNHS' },
  { key:'dropoff',      label:'Student Drop-off',     group:'loc',    at:'smnhs',    desc:'Vehicles stop mid-road to unload students' },
  { key:'busstop',      label:'Bus Stop',             group:'loc',    at:'oriente',  desc:'Buses dwell at the Oriente stop, cutting capacity' },
  { key:'enforcer',     label:'Traffic Enforcer',     group:'loc',    at:'oriente',  desc:'Enforcer periodically halts one approach' },
  { key:'signal_fault', label:'Traffic Light Problem',group:'loc',    at:'camias',   desc:'Signals at Camias go to flashing / all-red fault' },
  { key:'violation',    label:'Traffic Rule Violation',group:'loc',   at:'camias',   desc:'Some drivers run the red light, causing conflicts' },
  { key:'crossover',    label:'Vehicle Crossover',    group:'loc',    at:'jollibee', desc:'Turning vehicles cross the main flow' },
  { key:'damaged_road', label:'Damaged Road',         group:'cond',   desc:'Random main segments set to Damaged' },
  { key:'poor_road',    label:'Poor Road Condition',  group:'cond',   desc:'Random segments set to Poor condition' },
  { key:'rain',         label:'Rain',                 group:'wx', wx:'rainy',      desc:'Weather → Rainy' },
  { key:'heavy_rain',   label:'Heavy Rain',           group:'wx', wx:'heavy_rain', desc:'Weather → Heavy rain' },
  { key:'storm',        label:'Storm',                group:'wx', wx:'storm',      desc:'Weather → Storm' },
  { key:'flooding',     label:'Flooding',             group:'wx', wx:'flooded',    desc:'Weather → Flooded; low roads near rivers close' }
];


M.SIGNAL = { green:22, yellow:4, allred:2 };


M.JAM_SPACING = 7.0;
M.PRACTICAL = 0.78;

M.baseCapacity = function (lengthM, lanes) {
  return Math.max(1, (lengthM / M.JAM_SPACING) * lanes * M.PRACTICAL);
};


M.effCapacity = function (seg, wx) {
  const rc = M.RCOND[seg.cond] || M.RCOND.good;
  const lanes = Math.max(0, seg.lanes - rc.lane - (seg.laneLoss || 0));
  if (lanes <= 0) return 0;
  const base = M.baseCapacity(seg.len, lanes);
  return base * rc.cap * wx.cap;
};


M.effSpeed = function (seg, wx) {
  const rc = M.RCOND[seg.cond] || M.RCOND.good;
  return seg.speed * rc.spd * wx.spd * (seg.spdFactor || 1);
};


M.densitySpeed = function (vFree, x) {
  if (x <= 0) return vFree;
  const f = Math.max(0.10, 1 - 0.92 * Math.pow(Math.min(x, 1.65), 1.35));
  return vFree * f;
};


M.R_EARTH = 6371000;
M.hav = function (a, b) {
  const p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
  const dp = p2 - p1, dl = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * M.R_EARTH * Math.asin(Math.sqrt(h));
};


M.MPD_LAT = 110574;
M.MPD_LON = 107630;


M.along = function (pts, cum, d) {
  const total = cum[cum.length - 1];
  if (d <= 0) return [pts[0][0], pts[0][1], M.bearing(pts[0], pts[1] || pts[0])];
  if (d >= total) {
    const n = pts.length;
    return [pts[n - 1][0], pts[n - 1][1], M.bearing(pts[n - 2] || pts[n - 1], pts[n - 1])];
  }
  let i = 1;
  while (i < cum.length && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / seg;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, M.bearing(a, b)];
};

M.bearing = function (a, b) {
  const y = (b[0] - a[0]) * M.MPD_LAT;
  const x = (b[1] - a[1]) * M.MPD_LON;
  return Math.atan2(x, y) * 180 / Math.PI;
};

M.cumulative = function (pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + M.hav(pts[i - 1], pts[i]));
  return c;
};


M.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
M.fmt = (v, d = 1) => (isFinite(v) ? v.toFixed(d) : '—');
M.pick = (arr, rng) => arr[Math.floor((rng ? rng() : Math.random()) * arr.length)];


M.rng = function (seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};


M.sampleType = function (rng, weights) {
  const w = weights || null;
  let total = 0;
  const acc = [];
  for (const k of M.VLIST) {
    const share = w && w[k] != null ? w[k] : M.VTYPES[k].share;
    total += share;
    acc.push([k, total]);
  }
  const r = rng() * total;
  for (const [k, c] of acc) if (r <= c) return k;
  return 'car';
};


M.demandCurve = function (hour) {
  const peaks = [[6.7, 1.00, 1.15], [12.2, 0.42, 0.95], [17.3, 0.92, 1.35]];
  let m = 0.30;
  for (const [c, amp, wid] of peaks) {
    m += amp * Math.exp(-Math.pow(hour - c, 2) / (2 * wid * wid));
  }
  return M.clamp(m, 0.22, 1.55);
};

M.phaseName = function (hour) {
  if (hour < 5) return 'Late night';
  if (hour < 7) return 'Early morning';
  if (hour < 9) return 'Morning peak';
  if (hour < 11.5) return 'Mid-morning';
  if (hour < 13.5) return 'Midday';
  if (hour < 16) return 'Afternoon';
  if (hour < 19) return 'Evening peak';
  if (hour < 21) return 'Evening';
  return 'Night';
};

window.M = M;
