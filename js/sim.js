
'use strict';

class Sim {
  constructor(net) {
    this.net = net;
    this.rngSeed = 20260830;
    this.rng = M.rng(this.rngSeed);

    this.buildGraph();

    this.weather = 'sunny';
    this.demand = 120;
    this.scenarios = new Set();
    this.startTime = 6 * 3600; 
    this.time = this.startTime;
    this.runDuration = 30 * 60; 
    this.runElapsed = 0;
    this.timerEnabled = true;
    this.dt = 0.6;             
    this.running = false;
    this.tick = 0;
    this.useClockDemand = false;
    this.testLocationId = '';
    this.localTestMode = true;

    this.vehicles = [];
    this.nextVid = 1;
    this.incidents = [];
    this.signals = [];
    this.history = [];
    this.eventLog = [];
    this.eventSeq = 0;
    this.lastActivityMinute = -1;
    this.lastLoggedLevel = null;
    this.completed = 0;
    this.totalDelay = 0;
    this.totalTrips = 0;

    this.initSignals();
    this.applyConditions();
    this.populate();
    this.computeStats();
    this.logEvent('system', 'Simulation loaded', 'San Miguel, Bulacan traffic network is ready for simulation.');
    this.logEvent('traffic', 'Initial traffic state', `${this.stats.vehicles} vehicles · ${M.fmt(this.stats.avgSpeed, 0)} km/h average · ${this.stats.level.key} network level.`);
    this.lastLoggedLevel = this.stats.level.key;
  }

  
  logEvent(category, title, detail, location = '') {
    const allowed = new Set(['traffic', 'weather', 'incident', 'system', 'location']);
    const cat = allowed.has(category) ? category : 'system';
    this.eventLog.push({
      id: ++this.eventSeq,
      time: this.time,
      category: cat,
      title: String(title || 'Event'),
      detail: String(detail || ''),
      location: String(location || '')
    });
    if (this.eventLog.length > 500) this.eventLog.splice(0, this.eventLog.length - 500);
  }

  scenarioLocationName(key) {
    const sc = M.SCENARIOS.find(x => x.key === key);
    if (!sc || !sc.at) return '';
    const loc = this.locs.find(x => x.id === sc.at);
    return loc ? loc.name : sc.at;
  }

  
  buildGraph() {
    const net = this.net;
    this.nodes = net.nodes;
    this.segs = net.segs.map((s, i) => {
      const cum = M.cumulative(s.pts);
      return {
        idx: i, id: s.id, name: s.name, hw: s.hw, a: s.a, b: s.b,
        pts: s.pts, cum: cum, len: s.len, lanes: s.lanes,
        speed: s.speed, rank: s.rank, dual: s.dual,
        cond: 'good', laneLoss: 0, spdFactor: 1,
        blocked: false, incident: null, floodDepth: 0,
        vehicles: [], count: 0, avgSpeed: s.speed, x: 0,
        level: M.LEVELS[0], density: 0, queue: 0,
        signalNode: null, stops: []
      };
    });
    this.byId = {};
    this.segs.forEach(s => { this.byId[s.id] = s; });

    
    this.out = Array.from({ length: this.nodes.length }, () => []);
    this.inn = Array.from({ length: this.nodes.length }, () => []);
    this.segs.forEach(s => { this.out[s.a].push(s.idx); this.inn[s.b].push(s.idx); });

    
    this.twin = new Array(this.segs.length).fill(-1);
    const key = new Map();
    this.segs.forEach(s => key.set(s.a + '_' + s.b, s.idx));
    this.segs.forEach(s => {
      const t = key.get(s.b + '_' + s.a);
      if (t != null) this.twin[s.idx] = t;
    });

    
    this.locs = net.locations.map(L => ({
      ...L,
      zoneIdx: L.zone.map(id => this.byId[id]).filter(Boolean).map(s => s.idx),
      mainIdx: L.main.map(id => this.byId[id]).filter(Boolean).map(s => s.idx),
      stats: { count: 0, speed: 0, x: 0, level: M.LEVELS[0], delay: 0, waiting: 0 }
    }));

    
    this.floodRank = this.segs.map(s => {
      let best = 1e9;
      const mid = s.pts[Math.floor(s.pts.length / 2)];
      for (const w of this.net.water) {
        for (const p of w.pts) {
          const d = M.hav(mid, p);
          if (d < best) best = d;
        }
      }
      return best;
    });
    this.floodOrder = this.segs.map((s, i) => i)
      .sort((p, q) => this.floodRank[p] - this.floodRank[q]);

    
    this.totalLenKm = this.segs.reduce((a, s) => a + s.len, 0) / 1000;

    
    (net.busstops || []).forEach(b => {
      const s = this.byId[b.seg];
      if (!s) return;
      const d = this.projectDist(s, b.lat, b.lon);
      s.stops.push({ name: b.name, d: d });
    });
  }

