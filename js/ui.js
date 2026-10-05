/* ═══════════════════════════════════════════════════════════════════
   ui.js — controls, analytics dashboard, inspector, comparison
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let sim, view, raf = null, lastFrame = 0, captures = { A: null, B: null };
let selectedInfo = null;
let uiTheme = localStorage.getItem('traffic-ui-theme') || 'dark';

/* ════════════════════════ boot ════════════════════════ */
(async function boot() {
  let net;
  try {
    const res = await fetch('data/network.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    net = await res.json();
  } catch (e) {
    $('#loading').innerHTML = `<div style="max-width:340px;text-align:center;line-height:1.6">
      <b style="color:#ef4444">Could not load the road network.</b><br>
      <span style="font-size:11px;color:#8fa3ba">data/network.json failed to load (${e.message}).
      Serve this folder over HTTP rather than opening the file directly.</span></div>`;
    return;
  }

  sim = new Sim(net);
  window.sim = sim;
  view = new MapView(sim, { onSelect: onMapSelect });
  window.view = view;

  buildScenarioChips();
  buildLocationList();
  buildPresets();
  applyTheme();
  bindControls();
  renderAll();

  requestAnimationFrame(() => { $('#loading').classList.add('done'); });
})();

/* ════════════════════════ control binding ════════════════════════ */
function bindControls() {
  // tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('is-on', x === t));
    $$('.tabpane').forEach(p => p.classList.toggle('is-on', p.dataset.pane === t.dataset.tab));
    if (t.dataset.tab === 'analytics') drawChart();
  }));

  // mobile bar + panel toggle
  $$('.mb').forEach(b => b.addEventListener('click', () => {
    const tab = $$('.tab').find(x => x.dataset.tab === b.dataset.mb);
    if (tab) tab.click();
    $('#side').classList.add('is-open');
    $$('.mb').forEach(x => x.classList.toggle('is-on', x === b));
  }));
  $('#btnPanel').addEventListener('click', () => $('#side').classList.toggle('is-open'));
  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnPresentation').addEventListener('click', () => document.body.classList.toggle('presentation'));

  $$('.profile-btn').forEach(b => b.addEventListener('click', () => {
    $$('.profile-btn').forEach(x => x.classList.toggle('is-on', x === b));
    if (b.dataset.profile === 'manual') { sim.useClockDemand = false; $('#demand').disabled = false; $('#demandNote').textContent = 'Manual demand: vehicles injected into the directed network.'; }
    if (b.dataset.profile === 'clock') { sim.useClockDemand = true; $('#demand').disabled = false; $('#demandNote').textContent = 'Demand follows the simulated time-of-day curve.'; }
    if (b.dataset.profile === 'rush') { sim.useClockDemand = false; $('#demand').disabled = false; $('#demand').value = 300; $('#demandTxt').textContent = '300'; sim.setDemand(300); sim.scenarios.add('rush_hour'); syncScenarioUI(); sim.applyConditions(); sim.refreshCapacities(); sim.refreshSegments(); sim.computeStats(); view.drawIncidents(); view.refresh(); renderAll(); }
  }));
  $('#map').addEventListener('click', () => {
    if (window.innerWidth <= 860) $('#side').classList.remove('is-open');
  });

  // run controls
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnStep').addEventListener('click', () => {
    sim.step(sim.dt * 5);
    sim.computeStats();
    view.refresh();
    renderAll();
  });
  $('#btnReset').addEventListener('click', () => {
    sim.reset();
    view.drawIncidents();
    view.refresh();
    renderAll();
  });
  $('#simSpeed').addEventListener('input', e => {
    $('#simSpeedTxt').textContent = e.target.value + '\u00d7';
  });

  // demand
  $('#demand').addEventListener('input', e => {
    const n = +e.target.value;
    $('#demandTxt').textContent = n;
    sim.setDemand(n);
    renderKpis();
  });

  // weather
  $$('#weatherCtl button').forEach(b => b.addEventListener('click', () => {
    $$('#weatherCtl button').forEach(x => x.classList.toggle('is-on', x === b));
    sim.setWeather(b.dataset.w);
    // keep weather-scenario chips consistent
    const wxScn = M.SCENARIOS.filter(s => s.group === 'wx');
    wxScn.forEach(s => sim.scenarios.delete(s.key));
    const match = wxScn.find(s => s.wx === b.dataset.w);
    if (match) sim.scenarios.add(match.key);
    sim.applyConditions(); sim.refreshCapacities(); sim.refreshSegments(); sim.computeStats();
    view.drawIncidents(); view.refresh();
    renderAll();
  }));

  $('#btnClearScn').addEventListener('click', () => {
    sim.clearScenarios();
    syncScenarioUI();
    view.drawIncidents(); view.refresh();
    renderAll();
  });

  // focused test location
  $('#btnApplyLocation').addEventListener('click', () => {
    const id = $('#testLocation').value;
    const local = $('#localTest').checked;
    if (!id || !local) {
      sim.clearTestLocation();
      view.setFocusedLocation();
      setTestLocationUI('');
      view.clearZoneHighlight();
      renderAll();
      return;
    }
    applyTestLocation(id);
  });
  $('#btnClearLocation').addEventListener('click', () => {
    $('#testLocation').value = '';
    sim.clearTestLocation();
    view.setFocusedLocation();
    setTestLocationUI('');
    view.clearZoneHighlight();
    renderAll();
  });
  $('#testLocation').addEventListener('change', e => {
    const L = sim.locs.find(x => x.id === e.target.value);
    if (L) {
      view.flyTo(L.lat, L.lon, 16.8);
      view.highlightZone(L);
    }
  });
  $('#localTest').addEventListener('change', () => {
    if (!$('#localTest').checked) {
      sim.clearTestLocation();
      view.setFocusedLocation();
      setTestLocationUI('');
      view.clearZoneHighlight();
      renderAll();
    }
  });

  // layer toggles
  const map = { tgVeh:'veh', tgArrow:'arrow', tgTraffic:'traffic', tgSignal:'signal',
                tgIncident:'incident', tgLm:'lm', tgWater:'water', tgLabel:'label' };
  Object.entries(map).forEach(([id, key]) => {
    $('#' + id).addEventListener('change', e => view.setLayer(key, e.target.checked));
  });

  // inspector close
  $('#inspClose').addEventListener('click', () => {
    $('#inspector').classList.remove('is-on');
    view.clearSelection();
    selectedInfo = null;
  });

  // comparison
  $('#btnCapA').addEventListener('click', () => { captures.A = sim.snapshot('A'); renderCompare(); });
  $('#btnCapB').addEventListener('click', () => { captures.B = sim.snapshot('B'); renderCompare(); });
  $('#btnCapClr').addEventListener('click', () => { captures = { A:null, B:null }; renderCompare(); });

  // keyboard
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 's' || e.key === 'S') $('#btnStep').click();
    if (e.key === 'r' || e.key === 'R') $('#btnReset').click();
  });
}

