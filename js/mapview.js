/* ═══════════════════════════════════════════════════════════════════
   mapview.js — Leaflet real-map rendering: roads coloured by traffic
   level, vehicles, signals, incidents, landmarks.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

class MapView {
  constructor(sim, opts) {
    this.sim = sim;
    this.onSelect = opts.onSelect || (() => {});
    this.show = {
      veh: true, traffic: true, signal: true,
      incident: true, lm: true, water: true, label: false
    };
    this.performanceMode = 'normal';
    this.performanceProfile = {
      normal:      { vehicleMs: 33, roadMs: 120, uiMs: 250, weather: true,  weatherMs: 33 },
      performance: { vehicleMs: 42, roadMs: 180, uiMs: 400, weather: false, weatherMs: 0  },
      ultra:       { vehicleMs: 66, roadMs: 300, uiMs: 700, weather: false, weatherMs: 0  }
    };
    this.selected = null;
    this.focusFilterActive = false;
    this.focusBounds = null;
    this.initMap();
    this.drawStatic();
    this.scheduleVehicleDraw();
  }

  /* ───────────────────────────────────────────── map + basemap */
  initMap() {
    const bb = this.sim.net.meta.bbox;
    this.map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      // Use SVG for the static road network. Leaflet can move the SVG pane with
      // a single transform while panning instead of repainting an 808-path
      // canvas on every pointer-move. Vehicles/weather use their own canvases.
      preferCanvas: false,
      zoomSnap: 0.5,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      minZoom: 12,
      maxZoom: 18,
      maxBounds: L.latLngBounds([bb[0] - 0.05, bb[1] - 0.05], [bb[2] + 0.05, bb[3] + 0.05]),
      maxBoundsViscosity: 0.75
    });

    
    const pane = (name, z) => {
      this.map.createPane(name);
      this.map.getPane(name).style.zIndex = z;
    };
    pane('pRef', 300);        
    pane('pWater', 390);
    pane('pRoadCase', 400);
    pane('pRoad', 410);
    pane('pVeh', 440);
    pane('pMark', 620);
    pane('pLabel', 610);
    this.map.getPane('pRef').style.pointerEvents = 'none';
    this.map.getPane('pVeh').style.pointerEvents = 'none';
    this.map.getPane('pLabel').style.pointerEvents = 'none';

    const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    this.base = L.tileLayer(ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, maxNativeZoom: 17, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1,
      attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &middot; ' +
                   'road network &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)'
    }).addTo(this.map);

    
    this.baseRef = L.tileLayer(ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      pane: 'pRef', maxZoom: 18, maxNativeZoom: 17, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1, attribution: ''
    }).addTo(this.map);

    // Shared SVG renderers keep static geometry in a single DOM tree. This is
    // considerably cheaper to pan than Leaflet's Canvas renderer for this
    // network size because the browser can transform the SVG pane as a unit.
    this.roadRenderer = L.svg({ padding: 0.05 });
    this.waterRenderer = L.svg({ padding: 0.05 });

    this.map.fitBounds(L.latLngBounds([bb[0], bb[1]], [bb[2], bb[3]]), { padding: [16, 16] });

    this.gWater   = L.layerGroup([], { pane: 'pWater' }).addTo(this.map);
    this.gCase    = L.layerGroup([], { pane: 'pRoadCase' }).addTo(this.map);
    this.gRoad    = L.layerGroup([], { pane: 'pRoad' }).addTo(this.map);
    this.gLm      = L.layerGroup([], { pane: 'pMark' }).addTo(this.map);
    this.gLoc     = L.layerGroup([], { pane: 'pMark' }).addTo(this.map);
    this.gSig     = L.layerGroup([], { pane: 'pMark' }).addTo(this.map);
    this.gInc     = L.layerGroup([], { pane: 'pMark' }).addTo(this.map);
    this.gLabel   = L.layerGroup([], { pane: 'pLabel' });

    // vehicle canvas overlay
    this.initVehicleCanvas();
    // lightweight weather animation overlay (canvas, not DOM particles)
    this.initWeatherCanvas();

    // Keep map dragging/zooming lightweight. Heavy simulation overlays are
    // hidden while Leaflet is moving, then rendered once the map settles.
    this.map.on('movestart zoomstart', () => this.setMapInteractionState(true));
    this.map.on('moveend', () => { this.setMapInteractionState(false); this.scheduleVehicleDraw(); });
    this.map.on('zoomend', () => { this.onZoom(); this.setMapInteractionState(false); this.scheduleVehicleDraw(); });
    this.map.on('viewreset', () => { this.setMapInteractionState(false); this.scheduleVehicleDraw(); });
    this.map.on('click', () => { this.clearSelection(); this.onSelect(null); });
  }

  
  setMapInteractionState(moving) {
    const veh = this.vehLayer && this.vehLayer._canvas;
    if (veh) veh.style.visibility = moving ? 'hidden' : 'visible';
    if (this.weatherCanvas) this.weatherCanvas.style.visibility = moving ? 'hidden' : 'visible';
    this.mapMoving = moving;
    if (!moving) {
      this.weatherLast = performance.now();
      if (this.weatherCanvas && this.weatherType) this.resizeWeatherCanvas();
    }
  }

  initVehicleCanvas() {
    const self = this;
    const CanvasLayer = L.Layer.extend({
      onAdd(map) {
        this._map = map;
        const c = this._canvas = L.DomUtil.create('canvas', 'veh-canvas');
        c.style.position = 'absolute';
        c.style.pointerEvents = 'none';
        c.style.zIndex = 435;
        const size = map.getSize();
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        c.width = size.x * dpr; c.height = size.y * dpr;
        c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
        map.getPanes().overlayPane.appendChild(c);
        this._ctx = c.getContext('2d');
        this._dpr = dpr;
        map.on('move zoom resize', this._reset, this);
        this._reset();
      },
      onRemove(map) {
        map.off('move zoom resize', this._reset, this);
        L.DomUtil.remove(this._canvas);
      },
      _reset() {
        const map = this._map;
        const size = map.getSize();
        const dpr = this._dpr;
        if (this._canvas.width !== size.x * dpr || this._canvas.height !== size.y * dpr) {
          this._canvas.width = size.x * dpr; this._canvas.height = size.y * dpr;
          this._canvas.style.width = size.x + 'px'; this._canvas.style.height = size.y + 'px';
        }
        const tl = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, tl);
        // Leaflet moves the canvas with the map during drag/zoom. Do not redraw
        // thousands of vehicle projections on every move event; redraw after settle.
      }
    });
    this.vehLayer = new CanvasLayer();
    this.vehLayer.addTo(this.map);
  }

  
  /* ───────────────────────── focused-location rendering
     In focused test mode, the selected road zone is the only custom
     simulation geometry rendered on top of the basemap. The basemap itself
     remains visible for geographic context. */
  getFocusBounds() {
    const ids = this.sim.testZoneSet;
    if (!this.sim.localTestMode || !this.sim.testLocationId || !ids || !ids.size) return null;
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    for (const idx of ids) {
      const s = this.sim.segs[idx];
      if (!s) continue;
      for (const p of s.pts) {
        south = Math.min(south, p[0]); north = Math.max(north, p[0]);
        west = Math.min(west, p[1]); east = Math.max(east, p[1]);
      }
    }
    if (!Number.isFinite(south)) return null;
    // Small padding keeps the selected area's nearby context without drawing
    // the rest of the network.
    const padLat = Math.max((north - south) * 0.08, 0.0015);
    const padLon = Math.max((east - west) * 0.08, 0.0015);
    return { south: south - padLat, west: west - padLon, north: north + padLat, east: east + padLon };
  }

  pointInFocus(lat, lon) {
    const b = this.focusBounds;
    return !this.focusFilterActive || !b || (lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);
  }

  setFocusedLocation() {
    this.focusFilterActive = !!(this.sim.localTestMode && this.sim.testLocationId && this.sim.testZoneSet && this.sim.testZoneSet.size);
    this.focusBounds = this.getFocusBounds();
    if (!this.focusFilterActive) {
      // Restore all static layers.
      for (let i = 0; i < this.roadLines.length; i++) {
        if (this.caseLines[i] && !this.gCase.hasLayer(this.caseLines[i])) this.gCase.addLayer(this.caseLines[i]);
        if (this.roadLines[i] && !this.gRoad.hasLayer(this.roadLines[i])) this.gRoad.addLayer(this.roadLines[i]);
      }
      this.gWater.clearLayers();
      for (const w of this.sim.net.water) L.polyline(w.pts, {
        renderer: this.waterRenderer,
        pane: 'pWater', color: '#1e4c66', weight: w.w === 'river' ? 3.4 : 1.9,
        opacity: 0.75, interactive: false, lineJoin: 'round'
      }).addTo(this.gWater);
    } else {
      // Remove every road that is outside the selected simulation zone.
      for (let i = 0; i < this.sim.segs.length; i++) {
        const keep = this.sim.testZoneSet.has(i);
        const ln = this.roadLines[i], cs = this.caseLines[i];
        if (keep) {
          if (cs && !this.gCase.hasLayer(cs)) this.gCase.addLayer(cs);
          if (ln && !this.gRoad.hasLayer(ln)) this.gRoad.addLayer(ln);
        } else {
          if (cs && this.gCase.hasLayer(cs)) this.gCase.removeLayer(cs);
          if (ln && this.gRoad.hasLayer(ln)) this.gRoad.removeLayer(ln);
        }
      }
      // Draw only water that crosses the focused zone.
      this.gWater.clearLayers();
      for (const w of this.sim.net.water) {
        const keep = w.pts.some(p => this.pointInFocus(p[0], p[1]));
        if (keep) L.polyline(w.pts, {
          pane: 'pWater', color: '#1e4c66', weight: w.w === 'river' ? 3.4 : 1.9,
          opacity: 0.75, interactive: false, lineJoin: 'round'
        }).addTo(this.gWater);
      }
    }
    this.drawLandmarks();
    this.drawLocations();
    this.drawSignals();
    this.drawIncidents();
    if (this.show.label) this.drawLabels();
    this.scheduleVehicleDraw();
  }

  
  drawStatic() {
    const sim = this.sim;

    // rivers / streams
    for (const w of sim.net.water) {
      L.polyline(w.pts, {
        renderer: this.waterRenderer,
        pane: 'pWater', color: '#1e4c66', weight: w.w === 'river' ? 3.4 : 1.9,
        opacity: 0.75, interactive: false, lineJoin: 'round'
      }).addTo(this.gWater);
    }

    
    this.roadLines = [];
    this.caseLines = [];
    const z = this.map.getZoom();
    for (const s of sim.segs) {
      const wCase = this.caseWeight(s, z);
      const wLine = this.lineWeight(s, z);
      const cs = L.polyline(s.pts, {
        renderer: this.roadRenderer,
        pane: 'pRoadCase', color: '#0a1017', weight: wCase, opacity: 0.9,
        lineCap: 'round', lineJoin: 'round', interactive: false
      }).addTo(this.gCase);
      const ln = L.polyline(s.pts, {
        renderer: this.roadRenderer,
        pane: 'pRoad', color: s.level.color, weight: wLine, opacity: 0.95,
        lineCap: 'round', lineJoin: 'round', interactive: true
      }).addTo(this.gRoad);
      ln.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.select(s.idx);
        this.onSelect({ kind: 'seg', seg: s });
      });
      this.roadLines.push(ln);
      this.caseLines.push(cs);
    }

    this.drawLandmarks();
    this.drawLocations();
    this.drawSignals();
    this.drawIncidents();
    this.drawLabels();
  }

  caseWeight(s, z) {
    const base = s.rank >= 5 ? 7 : s.rank >= 4 ? 6 : s.rank >= 3 ? 5 : 4;
    return base * (z >= 16 ? 1.15 : z >= 15 ? 0.92 : z >= 14 ? 0.74 : 0.6);
  }
  lineWeight(s, z) {
    const base = s.rank >= 5 ? 4.6 : s.rank >= 4 ? 3.9 : s.rank >= 3 ? 3.2 : 2.4;
    return base * (z >= 16 ? 1.15 : z >= 15 ? 0.94 : z >= 14 ? 0.78 : 0.64);
  }

  drawLandmarks() {
    this.gLm.clearLayers();
    if (!this.show.lm || this.performanceMode === 'ultra') return;
    const z = this.map.getZoom();
    const PRIO = { school:3, hospital:3, marketplace:3, townhall:3, university:3, college:3,
                   fast_food:2, supermarket:2, bus_station:2, police:2, department_store:2,
                   place_of_worship:2, bus_stop:1, fuel:1, bank:1, restaurant:1 };
    const minPrio = z >= 17 ? 1 : z >= 16 ? 1 : z >= 15 ? 2 : 3;
    for (const l of this.sim.net.landmarks) {
      const p = PRIO[l.k] || 1;
      if (p < minPrio) continue;
      if (this.focusFilterActive && !this.pointInFocus(l.lat, l.lon)) continue;
      const short = l.n.length > 26 ? l.n.slice(0, 25) + '…' : l.n;
      const showTxt = z >= 15;
      L.marker([l.lat, l.lon], {
        pane: 'pMark', interactive: false, keyboard: false,
        icon: L.divIcon({
          className: 'lm-mk',
          html: `<div class="lm-dot ${l.k}"><i></i>${showTxt ? `<span>${short}</span>` : ''}</div>`,
          iconSize: [6, 6], iconAnchor: [3, 3]
        })
      }).addTo(this.gLm);
    }
  }

  
  drawLocations() {
    this.gLoc.clearLayers();
    this.locMarkers = {};
    for (const L2 of this.sim.locs) {
      if (this.focusFilterActive && L2.id !== this.sim.testLocationId) continue;
      const lv = L2.stats.level;
      const html = `<div class="loc-pin ${lv.cls}"><i></i><b>${L2.name.replace(' - ', ' · ')}</b></div>`;
      const mk = L.marker([L2.lat, L2.lon], {
        pane: 'pMark',
        icon: L.divIcon({ className: 'loc-mk', html: html, iconSize: [null, 20], iconAnchor: [10, 10] }),
        zIndexOffset: 600
      }).addTo(this.gLoc);
      mk.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.onSelect({ kind: 'loc', loc: L2 });
        this.highlightZone(L2);
      });
      this.locMarkers[L2.id] = mk;
    }
  }

  refreshLocationPins() {
    for (const L2 of this.sim.locs) {
      const mk = this.locMarkers[L2.id];
      if (!mk) continue;
      const lv = L2.stats.level;
      const el = mk.getElement();
      if (el) {
        const pin = el.querySelector('.loc-pin');
        if (pin) pin.className = `loc-pin ${lv.cls}`;
      }
    }
  }

  
  drawSignals() {
    this.gSig.clearLayers();
    this.sigMarkers = {};
    if (!this.show.signal || this.performanceMode === 'ultra') return;
    for (const sg of this.sim.signals) {
      if (this.focusFilterActive && !this.pointInFocus(sg.lat, sg.lon)) continue;
      const mk = L.marker([sg.lat, sg.lon], {
        pane: 'pMark',
        icon: L.divIcon({ className: 'sig-mk', html: `<div class="sig-box g"></div>`, iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
        zIndexOffset: 500, interactive: false
      }).addTo(this.gSig);
      this.sigMarkers[sg.id] = mk;
    }
  }

  refreshSignals() {
    if (!this.show.signal || this.performanceMode === 'ultra') return;
    for (const sg of this.sim.signals) {
      const mk = this.sigMarkers && this.sigMarkers[sg.id];
      if (!mk) continue;
      const el = mk.getElement();
      if (!el) continue;
      const box = el.querySelector('.sig-box');
      if (!box) continue;
      let cls = 'g';
      if (sg.fault) cls = sg.state === 'red' ? 'r' : 'y';
      else if (sg.state === 'green') cls = 'g';
      else if (sg.state === 'yellow') cls = 'y';
      else cls = 'r';
      if (box.dataset.c !== cls) { box.className = 'sig-box ' + cls; box.dataset.c = cls; }
    }
  }

  
  drawIncidents() {
    this.gInc.clearLayers();
    if (!this.show.incident) return;
    for (const inc of this.sim.incidents) {
      if (this.focusFilterActive && (!this.sim.testZoneSet.has(inc.seg))) continue;
      const mk = L.marker([inc.lat, inc.lon], {
        pane: 'pMark',
        icon: L.divIcon({ className: 'inc-mk', html: `<div class="inc-pin">${inc.icon}</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
        zIndexOffset: 700
      }).addTo(this.gInc);
      mk.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const s = this.sim.segs[inc.seg];
        this.select(inc.seg);
        this.onSelect({ kind: 'seg', seg: s });
      });
    }
  }

 
  drawLabels() {
    this.gLabel.clearLayers();
    if (!this.show.label || this.performanceMode === 'ultra') { this.map.removeLayer(this.gLabel); return; }
    this.map.addLayer(this.gLabel);
    const z = this.map.getZoom();
    const minRank = z >= 16 ? 2 : z >= 15 ? 3 : 4;
    const seen = new Set();
    for (const s of this.sim.segs) {
      if (this.focusFilterActive && !this.sim.testZoneSet.has(s.idx)) continue;
      if (s.rank < minRank || s.len < 45) continue;
      const key = s.name + '_' + Math.round(s.pts[0][0] * 300) + '_' + Math.round(s.pts[0][1] * 300);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = M.along(s.pts, s.cum, s.len / 2);
      let ang = p[2] - 90;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      L.marker([p[0], p[1]], {
        pane: 'pLabel', interactive: false, keyboard: false,
        icon: L.divIcon({
          className: 'rd-label',
          html: `<div style="transform:rotate(${ang}deg) translateY(-7px);white-space:nowrap">${s.name}</div>`,
          iconSize: [0, 0], iconAnchor: [0, 0]
        })
      }).addTo(this.gLabel);
    }
  }

  
  refreshRoads() {
    if (!this.show.traffic) return;
    const z = this.map.getZoom();
    const segs = this.sim.segs;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (this.focusFilterActive && !this.sim.testZoneSet.has(i)) continue;
      const ln = this.roadLines[i];
      if (!ln) continue;
      const col = s.level.color;
      if (ln._col !== col) { ln.setStyle({ color: col }); ln._col = col; }
      const wantDash = s.blocked ? '5,5' : null;
      if (ln._dash !== wantDash) { ln.setStyle({ dashArray: wantDash }); ln._dash = wantDash; }
    }
  }

  plainRoads() {
    for (let i = 0; i < this.roadLines.length; i++) {
      const ln = this.roadLines[i];
      ln.setStyle({ color: '#4a5b70', dashArray: null });
      ln._col = '#4a5b70'; ln._dash = null;
    }
  }

  
  scheduleVehicleDraw() {
    if (this.vehicleDrawRAF) return;
    this.vehicleDrawRAF = requestAnimationFrame(() => {
      this.vehicleDrawRAF = 0;
      this.drawVehicles();
    });
  }

  drawVehicles() {
    const layer = this.vehLayer;
    if (!layer || !layer._ctx) return;
    const ctx = layer._ctx;
    const dpr = layer._dpr;
    const map = this.map;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layer._canvas.width / dpr, layer._canvas.height / dpr);
    if (!this.show.veh) return;

    const z = map.getZoom();
    if (z < 13.5) return;
    const scale = z >= 17.5 ? 1.55 : z >= 16.5 ? 1.18 : z >= 15.5 ? .9 : z >= 14.5 ? .68 : .52;
    const bounds = map.getBounds().pad(.08);

    for (const v of this.sim.vehicles) {
      if (this.sim.localTestMode && this.sim.testLocationId && this.sim.testZoneSet.size && !this.sim.testZoneSet.has(v.seg)) continue;
      if (v.lat < bounds.getSouth() || v.lat > bounds.getNorth() || v.lon < bounds.getWest() || v.lon > bounds.getEast()) continue;
      const pt = map.latLngToContainerPoint([v.lat, v.lon]);
      const T = v.t;
      const bodyW = Math.max(2.2, T.w * scale);
      const bodyH = Math.max(4.2, T.len * .72 * scale);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(v.hdg * Math.PI / 180);
      ctx.globalAlpha = v.stoppedFlag ? .78 : 1;

      // Performance/Ultra use a very cheap vehicle primitive. This avoids
      // hundreds of path-building operations and shadows on every redraw,
      // while keeping the vehicles visible and color-coded.
      if (this.performanceMode !== 'normal') {
        ctx.fillStyle = T.color;
        ctx.fillRect(-bodyW/2, -bodyH/2, bodyW, bodyH);
        if (z >= 15.5 && this.performanceMode === 'performance') {
          ctx.fillStyle = 'rgba(8,18,28,.55)';
          ctx.fillRect(-bodyW*.34, -bodyH*.22, bodyW*.68, bodyH*.28);
        }
        ctx.restore();
        continue;
      }

      // subtle shadow makes the tiny vehicles readable over road colors
      ctx.fillStyle = 'rgba(0,0,0,.48)';
      this.roundRect(ctx, -bodyW/2 + 1, -bodyH/2 + 1.2, bodyW, bodyH, Math.min(bodyW, bodyH)*.3); ctx.fill();
      ctx.fillStyle = T.color;
      this.roundRect(ctx, -bodyW/2, -bodyH/2, bodyW, bodyH, Math.min(bodyW, bodyH)*.3); ctx.fill();

      if (z >= 15.5) {
        // cabin / windshield
        const cabinW = bodyW * .72, cabinH = bodyH * .43;
        ctx.fillStyle = 'rgba(8,18,28,.72)';
        this.roundRect(ctx, -cabinW/2, -bodyH*.23, cabinW, cabinH, Math.min(cabinW,cabinH)*.18); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.24)';
        ctx.fillRect(-cabinW*.32, -bodyH*.18, cabinW*.64, Math.max(1, cabinH*.18));
        // wheels / side details
        ctx.fillStyle = 'rgba(4,8,12,.9)';
        const ww = Math.max(1, bodyW*.18), wh = Math.max(1.5, bodyH*.18);
        ctx.fillRect(-bodyW/2-0.3,-bodyH*.30,ww,wh); ctx.fillRect(bodyW/2-ww+0.3,-bodyH*.30,ww,wh);
        ctx.fillRect(-bodyW/2-0.3,bodyH*.12,ww,wh); ctx.fillRect(bodyW/2-ww+0.3,bodyH*.12,ww,wh);
      }
      // headlights / direction cue
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(-Math.max(1,bodyW*.18), -bodyH/2+.4, Math.max(2,bodyW*.36), Math.max(.8,bodyH*.07));
      if (v.type === 'emergency' && z >= 14.5) {
        ctx.fillStyle = (this.sim.tick % 8 < 4) ? '#ff2d2d' : '#39a8ff';
        ctx.fillRect(-bodyW*.42, -bodyH*.06, bodyW*.84, Math.max(1.2, bodyH*.1));
      } else if (v.stoppedFlag && v.wait > 4 && z >= 15.5) {
        ctx.fillStyle = '#ff5252';
        ctx.fillRect(-bodyW*.32, bodyH/2-1.2, bodyW*.64, 1.2);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  /* ─────────────────────────── selection & zoom handling */
  select(idx) {
    this.clearSelection();
    this.selected = idx;
    const ln = this.roadLines[idx];
    if (!ln) return;
    const s = this.sim.segs[idx];
    ln.setStyle({ weight: this.lineWeight(s, this.map.getZoom()) + 3.4, opacity: 1 });
    // highlight arrow of travel direction
    this.selHalo = L.polyline(s.pts, {
      pane: 'pMark', color: '#ffffff', weight: this.lineWeight(s, this.map.getZoom()) + 6,
      opacity: 0.22, interactive: false, lineCap: 'round'
    }).addTo(this.map);
    // start / end markers showing direction
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    this.selEnds = L.layerGroup([
      L.circleMarker(a, { pane: 'pMark', radius: 4, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 1, interactive: false }),
      L.circleMarker(b, { pane: 'pMark', radius: 4.6, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1, weight: 1, interactive: false })
    ]).addTo(this.map);
  }

  clearSelection() {
    if (this.selected != null) {
      const s = this.sim.segs[this.selected];
      const ln = this.roadLines[this.selected];
      if (ln) ln.setStyle({ weight: this.lineWeight(s, this.map.getZoom()), opacity: 0.95 });
    }
    if (this.selHalo) { this.map.removeLayer(this.selHalo); this.selHalo = null; }
    if (this.selEnds) { this.map.removeLayer(this.selEnds); this.selEnds = null; }
    if (this.zoneHi) { this.map.removeLayer(this.zoneHi); this.zoneHi = null; }
    this.selected = null;
    this.focusFilterActive = false;
    this.focusBounds = null;
  }

  highlightZone(L2) {
    if (this.zoneHi) this.map.removeLayer(this.zoneHi);
    const lines = L2.zoneIdx.map(i => L.polyline(this.sim.segs[i].pts, {
      pane: 'pMark', color: '#ffffff', weight: 6, opacity: 0.16, interactive: false, lineCap: 'round'
    }));
    this.zoneHi = L.layerGroup(lines).addTo(this.map);
  }

  clearZoneHighlight() {
    if (this.zoneHi) { this.map.removeLayer(this.zoneHi); this.zoneHi = null; }
  }

  onZoom() {
    const z = this.map.getZoom();
    for (let i = 0; i < this.roadLines.length; i++) {
      const s = this.sim.segs[i];
      if (this.focusFilterActive && !this.sim.testZoneSet.has(i)) continue;
      const w = this.lineWeight(s, z);
      this.roadLines[i].setStyle({ weight: this.selected === i ? w + 3.4 : w });
      this.caseLines[i].setStyle({ weight: this.caseWeight(s, z) });
    }
    this.drawLandmarks();
    if (this.show.label) this.drawLabels();
    this.scheduleVehicleDraw();
  }

  flyTo(lat, lon, z) {
    this.map.flyTo([lat, lon], z || 16.5, { duration: 0.85 });
  }

  setLayer(k, on) {
    this.show[k] = on;
    if (k === 'veh') this.drawVehicles();
    if (k === 'lm') this.drawLandmarks();
    if (k === 'label') this.drawLabels();
    if (k === 'water') { if (on) this.map.addLayer(this.gWater); else this.map.removeLayer(this.gWater); }
    if (k === 'signal') { this.drawSignals(); this.refreshSignals(); }
    if (k === 'incident') this.drawIncidents();
    if (k === 'traffic') { if (on) this.refreshRoads(); else this.plainRoads(); }
  }

  /* weather visual tint + lightweight animated weather overlay */
  setWeatherTint(wx) {
    const el = document.getElementById('map');
    if (!el) return;
    el.style.boxShadow = wx.tint ? `inset 0 0 220px ${wx.tint}` : 'none';
    this.setWeatherAnimation(wx.key);
  }

  initWeatherCanvas() {
    const map = this.map;
    const canvas = L.DomUtil.create('canvas', 'weather-canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:700;';
    map.getContainer().appendChild(canvas);
    this.weatherCanvas = canvas;
    this.weatherCtx = canvas.getContext('2d');
    this.weatherType = 'sunny';
    this.weatherParticles = [];
    this.weatherLast = performance.now();
    this.weatherFrame = 0;
    this.weatherReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.weatherVisible = !document.hidden;
    const resize = () => this.resizeWeatherCanvas();
    this.resizeWeatherCanvas();
    map.on('resize', resize);
    document.addEventListener('visibilitychange', () => { this.weatherVisible = !document.hidden; });
    this.weatherLoop = (now) => {
      const profile = this.performanceProfile[this.performanceMode] || this.performanceProfile.normal;
      // Decorative weather is completely paused outside Normal mode.
      if (profile.weather && this.weatherVisible && !this.weatherReduced && !this.mapMoving && now - this.weatherLastDraw >= profile.weatherMs) {
        this.drawWeather(now);
        this.weatherLastDraw = now;
      }
      this.weatherFrame = requestAnimationFrame(this.weatherLoop);
    };
    this.weatherLastDraw = 0;
    this.weatherFrame = requestAnimationFrame(this.weatherLoop);
  }

  resizeWeatherCanvas() {
    if (!this.weatherCanvas) return;
    const r = this.map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.weatherCanvas.width = Math.max(1, Math.floor(r.x * dpr));
    this.weatherCanvas.height = Math.max(1, Math.floor(r.y * dpr));
    this.weatherCanvas.style.width = r.x + 'px';
    this.weatherCanvas.style.height = r.y + 'px';
    this.weatherDpr = dpr;
    this.weatherParticles = [];
  }

  setWeatherAnimation(type) {
    if (!this.weatherCanvas) return;
    this.weatherType = type || 'sunny';
    const profile = this.performanceProfile[this.performanceMode] || this.performanceProfile.normal;
    if (!profile.weather) {
      this.weatherParticles = [];
      this.weatherCtx && this.weatherCtx.clearRect(0, 0, this.weatherCanvas.width, this.weatherCanvas.height);
      return;
    }
    const counts = { sunny:0, cloudy:0, rainy:80, heavy_rain:150, storm:190, flooded:26 };
    const count = counts[this.weatherType] ?? 0;
    const w = this.map.getSize().x || 800, h = this.map.getSize().y || 600;
    this.weatherParticles = Array.from({length: count}, () => this.makeWeatherParticle(w, h, true));
  }

  setPerformanceMode(mode) {
    const next = this.performanceProfile[mode] ? mode : 'normal';
    this.performanceMode = next;
    if (this.weatherCanvas) {
      if (next === 'normal') {
        this.weatherCanvas.style.display = '';
        this.weatherCanvas.style.visibility = this.mapMoving ? 'hidden' : 'visible';
        this.setWeatherAnimation(this.weatherType);
      } else {
        this.weatherParticles = [];
        this.weatherCanvas.style.display = 'none';
        if (this.weatherCtx) this.weatherCtx.clearRect(0, 0, this.weatherCanvas.width, this.weatherCanvas.height);
      }
    }
    // Ultra keeps the simulation readable but removes the two most expensive
    // nonessential marker groups: landmark DOM markers and signal DOM markers.
    if (next === 'ultra') {
      this.gLm.clearLayers();
      this.gSig.clearLayers();
      this.sigMarkers = {};
      this.gLabel.clearLayers();
      this.map.removeLayer(this.gLabel);
    }
    this.scheduleVehicleDraw();
    if (!this.mapMoving) {
      this.refreshRoads();
      this.refreshSignals();
      this.drawLandmarks();
      if (next !== 'ultra' && this.show.label) this.drawLabels();
    }
  }

  getPerformanceProfile() {
    return this.performanceProfile[this.performanceMode] || this.performanceProfile.normal;
  }

  makeWeatherParticle(w, h, randomY) {
    return { x:Math.random()*w, y:randomY ? Math.random()*h : -20-Math.random()*40,
      len:8+Math.random()*16, speed:280+Math.random()*220, drift:-20+Math.random()*40,
      r:1+Math.random()*2, phase:Math.random()*Math.PI*2 };
  }

  drawWeather(now) {
    const ctx = this.weatherCtx, canvas = this.weatherCanvas;
    if (!ctx || !canvas) return;
    const dpr = this.weatherDpr || 1, w = canvas.width/dpr, h = canvas.height/dpr;
    const dt = Math.min(.05, Math.max(.001, (now-this.weatherLast)/1000));
    this.weatherLast = now;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    const t = this.weatherType;

    if (t === 'sunny') {
      const g=ctx.createRadialGradient(w*.82,h*.15,8,w*.82,h*.15,110);
      g.addColorStop(0,'rgba(255,238,150,.18)'); g.addColorStop(1,'rgba(255,238,150,0)');
      ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
      ctx.save(); ctx.translate(w*.82,h*.15); ctx.rotate(now/9000);
      ctx.strokeStyle='rgba(255,224,105,.22)'; ctx.lineWidth=2;
      for(let i=0;i<8;i++){ctx.rotate(Math.PI/4);ctx.beginPath();ctx.moveTo(38,0);ctx.lineTo(58,0);ctx.stroke();}
      ctx.restore();
      return;
    }
    if (t === 'cloudy') {
      ctx.fillStyle='rgba(205,220,235,.08)';
      for(let i=0;i<4;i++){ const x=((now*.008+i*260)%(w+220))-110; const y=55+(i%2)*80;
        ctx.beginPath(); ctx.ellipse(x,y,85,24,0,0,Math.PI*2); ctx.fill();
      }
      return;
    }
    if (t === 'flooded') {
      ctx.fillStyle='rgba(40,125,170,.08)'; ctx.fillRect(0,h*.68,w,h*.32);
      ctx.strokeStyle='rgba(115,210,245,.18)'; ctx.lineWidth=1.5;
      for(let i=0;i<12;i++){ const y=h*.7+i*18+Math.sin(now/900+i)*3; ctx.beginPath(); ctx.moveTo(0,y); ctx.quadraticCurveTo(w*.25,y-4,w*.5,y); ctx.quadraticCurveTo(w*.75,y+4,w,y); ctx.stroke(); }
      return;
    }
    const storm = t==='storm';
    ctx.strokeStyle = storm ? 'rgba(190,215,240,.38)' : 'rgba(175,205,230,.30)';
    ctx.lineWidth = storm ? 1.2 : 1;
    for (const p of this.weatherParticles) {
      p.x += p.drift*dt; p.y += p.speed*dt;
      if (p.y > h+30 || p.x < -40 || p.x > w+40) Object.assign(p,this.makeWeatherParticle(w,h,false));
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.drift*.035,p.y+p.len*(storm?1.5:1)); ctx.stroke();
    }
    if (storm && Math.random()<0.012) {
      ctx.fillStyle='rgba(225,240,255,.20)'; ctx.fillRect(0,0,w,h);
    }
  }

  /* per-frame refresh */
  refresh() {
    // Backwards-compatible full refresh for external callers. The main loop
    // now stages these operations to avoid expensive Leaflet work every frame.
    this.refreshRoads();
    this.refreshSignals();
    this.drawVehicles();
    this.refreshLocationPins();
  }
}

window.MapView = MapView;