  projectDist(seg, lat, lon) {
    let best = 0, bd = 1e18;
    for (let i = 0; i < seg.pts.length; i++) {
      const d = M.hav([lat, lon], seg.pts[i]);
      if (d < bd) { bd = d; best = seg.cum[i]; }
    }
    return best;
  }

  
  initSignals() {
    this.signals = (this.net.signals || []).map(sg => {
      const phases = sg.phases.map(ids => ids.map(id => this.byId[id]).filter(Boolean).map(s => s.idx));
      const sig = {
        id: sg.id, node: sg.node, loc: sg.loc, lat: sg.lat, lon: sg.lon,
        phases: phases, cur: 0, state: 'green', t: 0, fault: false,
        cycle: M.SIGNAL.green + M.SIGNAL.yellow + M.SIGNAL.allred
      };
      phases.forEach(ph => ph.forEach(i => { this.segs[i].signalNode = sig; }));
      return sig;
    });
  }

  stepSignals(dt) {
    const fault = this.scenarios.has('signal_fault');
    for (const sg of this.signals) {
      
      const isFaulted = fault && (sg.loc === 'camias');
      sg.fault = isFaulted;
      if (isFaulted) {
        
        sg.t += dt;
        if (sg.t > 3) { sg.t = 0; sg.state = sg.state === 'red' ? 'yellow' : 'red'; }
        continue;
      }
      sg.t += dt;
      const q = (sg.phases[sg.cur] || []).reduce((n, si) => n + (this.segs[si].queue || 0), 0);
      const g = M.clamp(M.SIGNAL.green + Math.min(12, q * 0.8), 16, 34), y = M.SIGNAL.yellow, r = M.SIGNAL.allred;
      if (sg.state === 'green' && sg.t >= g) { sg.state = 'yellow'; sg.t = 0; }
      else if (sg.state === 'yellow' && sg.t >= y) { sg.state = 'allred'; sg.t = 0; }
      else if (sg.state === 'allred' && sg.t >= r) {
        sg.state = 'green'; sg.t = 0;
        sg.cur = (sg.cur + 1) % sg.phases.length;
      }
    }
  }

  
  signalFor(segIdx) {
    const s = this.segs[segIdx];
    const sg = s.signalNode;
    if (!sg) return null;
    const isGreenPhase = sg.phases[sg.cur] && sg.phases[sg.cur].includes(segIdx);
    if (sg.fault) return { sig: sg, light: 'fault' };
    if (!isGreenPhase) return { sig: sg, light: 'red' };
    if (sg.state === 'green') return { sig: sg, light: 'green' };
    if (sg.state === 'yellow') return { sig: sg, light: 'yellow' };
    return { sig: sg, light: 'red' };
  }

  
  applyConditions() {
    const S = this.scenarios;
    const rng = M.rng(this.rngSeed + 77);
    const wx = M.WEATHER[this.weather];

    
    this.segs.forEach(s => {
      s.cond = 'good'; s.laneLoss = 0; s.spdFactor = 1; s.floodDepth = 0;
      s.blocked = false; s.incident = null; s.stopped = null;
    });
    this.incidents = [];

    const mains = this.segs.filter(s => s.rank >= 3).map(s => s.idx);
    const addInc = (segIdx, type, label, icon, opts = {}) => {
      const s = this.segs[segIdx];
      if (opts.cond) s.cond = opts.cond;
      if (opts.laneLoss) s.laneLoss = Math.max(s.laneLoss, opts.laneLoss);
      if (opts.spdFactor) s.spdFactor = Math.min(s.spdFactor, opts.spdFactor);
      if (opts.blocked) s.blocked = true;
      
      if (opts.stopAt != null) {
        s.stopped = s.stopped || [];
        s.stopped.push({ d: opts.stopAt * s.len, type: type });
      }
      const inc = {
        seg: segIdx, segId: s.id, type, label, icon,
        road: s.name, loc: opts.loc || null,
        lat: 0, lon: 0, blocked: !!opts.blocked
      };
      const p = M.along(s.pts, s.cum, s.len * (opts.stopAt != null ? opts.stopAt : 0.55));
      inc.lat = p[0]; inc.lon = p[1];
      s.incident = inc;
      this.incidents.push(inc);
    };

    
    const loc = id => this.locs.find(l => l.id === id);

    if (S.has('double_park')) {
      const L = loc('smnhs');
      const pool = L.mainIdx.length ? L.mainIdx : L.zoneIdx;
      pool.slice(0, 2).forEach((si, k) => {
        addInc(si, 'double_park', 'Double parking', '🅿',
          { cond: 'obstruction', laneLoss: 1, spdFactor: 0.55, stopAt: 0.35 + 0.2 * k, loc: 'smnhs' });
      });
    }
    if (S.has('dropoff')) {
      const L = loc('smnhs');
      const pool = L.mainIdx.length ? L.mainIdx : L.zoneIdx;
      const si = pool[Math.min(2, pool.length - 1)];
      if (si != null) addInc(si, 'dropoff', 'Student drop-off (mid-road stop)', '🎒',
        { spdFactor: 0.45, laneLoss: 1, cond: 'obstruction', stopAt: 0.5, loc: 'smnhs' });
    }
    if (S.has('busstop')) {
      const L = loc('oriente');
      const withStop = L.zoneIdx.filter(i => this.segs[i].stops.length);
      const si = withStop.length ? withStop[0] : (L.mainIdx[0] ?? L.zoneIdx[0]);
      if (si != null) addInc(si, 'busstop', 'Bus dwelling at stop', '🚌',
        { spdFactor: 0.58, laneLoss: 1, stopAt: 0.6, loc: 'oriente' });
    }
    if (S.has('enforcer')) {
      const L = loc('oriente');
      const si = L.mainIdx[0] ?? L.zoneIdx[0];
      if (si != null) {
        addInc(si, 'enforcer', 'Traffic enforcer controlling flow', '👮',
          { spdFactor: 0.62, loc: 'oriente' });
        this.enforcerSeg = si;
      }
    } else this.enforcerSeg = null;

    if (S.has('crossover')) {
      const L = loc('jollibee');
      const pool = L.mainIdx.length ? L.mainIdx : L.zoneIdx;
      pool.slice(0, 2).forEach(si => {
        addInc(si, 'crossover', 'Vehicle crossover / turning conflict', '↔',
          { spdFactor: 0.60, loc: 'jollibee' });
      });
    }
    if (S.has('signal_fault')) {
      const L = loc('camias');
      const si = L.mainIdx[0] ?? L.zoneIdx[0];
      if (si != null) addInc(si, 'signal_fault', 'Traffic light malfunction', '🚦',
        { spdFactor: 0.55, loc: 'camias' });
    }
    if (S.has('violation')) {
      const L = loc('camias');
      const si = L.mainIdx[0] ?? L.zoneIdx[0];
      if (si != null) addInc(si, 'violation', 'Red-light violations at junction', '⚠',
        { spdFactor: 0.78, loc: 'camias' });
    }

    
    if (S.has('accident')) {
      const source = this.localTestMode && this.testLocationId ? this.testLocation().mainIdx : mains;
      const pool = source.filter(i => !this.segs[i].incident && this.segs[i].len > 60);
      const si = pool.length ? pool[Math.floor(rng() * pool.length)] : mains[0];
      if (si != null) addInc(si, 'accident', 'Road accident — lane closed', '💥',
        { cond: 'obstruction', laneLoss: 1, spdFactor: 0.30, stopAt: 0.45 });
    }
    if (S.has('roadworks')) {
      const source = this.localTestMode && this.testLocationId ? this.testLocation().mainIdx : mains;
      const pool = source.filter(i => !this.segs[i].incident && this.segs[i].len > 50);
      for (let k = 0; k < 2 && pool.length; k++) {
        const si = pool.splice(Math.floor(rng() * pool.length), 1)[0];
        addInc(si, 'roadworks', 'Road works — lane closure', '🚧',
          { cond: 'roadworks', laneLoss: 1, stopAt: 0.5 });
      }
    }
    if (S.has('obstruction')) {
      const source = this.localTestMode && this.testLocationId ? this.testLocation().zoneIdx.map(i => this.segs[i]).filter(s => s.rank >= 2 && !s.incident && s.len > 40) : this.segs.filter(s => s.rank >= 2 && !s.incident && s.len > 40);
      const pool = source.map(s => s.idx);
      for (let k = 0; k < 2 && pool.length; k++) {
        const si = pool.splice(Math.floor(rng() * pool.length), 1)[0];
        addInc(si, 'obstruction', 'Obstruction blocking part of road', '⛔',
          { cond: 'obstruction', laneLoss: 1, stopAt: 0.4 + 0.25 * k });
      }
    }
    if (S.has('damaged_road')) {
      const source = this.localTestMode && this.testLocationId ? this.testLocation().mainIdx : mains;
      const pool = source.filter(i => this.segs[i].cond === 'good');
      const n = Math.max(3, Math.round(pool.length * 0.16));
      for (let k = 0; k < n && pool.length; k++) {
        const si = pool.splice(Math.floor(rng() * pool.length), 1)[0];
        this.segs[si].cond = 'damaged';
      }
    }
    if (S.has('poor_road')) {
      const source = this.localTestMode && this.testLocationId ? this.testLocation().zoneIdx.map(i => this.segs[i]).filter(s => s.cond === 'good' && s.rank <= 3) : this.segs.filter(s => s.cond === 'good' && s.rank <= 3);
      const pool = source.map(s => s.idx);
      const n = Math.max(4, Math.round(pool.length * 0.18));
      for (let k = 0; k < n && pool.length; k++) {
        const si = pool.splice(Math.floor(rng() * pool.length), 1)[0];
        this.segs[si].cond = 'poor';
      }
    }

    
    if (wx.flood > 0) {
      const floodPool = this.localTestMode && this.testLocationId
        ? this.testLocation().zoneIdx.slice().sort((a, b) => this.floodRank[a] - this.floodRank[b])
        : this.floodOrder;
      const n = Math.max(1, Math.round(floodPool.length * wx.flood));
      let applied = 0;
      for (const si of floodPool) {
        if (applied >= n) break;
        const s = this.segs[si];
        if (s.cond !== 'good' && s.cond !== 'fair') continue;
        s.cond = 'flooded';
        const risk = M.clamp(1 - this.floodRank[si] / 500, 0, 1);
        s.floodDepth = Math.max(0.08, wx.flood * (0.55 + 0.75 * risk));
        applied++;
        
        if (wx.flood >= 0.30 && applied % 5 === 0 && s.rank <= 2) {
          s.blocked = true;
          const p = M.along(s.pts, s.cum, s.len * 0.5);
          const inc = {
            seg: si, segId: s.id, type: 'flood', label: 'Impassable flood',
            icon: '🌊', road: s.name, loc: null, lat: p[0], lon: p[1], blocked: true
          };
          s.incident = inc;
          this.incidents.push(inc);
        }
      }
    }

    
    
    this.ensureExits();
    this.buildRouteCache();
    this.routeVersion++;
  }