function applyTheme() {
  document.body.classList.toggle('light-ui', uiTheme === 'light');
  const b = $('#btnTheme');
  if (b) b.textContent = uiTheme === 'light' ? '☾' : '☼';
}
function toggleTheme() {
  uiTheme = uiTheme === 'light' ? 'dark' : 'light';
  localStorage.setItem('traffic-ui-theme', uiTheme);
  applyTheme();
}

function togglePlay() {
  sim.running = !sim.running;
  const b = $('#btnPlay');
  b.classList.toggle('is-run', sim.running);
  $('#playIco').innerHTML = sim.running ? '&#10074;&#10074;' : '&#9654;';
  $('#playTxt').textContent = sim.running ? 'Pause' : 'Start';
  if (sim.running) { lastFrame = performance.now(); loop(); }
  else if (raf) { cancelAnimationFrame(raf); raf = null; }
}

/* ════════════════════════ animation loop ════════════════════════ */
function loop() {
  if (!sim.running) return;
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  const real = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const mult = +$('#simSpeed').value;
  const steps = Math.max(1, Math.round(mult));
  const dt = Math.max(0.25, real * 12);
  for (let i = 0; i < steps; i++) sim.step(dt);

  // Keep the animation smooth: simulation/render work is staged instead of doing
  // every expensive calculation on every browser frame. Vehicles stay 60fps-ish
  // on canvas, while road/stat layers update at a lower cadence.
  if (sim.tick % 6 === 0) sim.computeStats();
  view.drawVehicles();

  if (sim.tick % 3 === 0) {
    view.refreshRoads();
    view.refreshSignals();
    renderClock(); renderKpis(); renderHeader();
  }
  if (sim.tick % 6 === 0) {
    view.refreshLocationPins();
    renderLocations(); renderLocStats();
    if ($('.tabpane[data-pane=analytics]').classList.contains('is-on')) drawChart();
  }
  if (sim.tick % 20 === 0 && selectedInfo) renderInspector(selectedInfo);
}

/* ════════════════════════ scenario chips ════════════════════════ */
function buildScenarioChips() {
  const wrap = $('#scnChips');
  wrap.innerHTML = '';
  for (const s of M.SCENARIOS) {
    const b = document.createElement('button');
    b.className = 'chip' + (s.group === 'wx' ? ' is-wx' : '');
    b.dataset.k = s.key;
    b.textContent = s.label;
    b.title = s.desc;
    b.addEventListener('click', () => {
      sim.toggleScenario(s.key);
      syncScenarioUI();
      view.drawIncidents();
      view.refresh();
      renderAll();
    });
    wrap.appendChild(b);
  }
  // "normal traffic" = clear all
  const norm = document.createElement('button');
  norm.className = 'chip';
  norm.textContent = 'Normal Traffic';
  norm.title = 'Clear every scenario and return to sunny baseline';
  norm.addEventListener('click', () => {
    sim.clearScenarios(); syncScenarioUI();
    view.drawIncidents(); view.refresh(); renderAll();
  });
  wrap.insertBefore(norm, wrap.firstChild);
}

function syncScenarioUI() {
  $$('#scnChips .chip[data-k]').forEach(b => {
    const on = sim.scenarios.has(b.dataset.k);
    b.classList.toggle('is-on', on);
    const sc = M.SCENARIOS.find(s => s.key === b.dataset.k);
    b.classList.toggle('wx', on && sc && sc.group === 'wx');
  });
  $('#scnCount').textContent = sim.scenarios.size + ' active';
  $$('#weatherCtl button').forEach(x => x.classList.toggle('is-on', x.dataset.w === sim.weather));
  const wx = M.WEATHER[sim.weather];
  $('#wxSpd').textContent = wx.spd.toFixed(2);
  $('#wxCap').textContent = wx.cap.toFixed(2);
  $('#wxIcon').textContent = wx.icon;
  $('#wxName').textContent = wx.label;
  view.setWeatherTint(wx);
}

/* ════════════════════════ location list ════════════════════════ */
function buildLocationList() {
  const wrap = $('#locList');
  const select = $('#testLocation');
  wrap.innerHTML = '';
  if (select) {
    sim.locs.forEach(L => {
      const o = document.createElement('option');
      o.value = L.id;
      o.textContent = L.name;
      select.appendChild(o);
    });
  }
  for (const L of sim.locs) {
    const d = document.createElement('div');
    d.className = 'loc';
    d.dataset.id = L.id;
    d.innerHTML = `<div class="loc-main">
        <div class="loc-nm">${L.name}</div>
        <div class="loc-sub" data-sub>—</div>
      </div><span class="loc-lv" data-lv>—</span>`;
    d.addEventListener('click', () => {
      $('#testLocation').value = L.id;
      $('#localTest').checked = true;
      applyTestLocation(L.id);
      onMapSelect({ kind: 'loc', loc: L });
      if (window.innerWidth <= 860) $('#side').classList.remove('is-open');
    });
    wrap.appendChild(d);
  }
}

function applyTestLocation(id) {
  const L = sim.locs.find(x => x.id === id);
  if (!L) return;
  $('#testLocation').value = id;
  $('#localTest').checked = true;
  view.flyTo(L.lat, L.lon, 16.8);
  view.highlightZone(L);
  sim.setTestLocation(id, true);
  view.setFocusedLocation();
  setTestLocationUI(id);
  view.drawIncidents();
  view.refresh();
  renderAll();
}