  ensureExits() {
    for (let n = 0; n < this.nodes.length; n++) {
      const outs = this.out[n];
      if (!outs.length) continue;
      const open = outs.filter(i => !this.segs[i].blocked);
      if (open.length === 0) {
        
        let best = outs[0];
        for (const i of outs) if (this.segs[i].rank > this.segs[best].rank) best = i;
        const s = this.segs[best];
        s.blocked = false;
        s.cond = s.cond === 'flooded' ? 'poor' : s.cond;
        this.incidents = this.incidents.filter(inc => !(inc.seg === best && inc.blocked));
        if (s.incident && s.incident.blocked) s.incident = null;
      }
    }
  }

  
  buildRouteCache() { this.routeCache = new Map(); }

  roadAllowed(v, seg) {
    if (!seg || seg.blocked) return false;
    
    
    
    if (this.localTestMode && this.testLocationId && this.testZoneSet.size && !this.testZoneSet.has(seg.idx)) return false;
    const T = v && v.t;
    if (seg.cond === 'flooded' && T && seg.floodDepth > (T.maxFlood || 0.2)) return false;
    return true;
  }

  
  chooseNext(seg, dest, vehicle) {
    const node = seg.b;
    const key = node + '>' + dest + ':' + this.routeVersion;
    const cached = this.routeCache.get(key);
    if (cached != null && this.roadAllowed(vehicle, this.segs[cached])) return cached;
    const n = this.nodes.length;
    const dist = new Float64Array(n); dist.fill(Infinity);
    const prev = new Int32Array(n); prev.fill(-1);
    const used = new Uint8Array(n);
    dist[node] = 0;
    for (let iter = 0; iter < n; iter++) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!used[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === dest) break;
      used[u] = 1;
      for (const si of this.out[u]) {
        const c = this.segs[si];
        if (!this.roadAllowed(vehicle, c)) continue;
        const occ = c.count / Math.max(1, c.capNow || 1);
        const congestion = 1 + 2.4 * Math.pow(M.clamp(occ, 0, 2), 2);
        const condition = c.cond === 'poor' ? 1.25 : c.cond === 'damaged' ? 1.4 : c.cond === 'roadworks' ? 1.7 : 1;
        const flood = c.floodDepth > 0 ? 1 + c.floodDepth * 3 : 1;
        const speedPenalty = 40 / Math.max(8, c.freeSpeed || c.speed);
        const nd = dist[u] + c.len * congestion * condition * flood * speedPenalty;
        if (nd < dist[c.b]) { dist[c.b] = nd; prev[c.b] = si; }
      }
    }
    let cur = dest, first = -1;
    while (cur !== node && cur >= 0) {
      const si = prev[cur];
      if (si < 0) break;
      first = si; cur = this.segs[si].a;
    }
    if (first >= 0) this.routeCache.set(key, first);
    if (first < 0) {
      for (const si of this.out[node]) if (this.roadAllowed(vehicle, this.segs[si]) && si !== this.twin[seg.idx]) return si;
      for (const si of this.out[node]) if (this.roadAllowed(vehicle, this.segs[si])) return si;
    }
    return first >= 0 ? first : null;
  }

  testLocation() {
    return this.testLocationId ? this.locs.find(L => L.id === this.testLocationId) || null : null;
  }

  testSegmentPool() {
    const L = this.testLocation();
    if (!this.localTestMode || !L) return this.segs;
    const ids = L.zoneIdx.length ? L.zoneIdx : L.mainIdx;
    return ids.map(i => this.segs[i]).filter(Boolean);
  }

  randomNode() {
    
    const pool = this.testSegmentPool();
    if (this.localTestMode && this.testLocationId && pool.length) {
      const s = pool[Math.floor(this.rng() * pool.length)];
      return s.b;
    }
    
    for (let k = 0; k < 12; k++) {
      const i = Math.floor(this.rng() * this.segs.length);
      if (this.segs[i].rank >= 3) return this.segs[i].b;
    }
    return Math.floor(this.rng() * this.nodes.length);
  }

  
  fleetWeights() {
    if (this.scenarios.has('rush_hour')) {
      return { motorcycle:0.32, car:0.33, tricycle:0.13, jeepney:0.11, bus:0.055, truck:0.05, emergency:0.005 };
    }
    return null;
  }

  targetCount() {
    let n = this.demand;
    if (this.scenarios.has('rush_hour')) n = Math.round(n * 1.9);
    if (this.useClockDemand) n = Math.round(n * M.demandCurve(this.time / 3600));
    return M.clamp(n, 5, 900);
  }

  spawn() {
    const w = this.fleetWeights();
    const tk = M.sampleType(this.rng, w);
    const T = M.VTYPES[tk];
    
    let seg = null;
    const spawnPool = this.testSegmentPool();
    for (let k = 0; k < 30; k++) {
      const cand = spawnPool[Math.floor(this.rng() * spawnPool.length)];
      if (!cand || cand.blocked) continue;
      const cap = cand.capNow || M.effCapacity(cand, M.WEATHER[this.weather]);
      if (cand.count < cap * 0.82) { seg = cand; break; }
    }
    if (!seg && this.localTestMode && this.testLocationId) {
      for (const cand of spawnPool) {
        if (!cand.blocked) { seg = cand; break; }
      }
    }
    if (!seg) return null;
    const v = {
      id: this.nextVid++, type: tk, t: T,
      seg: seg.idx, d: this.rng() * Math.max(1, seg.len - T.len),
      v: M.effSpeed(seg, M.WEATHER[this.weather]) / 3.6 * 0.5,
      dest: this.randomNode(),
      lat: 0, lon: 0, hdg: 0,
      wait: 0, travel: 0, freeTravel: 0, dist: 0,
      stoppedFlag: false, hops: 0, violator: this.rng() < 0.07,
      dwell: 0, lane: this.rng() < 0.5 ? -1 : 1
    };
    seg.vehicles.push(v);
    this.vehicles.push(v);
    this.place(v);
    return v;
  }

  place(v) {
    const s = this.segs[v.seg];
    const p = M.along(s.pts, s.cum, v.d);
    
    const off = s.dual ? 0.000018 : 0.0000075;
    const rad = (p[2] + 90) * Math.PI / 180;
    v.lat = p[0] + Math.cos(rad) * off;
    v.lon = p[1] + Math.sin(rad) * off / Math.cos(p[0] * Math.PI / 180);
    v.hdg = p[2];
  }

  populate() {
    this.vehicles.forEach(v => { });
    this.segs.forEach(s => { s.vehicles = []; s.count = 0; });
    this.vehicles = [];
    this.nextVid = 1;
    this.refreshCapacities();
    const n = this.targetCount();
    for (let i = 0; i < n; i++) this.spawn();
    this.refreshSegments();
  }

  refreshCapacities() {
    const wx = M.WEATHER[this.weather];
    for (const s of this.segs) {
      s.capNow = M.effCapacity(s, wx);
      s.freeSpeed = M.effSpeed(s, wx);
    }
  }

  
  step(dtOverride) {
    const dt = dtOverride || this.dt;
    const wx = M.WEATHER[this.weather];
    this.time = (this.time + dt) % 86400;
    this.runElapsed += Math.max(0, dt);
    this.tick++;

    
    this.stepSignals(dt);
    if (this.tick % 25 === 0) { this.routeVersion++; this.routeCache.clear(); }

    
    this.enforcerHold = false;
    if (this.enforcerSeg != null) {
      this.enforcerHold = (this.time % 90) < 32;
    }

    
    const target = this.targetCount();
    let diff = target - this.vehicles.length;
    if (diff > 0) for (let i = 0; i < Math.min(diff, 6); i++) this.spawn();
    else if (diff < 0) {
      for (let i = 0; i < Math.min(-diff, 6); i++) {
        const v = this.vehicles.pop();
        if (!v) break;
        const s = this.segs[v.seg];
        const k = s.vehicles.indexOf(v);
        if (k >= 0) s.vehicles.splice(k, 1);
      }
    }

    
    for (const s of this.segs) {
      if (s.vehicles.length > 1) s.vehicles.sort((a, b) => a.d - b.d);
    }

    
    for (const s of this.segs) {
      const vFree = s.freeSpeed / 3.6;                 
      const x = s.count / Math.max(1, s.capNow);
      const vTarget = M.densitySpeed(vFree, x);
      const list = s.vehicles;

      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const T = v.t;
        let behavior = T.key === 'motorcycle' ? 1.12 : T.key === 'car' ? 1.0 : T.key === 'tricycle' ? 0.88 : (T.key === 'bus' || T.key === 'truck') ? 0.76 : 1.04;
        if ((T.key === 'bus' || T.key === 'jeepney') && s.stops.length) behavior *= 0.72;
        const v0 = Math.max(1.4, vTarget * T.vmax * behavior);
        const gapFactor = wx.gap;
        const s0 = 1.6 + T.len * 0.28;
        const Tgap = 1.05 * gapFactor;

        
        let gap = Infinity, dv = 0;
        const lead = list[i + 1];
        if (lead) {
          gap = (lead.d - lead.t.len) - v.d;
          dv = v.v - lead.v;
        }

        
        if (s.stopped) {
          for (const st of s.stopped) {
            const g = st.d - v.d;
            if (g > 0 && g < gap) { gap = g; dv = v.v; }
          }
        }

        
        const distEnd = s.len - v.d;
        let mustStop = false;
        const sigInfo = this.signalFor(s.idx);
        if (sigInfo) {
          const L = sigInfo.light;
          if (L === 'red') mustStop = !(v.violator && this.scenarios.has('violation'));
          else if (L === 'yellow') mustStop = distEnd > 12 && !(v.violator && this.scenarios.has('violation'));
          else if (L === 'fault') mustStop = (v.id % 3 !== 0) && distEnd < 26; 
          if (v.type === 'emergency') mustStop = false;
        }
        if (this.enforcerHold && s.idx === this.enforcerSeg && v.type !== 'emergency') mustStop = true;

        
        let nextFull = false;
        if (!mustStop && distEnd < 42) {
          const ni = v.next != null ? v.next : (v.next = this.chooseNext(s, v.dest, v));
          if (ni != null) {
            const nx = this.segs[ni];
            if (!this.roadAllowed(v, nx)) { v.next = this.chooseNext(s, v.dest, v); }
            const nn = this.segs[v.next != null ? v.next : ni];
            if (nn && nn.count >= nn.capNow * 1.06) nextFull = true;
          }
        }
        if (mustStop || nextFull) {
          const stopGap = distEnd - 1.2;
          if (stopGap < gap) { gap = Math.max(0.05, stopGap); dv = v.v; }
        }

        
        const sStar = s0 + Math.max(0, v.v * Tgap + (v.v * dv) / (2 * Math.sqrt(T.acc * T.dec)));
        let acc = T.acc * (1 - Math.pow(v.v / v0, 4) - Math.pow(sStar / Math.max(0.6, gap), 2));
        acc = M.clamp(acc, -T.dec * 2.4, T.acc);

        v.v = Math.max(0, v.v + acc * dt);
        if (gap < 0.9) v.v = 0;

        
        if ((v.type === 'bus' || v.type === 'jeepney') && s.stops.length && this.scenarios.has('busstop')) {
          for (const st of s.stops) {
            if (Math.abs(v.d - st.d) < 6 && v.dwell <= 0 && !v.dwelled) {
              v.dwell = v.type === 'bus' ? 12 : 7;
              v.dwelled = true;
            }
          }
        }
        if (v.dwell > 0) { v.dwell -= dt; v.v = 0; }

        const adv = v.v * dt;
        v.d += adv;
        v.dist += adv;
        v.travel += dt;
        v.freeTravel += (adv / Math.max(1.4, s.freeSpeed / 3.6));
        v.stoppedFlag = v.v < 1.0;
        if (v.stoppedFlag) v.wait += dt; else v.wait = Math.max(0, v.wait - dt * 0.35);
      }
    }

    
    for (const s of this.segs) {
      for (let i = s.vehicles.length - 1; i >= 0; i--) {
        const v = s.vehicles[i];
        if (v.d < s.len) continue;
        
        if (v.seg !== undefined && s.b === v.dest) {
          
          this.completed++;
          this.totalTrips++;
          this.totalDelay += Math.max(0, v.travel - v.freeTravel);
          v.travel = 0; v.freeTravel = 0; v.dist = 0;
          v.dest = this.randomNode(); v.next = null;
        }
        let ni = v.next != null ? v.next : this.chooseNext(s, v.dest, v);
        if (ni == null || !this.roadAllowed(v, this.segs[ni])) ni = this.chooseNext(s, v.dest, v);
        if (ni == null) { v.d = s.len - 0.5; v.v = 0; continue; }
        const nx = this.segs[ni];
        
        if (!this.roadAllowed(v, nx)) { v.next = null; v.d = Math.max(0, s.len - 1.0); v.v = 0; v.wait += dt; continue; }
        if (nx.count >= nx.capNow * 1.25) {
          v.d = Math.max(0, s.len - 1.0);
          v.v = 0; v.wait += this.dt;
          continue;
        }
        s.vehicles.splice(i, 1);
        v.seg = ni; v.d = Math.max(0, v.d - s.len); v.next = null;
        v.dwelled = false; v.hops++;
        nx.vehicles.push(v);
      }
    }

    for (const v of this.vehicles) this.place(v);
    this.refreshSegments();
    if (this.tick % 25 === 0) this.pushHistory();

    
    
    
    const activityMinute = Math.floor(this.runElapsed / 60);
    if (activityMinute !== this.lastActivityMinute) {
      this.lastActivityMinute = activityMinute;
      const st = this.computeStats();
      const level = st.level.key;
      this.logEvent('traffic', 'Traffic update', `${st.vehicles} vehicles · ${M.fmt(st.avgSpeed, 0)} km/h average · ${level} network level · ${st.waiting} waiting.`, this.localTestMode && this.testLocationId ? (this.testLocation()?.name || '') : 'San Miguel, Bulacan');
      if (this.lastLoggedLevel && level !== this.lastLoggedLevel) {
        this.logEvent('traffic', `Traffic level changed to ${level}`, `Network v/c ratio is ${M.fmt(st.vc, 2)} with ${M.fmt(st.congestedPct, 0)}% of directed road segments congested.`, 'San Miguel, Bulacan');
      }
      this.lastLoggedLevel = level;
    }
  }

  
  refreshSegments() {
    for (const s of this.segs) {
      s.count = s.vehicles.length;
      let sum = 0, q = 0;
      for (const v of s.vehicles) { sum += v.v * 3.6; if (v.stoppedFlag) q++; }
      s.avgSpeed = s.count ? sum / s.count : s.freeSpeed || s.speed;
      s.queue = q;
      s.density = s.count / (s.len / 1000);
      s.x = s.capNow > 0 ? s.count / s.capNow : 2;
      s.level = s.blocked ? { key:'BLOCKED', color:M.BLOCK_COLOR, cls:'lv-vhigh' } : M.level(s.x);
    }
  }

  
  computeStats() {
    const n = this.vehicles.length;
    let spd = 0, waiting = 0, wsum = 0;
    for (const v of this.vehicles) {
      spd += v.v * 3.6;
      if (v.stoppedFlag) waiting++;
      wsum += v.wait;
    }
    const avgSpeed = n ? spd / n : 0;

    let cong = 0, capTotal = 0, occTotal = 0, freeSum = 0, lenSum = 0;
    for (const s of this.segs) {
      if (s.blocked || s.x >= 0.60) cong++;
      capTotal += s.capNow;
      occTotal += s.count;
      freeSum += s.freeSpeed * s.len;
      lenSum += s.len;
    }
    const freeAvg = lenSum ? freeSum / lenSum : 40;

    
    const tripKm = 3;
    const tActual = avgSpeed > 0.5 ? (tripKm / avgSpeed) * 60 : 99;
    const tFree = (tripKm / Math.max(5, freeAvg)) * 60;
    const delay = Math.max(0, tActual - tFree);

    const density = this.totalLenKm ? n / this.totalLenKm : 0;
    const vc = capTotal > 0 ? occTotal / capTotal : 0;

    this.stats = {
      vehicles: n,
      avgSpeed: avgSpeed,
      freeSpeed: freeAvg,
      travel: Math.min(tActual, 99),
      freeTravel: tFree,
      delay: delay,
      density: density,
      waiting: waiting,
      avgWait: n ? wsum / n : 0,
      congested: cong,
      congestedPct: this.segs.length ? (cong / this.segs.length) * 100 : 0,
      capacity: capTotal,
      occupancy: occTotal,
      vc: vc,
      level: M.level(vc),
      incidents: this.incidents.length,
      weather: M.WEATHER[this.weather],
      completed: this.completed,
      lengthKm: this.totalLenKm,
      segCount: this.segs.length
    };

    
    for (const L of this.locs) {
      let c = 0, sp = 0, cap = 0, occ = 0, w = 0, inc = 0, blocked = 0;
      for (const si of L.zoneIdx) {
        const s = this.segs[si];
        c += s.count;
        sp += s.avgSpeed * s.count;
        cap += s.capNow;
        occ += s.count;
        w += s.queue;
        if (s.incident) inc++;
        if (s.blocked) blocked++;
      }
      const x = cap > 0 ? occ / cap : 0;
      const asp = c ? sp / c : 0;
      let free = 0, ln = 0;
      for (const si of L.zoneIdx) { free += this.segs[si].freeSpeed * this.segs[si].len; ln += this.segs[si].len; }
      const fs = ln ? free / ln : 40;
      const ta = asp > 0.5 ? (1 / asp) * 60 : 60;
      const tf = (1 / Math.max(5, fs)) * 60;
      L.stats = {
        count: c, speed: asp, x: x, level: M.level(x),
        delay: Math.max(0, ta - tf), waiting: w, incidents: inc,
        blocked: blocked, capacity: cap, freeSpeed: fs,
        density: ln ? c / (ln / 1000) : 0
      };
    }
    return this.stats;
  }

  pushHistory() {
    const s = this.computeStats();
    this.history.push({ t: this.time, spd: s.avgSpeed, cong: s.congestedPct, veh: s.vehicles });
    if (this.history.length > 160) this.history.shift();
  }

  
  setTestLocation(id, localMode = true) {
    this.testLocationId = id || '';
    this.localTestMode = !!localMode && !!this.testLocationId;
    const L = this.testLocation();
    this.testZoneSet = new Set(L ? L.zoneIdx : []);
    this.routeVersion++;
    this.routeCache.clear();
    this.populate();
    this.computeStats();
    this.logEvent('location', 'Focused location changed', `Simulation is now focused on ${L ? L.name : 'the selected area'}.`, L ? L.name : 'San Miguel, Bulacan');
  }

  clearTestLocation() {
    this.testLocationId = '';
    this.localTestMode = false;
    this.testZoneSet = new Set();
    this.routeVersion++;
    this.routeCache.clear();
    this.populate();
    this.computeStats();
    this.logEvent('location', 'Focused location cleared', 'Simulation returned to the whole San Miguel, Bulacan network.', 'San Miguel, Bulacan');
  }

  setWeather(k) {
    if (!M.WEATHER[k]) return;
    this.weather = k;
    this.applyConditions();
    this.refreshCapacities();
    this.refreshSegments();
    this.computeStats();
    const wx = M.WEATHER[k];
    const affected = this.incidents.slice(0, 4).map(i => i.road).filter(Boolean);
    const incidentText = this.incidents.length ? ` ${this.incidents.length} active incident${this.incidents.length > 1 ? 's' : ''}${affected.length ? ` on ${affected.join(', ')}` : ''}.` : '';
    this.logEvent('weather', `Weather changed to ${wx.label}`, `Speed ×${wx.spd.toFixed(2)} · capacity ×${wx.cap.toFixed(2)}.${incidentText}`, 'San Miguel, Bulacan');
  }

  toggleScenario(k) {
    const sc = M.SCENARIOS.find(s => s.key === k);
    if (!sc) return;
    if (sc.group === 'wx') {
      
      M.SCENARIOS.filter(s => s.group === 'wx').forEach(s => { if (s.key !== k) this.scenarios.delete(s.key); });
      if (this.scenarios.has(k)) { this.scenarios.delete(k); this.weather = 'sunny'; }
      else { this.scenarios.add(k); this.weather = sc.wx; }
    } else {
      if (this.scenarios.has(k)) this.scenarios.delete(k); else this.scenarios.add(k);
    }
    this.applyConditions();
    this.refreshCapacities();
    this.refreshSegments();
    this.computeStats();
    const enabled = this.scenarios.has(k);
    const location = this.scenarioLocationName(k);
    let detail = enabled ? (sc ? sc.desc : 'Scenario enabled.') : 'Scenario disabled.';
    if (enabled && this.incidents.length) {
      const roads = this.incidents.slice(0, 4).map(i => i.road).filter(Boolean);
      detail += ` Active now: ${this.incidents.length} incident${this.incidents.length > 1 ? 's' : ''}${roads.length ? ` (${roads.join(', ')})` : ''}.`;
    }
    this.logEvent(sc && sc.group === 'wx' ? 'weather' : 'incident', `${enabled ? 'Started' : 'Stopped'}: ${sc ? sc.label : k}`, detail, location || 'San Miguel, Bulacan');
  }

  clearScenarios() {
    this.scenarios.clear();
    this.weather = 'sunny';
    this.applyConditions();
    this.refreshCapacities();
    this.refreshSegments();
    this.computeStats();
    this.logEvent('system', 'Scenarios cleared', 'All active weather and traffic scenarios were removed.');
  }

  setDemand(n) {
    this.demand = n;
    this.computeStats();
  }

  setRunDuration(seconds) {
    const sec = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 1800)));
    this.runDuration = sec;
    this.runElapsed = Math.min(this.runElapsed, this.runDuration);
    return sec;
  }

  setStartTime(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const min = Math.max(0, Math.min(59, Number(m[2])));
    this.startTime = h * 3600 + min * 60;
    this.time = this.startTime;
    this.runElapsed = 0;
    return true;
  }

  reset() {
    this.rng = M.rng(this.rngSeed);
    this.time = this.startTime;
    this.runElapsed = 0;
    this.tick = 0;
    this.completed = 0;
    this.totalDelay = 0;
    this.totalTrips = 0;
    this.history = [];
    this.lastActivityMinute = -1;
    this.lastLoggedLevel = this.stats ? this.stats.level.key : null;
    this.applyConditions();
    this.populate();
    this.computeStats();
    this.logEvent('system', 'Simulation reset', `Clock reset to ${this.formatClock(this.time)} and vehicle state was regenerated.`);
  }

  formatClock(seconds) {
    const t = ((Number(seconds) || 0) % 86400 + 86400) % 86400;
    return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  }

  
  runSteps(n, dt) {
    for (let i = 0; i < n; i++) this.step(dt || this.dt);
    return this.computeStats();
  }

  snapshot(label) {
    const s = this.computeStats();
    return {
      label: label,
      weather: M.WEATHER[this.weather].label,
      scenarios: [...this.scenarios].map(k => (M.SCENARIOS.find(x => x.key === k) || {}).label).filter(Boolean),
      vehicles: s.vehicles,
      speed: s.avgSpeed,
      travel: s.travel,
      delay: s.delay,
      density: s.density,
      waiting: s.waiting,
      congested: s.congested,
      vc: s.vc,
      level: s.level.key,
      incidents: s.incidents,
      locs: this.locs.map(L => ({ id: L.id, name: L.name, level: L.stats.level.key, speed: L.stats.speed, x: L.stats.x }))
    };
  }
}

window.Sim = Sim;