function setTestLocationUI(id) {
  const note = $('#testLocationNote');
  if (!note) return;
  if (!id) {
    note.textContent = 'Whole network is active. Select a location to run a focused local test.';
    return;
  }
  const L = sim.locs.find(x => x.id === id);
  note.textContent = L ? `Focused test: ${L.name}. Vehicles spawn and choose destinations around this location.` : 'Whole network is active.';
}

function renderLocations() {
  for (const L of sim.locs) {
    const el = $(`#locList .loc[data-id="${L.id}"]`);
    if (!el) continue;
    const st = L.stats;
    const lv = st.level;
    el.className = 'loc ' + lv.cls;
    el.querySelector('[data-lv]').className = 'loc-lv ' + lv.cls;
    el.querySelector('[data-lv]').textContent = lv.key;
    el.querySelector('[data-sub]').textContent =
      `${st.count} veh · ${M.fmt(st.speed, 0)} km/h · v/c ${M.fmt(st.x, 2)}`;
  }
}

/* ════════════════════════ header + clock ════════════════════════ */
function renderClock() {
  const h = Math.floor(sim.time / 3600), m = Math.floor((sim.time % 3600) / 60);
  $('#simClock').textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  $('#simPhase').textContent = M.phaseName(sim.time / 3600);
}

function renderHeader() {
  const s = sim.stats;
  $('#hVeh').textContent = s.vehicles;
  $('#hSpd').textContent = M.fmt(s.avgSpeed, 0);
  const el = $('#hLos');
  el.textContent = s.level.key;
  el.className = s.level.cls;
  el.title = `Network condition: ${s.level.key} · v/c ${M.fmt(s.vc,2)}`;
}

/* ════════════════════════ KPI dashboard ════════════════════════ */
function renderKpis() {
  const s = sim.stats;
  const cells = [
    ['Total vehicles', s.vehicles, 'in network'],
    ['Average speed', M.fmt(s.avgSpeed, 1) + ' km/h', 'free-flow ' + M.fmt(s.freeSpeed, 0)],
    ['Avg travel time', M.fmt(s.travel, 1) + ' min', 'per 3 km trip'],
    ['Average delay', M.fmt(s.delay, 1) + ' min', 'vs free flow'],
    ['Traffic density', M.fmt(s.density, 1), 'veh / km'],
    ['Waiting vehicles', s.waiting, M.fmt(s.vehicles ? s.waiting / s.vehicles * 100 : 0, 0) + '% stopped'],
    ['Congested roads', s.congested, M.fmt(s.congestedPct, 0) + '% of ' + s.segCount],
    ['Network capacity', Math.round(s.capacity), 'veh (v/c ' + M.fmt(s.vc, 2) + ')'],
    ['Active incidents', s.incidents, sim.scenarios.size + ' scenarios'],
    ['Trips completed', s.completed, 'since reset']
  ];
  let html = '';
  for (const [t, v, u] of cells) {
    html += `<div class="kpi"><small>${t}</small><b>${v}</b><u>${u}</u></div>`;
  }
  const wx = s.weather;
  html += `<div class="kpi wide"><small>Current weather</small>
      <b style="font-size:13px">${wx.icon} ${wx.label}</b>
      <u>speed ×${wx.spd.toFixed(2)} · capacity ×${wx.cap.toFixed(2)} · headway ×${wx.gap.toFixed(2)}</u></div>`;
  const conds = {};
  sim.segs.forEach(x => { conds[x.cond] = (conds[x.cond] || 0) + 1; });
  const cstr = Object.entries(conds).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${M.RCOND[k].label} ${n}`).join(' · ');
  html += `<div class="kpi wide"><small>Road condition mix</small>
      <b style="font-size:11.5px;font-family:var(--sans);font-weight:600">${cstr}</b>
      <u>network length ${M.fmt(s.lengthKm, 1)} km · ${s.segCount} directed segments</u></div>`;
  $('#kpiGrid').innerHTML = html;
  renderIncidents();
}

function renderIncidents() {
  const wrap = $('#incList');
  if (!sim.incidents.length) {
    wrap.innerHTML = '<div class="empty">No active incidents.</div>';
    return;
  }
  const byType = {};
  for (const i of sim.incidents) {
    const k = i.type;
    if (!byType[k]) byType[k] = { ...i, roads: new Set(), n: 0 };
    byType[k].roads.add(i.road);
    byType[k].n++;
  }
  wrap.innerHTML = Object.values(byType).map(i => {
    const roads = [...i.roads].slice(0, 3).join(', ') + (i.roads.size > 3 ? ` +${i.roads.size - 3}` : '');
    return `<div class="inc ${i.blocked ? 'blk' : ''}">
      <span class="inc-ico">${i.icon}</span>
      <div><div class="inc-nm">${i.label}${i.n > 1 ? ` (${i.n})` : ''}</div>
      <div class="inc-sub">${roads}</div></div></div>`;
  }).join('');
}

/* ════════════════════════ per-location stats ════════════════════════ */
function renderLocStats() {
  const wrap = $('#locStats');
  wrap.innerHTML = sim.locs.map(L => {
    const st = L.stats;
    const lv = st.level;
    const pct = Math.min(100, st.x * 100);
    return `<div class="ls">
      <div class="ls-top">
        <span class="ls-nm">${L.name}</span>
        <span class="loc-lv ${lv.cls}">${lv.key}</span>
      </div>
      <div class="ls-grid">
        <div>Veh<b>${st.count}</b></div>
        <div>Speed<b>${M.fmt(st.speed, 0)}</b></div>
        <div>Delay<b>${M.fmt(st.delay, 1)}</b></div>
        <div>Queue<b>${st.waiting}</b></div>
      </div>
      <div class="bar"><i style="width:${pct}%;background:${lv.color}"></i></div>
      <div style="font-size:9px;color:var(--dim2);margin-top:4px">
        v/c ${M.fmt(st.x, 2)} · density ${M.fmt(st.density, 1)} veh/km · cap ${Math.round(st.capacity)}
        ${st.incidents ? ` · ${st.incidents} incident${st.incidents > 1 ? 's' : ''}` : ''}
        ${st.blocked ? ` · ${st.blocked} blocked` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ════════════════════════ history chart ════════════════════════ */
function drawChart() {
  const c = $('#chartSpeed');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 90;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const H = sim.history;
  if (H.length < 2) {
    ctx.fillStyle = '#647a92'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Run the simulation to collect data', w / 2, h / 2);
    return;
  }
  const pad = { l: 26, r: 24, t: 8, b: 14 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

  // grid
  ctx.strokeStyle = '#1d2732'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (ih * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iw, y); ctx.stroke();
  }
  const maxSpd = Math.max(20, ...H.map(p => p.spd)) * 1.12;

  const line = (key, max, color) => {
    ctx.beginPath();
    H.forEach((p, i) => {
      const x = pad.l + (iw * i) / (H.length - 1);
      const y = pad.t + ih - (ih * Math.min(1, p[key] / max));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.stroke();
    // fill
    ctx.lineTo(pad.l + iw, pad.t + ih); ctx.lineTo(pad.l, pad.t + ih); ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    g.addColorStop(0, color + '38'); g.addColorStop(1, color + '00');
    ctx.fillStyle = g; ctx.fill();
  };
  line('cong', 100, '#f97316');
  line('spd', maxSpd, '#3ea6ff');

  ctx.fillStyle = '#647a92'; ctx.font = '9px ui-monospace,monospace';
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(maxSpd), pad.l - 4, pad.t + 7);
  ctx.fillText('0', pad.l - 4, pad.t + ih);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f97316';
  ctx.fillText('100%', pad.l + iw + 3, pad.t + 7);
}

/* ════════════════════════ inspector ════════════════════════ */
function onMapSelect(info) {
  selectedInfo = info;
  if (!info) { $('#inspector').classList.remove('is-on'); return; }
  renderInspector(info);
  $('#inspector').classList.add('is-on');
}

function renderInspector(info) {
  const body = $('#inspBody');
  if (info.kind === 'seg') {
    const s = info.seg;
    const lv = s.level;
    const from = s.pts[0], to = s.pts[s.pts.length - 1];
    const bear = M.bearing(from, to);
    const compass = ['N','NE','E','SE','S','SW','W','NW'][Math.round(((bear + 360) % 360) / 45) % 8];
    const rc = M.RCOND[s.cond];
    body.innerHTML = `
      <div class="insp-kind">Road segment · ${s.id}</div>
      <div class="insp-nm">${s.name}</div>
      <div class="insp-dir">
        <span>Direction</span>
        <b>${compass} ${Math.round((bear + 360) % 360)}°</b>
        <span style="margin-left:auto;color:#3ea6ff">one-way &#10230;</span>
      </div>
      <table class="insp-tbl">
        <tr><td>Road class</td><td>${s.hw.replace('_', ' ')}</td></tr>
        <tr><td>Length</td><td>${M.fmt(s.len, 0)} m</td></tr>
        <tr><td>Lanes (usable)</td><td>${Math.max(0, s.lanes - (M.RCOND[s.cond].lane) - s.laneLoss)} / ${s.lanes}</td></tr>
        <tr><td>Speed limit</td><td>${s.speed} km/h</td></tr>
        <tr><td>Vehicle count</td><td>${s.count}</td></tr>
        <tr><td>Road capacity</td><td>${Math.round(s.capNow)} veh</td></tr>
        <tr><td>Average speed</td><td>${M.fmt(s.avgSpeed, 1)} km/h</td></tr>
        <tr><td>Density</td><td>${M.fmt(s.density, 1)} veh/km</td></tr>
        <tr><td>v / c ratio</td><td>${M.fmt(s.x, 2)}</td></tr>
        <tr><td>Queued vehicles</td><td>${s.queue}</td></tr>
        <tr><td>Traffic level</td><td><span class="insp-badge ${lv.cls}"
             style="background:${lv.color}22;color:${lv.color}">${lv.key}</span></td></tr>
        <tr><td>Road condition</td><td>${rc.label}</td></tr>
        <tr><td>Traffic signal</td><td>${s.signalNode ? signalText(s) : 'none'}</td></tr>
      </table>
      ${s.incident ? `<div class="insp-inc">${s.incident.icon} <b>${s.incident.label}</b></div>` : ''}
      ${s.blocked ? `<div class="insp-inc" style="background:#1d1226;border-color:#3d2456;color:#d9b3ff">
        ⛔ <b>Road impassable</b> — vehicles re-route via connected legal roads</div>` : ''}
      <div class="insp-btns">
        <button class="btn sm" id="ispZoom">Zoom to road</button>
      </div>`;
    const zb = $('#ispZoom');
    if (zb) zb.addEventListener('click', () => {
      view.map.fitBounds(L.latLngBounds(s.pts), { padding: [60, 60], maxZoom: 17.5 });
    });
  } else if (info.kind === 'loc') {
    const L2 = info.loc;
    const st = L2.stats;
    const lv = st.level;
    body.innerHTML = `
      <div class="insp-kind">Traffic location · declared ${L2.level}</div>
      <div class="insp-nm">${L2.name}</div>
      <table class="insp-tbl">
        <tr><td>Computed level</td><td><span class="insp-badge"
            style="background:${lv.color}22;color:${lv.color}">${lv.key}</span></td></tr>
        <tr><td>Vehicles in zone</td><td>${st.count}</td></tr>
        <tr><td>Average speed</td><td>${M.fmt(st.speed, 1)} km/h</td></tr>
        <tr><td>Free-flow speed</td><td>${M.fmt(st.freeSpeed, 0)} km/h</td></tr>
        <tr><td>Delay (per km)</td><td>${M.fmt(st.delay, 1)} min</td></tr>
        <tr><td>Density</td><td>${M.fmt(st.density, 1)} veh/km</td></tr>
        <tr><td>Zone capacity</td><td>${Math.round(st.capacity)} veh</td></tr>
        <tr><td>v / c ratio</td><td>${M.fmt(st.x, 2)}</td></tr>
        <tr><td>Queued vehicles</td><td>${st.waiting}</td></tr>
        <tr><td>Road segments</td><td>${L2.zoneIdx.length}</td></tr>
        <tr><td>Active incidents</td><td>${st.incidents}</td></tr>
      </table>
      <div style="font-size:9.5px;color:var(--dim2);margin-top:8px">${L2.note}</div>
      <div class="insp-kind" style="margin-top:9px">Congestion causes</div>
      <ul class="insp-causes">${L2.causes.map(c => `<li>${c}</li>`).join('')}</ul>
      <div class="insp-btns">
        <button class="btn sm" id="ispFly">Zoom here</button>
        <button class="btn sm" id="ispScn">Apply its scenarios</button>
      </div>`;
    $('#ispFly').addEventListener('click', () => view.flyTo(L2.lat, L2.lon, 17));
    $('#ispScn').addEventListener('click', () => {
      M.SCENARIOS.filter(s => s.at === L2.id).forEach(s => { if (!sim.scenarios.has(s.key)) sim.toggleScenario(s.key); });
      syncScenarioUI(); view.drawIncidents(); view.refresh(); renderAll();
    });
  }
}

function signalText(s) {
  const info = sim.signalFor(s.idx);
  if (!info) return 'none';
  const map = { green:'GREEN', yellow:'YELLOW', red:'RED', fault:'FAULT' };
  const col = { green:'#22c55e', yellow:'#eab308', red:'#ef4444', fault:'#a855f7' };
  return `<span style="color:${col[info.light]}">${map[info.light]}</span>`;
}

/* ════════════════════════ comparison ════════════════════════ */
function buildPresets() {
  const presets = [
    { id:'rain',  label:'Normal vs Heavy Rain',   base:[], var:['heavy_rain'], desc:'same demand, weather changed' },
    { id:'acc',   label:'Normal vs Accident',     base:[], var:['accident'],   desc:'lane closure on a main road' },
    { id:'school',label:'Normal vs School Rush',  base:[], var:['rush_hour','double_park','dropoff'], desc:'SMNHS drop-off at peak' },
    { id:'flood', label:'Normal vs Flooding',     base:[], var:['flooding'],   desc:'river-adjacent roads flooded' },
    { id:'signal',label:'Signals vs Violations',  base:[], var:['violation','signal_fault'], desc:'Camias junction breakdown' },
    { id:'works', label:'Normal vs Road Works',   base:[], var:['roadworks','poor_road'], desc:'lane closures + poor surface' }
  ];
  const wrap = $('#presetList');
  wrap.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = `<span><b style="font-weight:600">${p.label}</b><small>${p.desc}</small></span><span class="go">&#9656;</span>`;
    b.addEventListener('click', () => runPreset(p));
    wrap.appendChild(b);
  }
}

function runPreset(p) {
  const wasRunning = sim.running;
  if (wasRunning) togglePlay();

  const savedScn = new Set(sim.scenarios);
  const savedWx = sim.weather;
  const table = $('#cmpTable');
  table.innerHTML = `<div id="cmpBusy">Running baseline and variant…</div>`;

  setTimeout(() => {
    const WARM = 240;
    // baseline
    sim.scenarios = new Set(p.base);
    sim.weather = 'sunny';
    sim.reset();
    sim.runSteps(WARM, 0.9);
    const A = sim.snapshot('Normal');

    // variant
    sim.scenarios = new Set(p.var);
    const wxScn = M.SCENARIOS.find(s => s.group === 'wx' && p.var.includes(s.key));
    sim.weather = wxScn ? wxScn.wx : 'sunny';
    sim.reset();
    sim.runSteps(WARM, 0.9);
    const B = sim.snapshot(p.label.split(' vs ')[1]);

    captures.A = A; captures.B = B;

    // restore
    sim.scenarios = savedScn;
    sim.weather = savedWx;
    sim.reset();
    syncScenarioUI();
    view.drawIncidents(); view.refresh();
    renderAll();
    renderCompare();
    if (wasRunning) togglePlay();
  }, 40);
}

function renderCompare() {
  const wrap = $('#cmpTable');
  const { A, B } = captures;
  if (!A && !B) { wrap.innerHTML = '<div class="empty">No captures yet.</div>'; return; }

  const rows = [
    ['Vehicles',        s => s.vehicles,             0, ''],
    ['Average speed',   s => s.speed,                1, ' km/h', true],
    ['Travel time',     s => s.travel,               1, ' min'],
    ['Average delay',   s => s.delay,                1, ' min'],
    ['Traffic density', s => s.density,              1, ' veh/km'],
    ['Waiting vehicles',s => s.waiting,              0, ''],
    ['Congested roads', s => s.congested,            0, ''],
    ['v / c ratio',     s => s.vc,                   2, ''],
    ['Active incidents',s => s.incidents,            0, '']
  ];

  let html = `<table class="cmp"><thead><tr><th>Metric</th>
    <th>${A ? esc(A.label) : '—'}</th><th>${B ? esc(B.label) : '—'}</th><th>Δ</th></tr></thead><tbody>`;
  for (const [name, get, dec, unit, higherBetter] of rows) {
    const a = A ? get(A) : null, b = B ? get(B) : null;
    let d = '—', cls = 'dlt-0';
    if (a != null && b != null) {
      const diff = b - a;
      if (Math.abs(diff) > (dec === 0 ? 0.5 : Math.pow(10, -dec) / 2)) {
        const worse = higherBetter ? diff < 0 : diff > 0;
        cls = worse ? 'dlt-up' : 'dlt-dn';
        d = (diff > 0 ? '+' : '') + diff.toFixed(dec);
      } else d = '0';
    }
    html += `<tr><td>${name}</td>
      <td><b>${a != null ? a.toFixed(dec) + unit : '—'}</b></td>
      <td><b>${b != null ? b.toFixed(dec) + unit : '—'}</b></td>
      <td class="${cls}"><b>${d}</b></td></tr>`;
  }
  html += `<tr><td>Traffic level</td>
    <td><b>${A ? A.level : '—'}</b></td><td><b>${B ? B.level : '—'}</b></td><td>—</td></tr>`;
  html += '</tbody></table>';

  // per-location level comparison
  if (A && B) {
    html += `<table class="cmp" style="margin-top:10px"><thead><tr><th>Location</th>
      <th>${esc(A.label)}</th><th>${esc(B.label)}</th></tr></thead><tbody>`;
    A.locs.forEach((la, i) => {
      const lb = B.locs[i];
      html += `<tr><td style="font-size:10px">${la.name}</td>
        <td><b>${la.level}</b><br><span style="font-size:9px;color:#647a92">${M.fmt(la.speed, 0)} km/h</span></td>
        <td><b>${lb.level}</b><br><span style="font-size:9px;color:#647a92">${M.fmt(lb.speed, 0)} km/h</span></td></tr>`;
    });
    html += '</tbody></table>';
  }

  const cap = s => s ? `<b>${esc(s.label)}</b>: ${esc(s.weather)}${s.scenarios.length ? ' · ' + esc(s.scenarios.join(', ')) : ' · no scenarios'}` : '';
  html += `<div class="cmp-cap">${cap(A)}${A && B ? '<br>' : ''}${cap(B)}</div>`;
  wrap.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ════════════════════════ network meta ════════════════════════ */
function renderNetMeta() {
  const s = sim.stats;
  const oneway = sim.segs.filter(x => !x.dual).length;
  const rows = [
    ['Place', sim.net.meta.place.split(',').slice(0, 2).join(',')],
    ['Directed segments', s.segCount],
    ['Intersections / nodes', sim.nodes.length],
    ['Network length', M.fmt(s.lengthKm, 1) + ' km'],
    ['Single-carriageway one-way', oneway],
    ['Dual-carriageway halves', s.segCount - oneway],
    ['Signalised junctions', sim.signals.length],
    ['Bus stops', (sim.net.busstops || []).length],
    ['Landmarks', sim.net.landmarks.length],
    ['Rivers / streams', sim.net.water.length]
  ];
  $('#netMeta').innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

/* ════════════════════════ master render ════════════════════════ */
function renderAll() {
  syncScenarioUI();
  renderClock();
  renderHeader();
  renderKpis();
  renderLocations();
  renderLocStats();
  renderNetMeta();
  renderCompare();
  drawChart();
}
