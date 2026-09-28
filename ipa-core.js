/* ipa-core.js — pure analysis functions for the IPA MIP Classifier Portal.
 * No DOM / React dependencies so it can be unit-tested in Node.
 *
 * Method references (see Methods panel in the app):
 *  - Cole & Cole (1941); Pelton et al. (1978) — spectral IP / phase-vs-frequency response.
 *  - Wynn (USGS) marine IP streamer work — towed-streamer IP for metallic / heavy-mineral
 *    targets and oil-in-seawater characterisation.
 *  - Olhoeft (1985) — low-frequency electrical properties; organic/hydrocarbon reactions
 *    produce characteristic phase-spectrum behaviour distinct from metallic polarisation.
 *  - Kruse et al. (1993) spectral angle mapper — amplitude-invariant signature matching.
 *  - Hampel/Huber robust statistics — running median + MAD background, 1.4826 scale factor.
 *  - Hydrographic "patch test" practice — reciprocal lines over a known target separate
 *    along-track sensor offset (layback) and latency from target-position error.
 *  - Cohen (1960) kappa; standard precision/recall/F1 for classifier accuracy.
 */
(function (root) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var HARM = { 2: [2, 6, 10, 14, 18, 22], 4: [4, 12, 20, 28, 36, 44], 8: [8, 24, 40, 56, 72, 88] };
  function getHarms(xmt) { return HARM[xmt] || HARM[4]; }

  var MAT_COLORS = {
    'Hydrocarbon IP': '#0080b0', 'Class 3 Gas Oil': '#4070c0', 'Alaska Crude Oil': '#c07820',
    'ITB Rebel Crude': '#1a8c4e', 'Metallic IP': '#b02040', 'Steel': '#cc2233',
    'Ilmenite': '#a04010', 'Galvanized Steel': '#807030', 'Mixed': '#5a50c8',
    'Asphalt': '#607060', 'Artifact': '#c05000', 'Weak/Inconclusive': '#708090', 'No anomaly': '#9090a0',
    'Seawater blank': '#90a0b0'
  };
  var MAT_OPTIONS = ['Hydrocarbon IP', 'Class 3 Gas Oil', 'Alaska Crude Oil', 'ITB Rebel Crude',
    'Metallic IP', 'Steel', 'Ilmenite', 'Galvanized Steel', 'Mixed', 'Asphalt', 'Artifact', 'Weak/Inconclusive'];
  var LAB_REF_OPTIONS = ['Seawater blank', 'Class 3 Gas Oil', 'Alaska Crude Oil', 'ITB Rebel Crude',
    'Asphalt', 'Hydrocarbon IP', 'Steel', 'Galvanized Steel', 'Ilmenite', 'Metallic IP', 'Mixed'];

  var FAMILY = {
    'Hydrocarbon IP': 'hydrocarbon', 'Class 3 Gas Oil': 'hydrocarbon', 'Alaska Crude Oil': 'hydrocarbon',
    'ITB Rebel Crude': 'hydrocarbon', 'Asphalt': 'hydrocarbon',
    'Metallic IP': 'metallic', 'Steel': 'metallic', 'Ilmenite': 'metallic', 'Galvanized Steel': 'metallic',
    'Mixed': 'mixed', 'Artifact': 'artifact', 'Weak/Inconclusive': 'weak', 'No anomaly': 'none'
  };
  function family(cls) { return FAMILY[cls] || 'other'; }

  var DEFAULT_PROC = {
    mode: 'robust',        // 'robust' | 'legacy' (v26 behaviour)
    detrendWin: 61,        // packets in running-median background window
    zThresh: 3.0,          // robust z threshold for anomalous packet
    minHarmHits: 2,        // harmonics (excl. fundamental) that must exceed zThresh
    gapPkts: 5,            // max packet-index gap inside one event
    minPkts: 1,            // min packets per event
    labCosMin: 0.90,       // spectral-angle cosine required to accept a lab match
    applyLayback: true,
    laybackM: 0,           // along-track sensor offset behind GPS (m)
    latencyS: 0,           // processing / timing latency (s) -> v*tau extra offset
    matchRadiusM: 60,      // calibration: search radius event<->waypoint (raw positions)
    maxCrossM: 20,         // calibration: max cross-track distance to accept
    minSNRcal: 6,          // calibration: min event SNR (any harmonic)
    mergeRadiusM: 15,      // corroboration: cluster radius between runs
    passRadiusM: 12,       // metrics: track must pass this close to count as a pass
    detRadiusM: 20         // metrics: detection within this radius counts as a hit
  };

  // ── Small maths helpers ────────────────────────────────────────────────────
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function median(arr) {
    var a = arr.filter(finite).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mad(arr, med) {
    if (med === undefined) med = median(arr);
    return median(arr.filter(finite).map(function (v) { return Math.abs(v - med); }));
  }
  function mean(arr) { var a = arr.filter(finite); return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : NaN; }
  function std(arr) {
    var a = arr.filter(finite); if (a.length < 2) return NaN;
    var m = mean(a); return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }
  function runningMedian(arr, win) {
    var n = arr.length, half = Math.max(1, Math.floor(win / 2)), out = new Array(n);
    if (win >= n) { var m = median(arr); for (var k = 0; k < n; k++) out[k] = m; return out; }
    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half), w = [];
      for (var j = lo; j <= hi; j++) if (finite(arr[j])) w.push(arr[j]);
      out[i] = w.length ? median(w) : NaN;
    }
    return out;
  }
  // Solve small linear least squares via normal equations (+ tiny ridge).
  function lstsq(X, y) {
    var p = X[0].length, A = [], b = [], i, j, k;
    for (i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
    for (k = 0; k < X.length; k++) for (i = 0; i < p; i++) {
      b[i] += X[k][i] * y[k];
      for (j = 0; j < p; j++) A[i][j] += X[k][i] * X[k][j];
    }
    for (i = 0; i < p; i++) A[i][i] += 1e-9;
    var inv = invert(A); if (!inv) return null;
    var beta = inv.map(function (row) { return row.reduce(function (s, v, c) { return s + v * b[c]; }, 0); });
    return { beta: beta, inv: inv };
  }
  function invert(M) {
    var n = M.length, A = M.map(function (r, i) { var e = new Array(n).fill(0); e[i] = 1; return r.slice().concat(e); });
    for (var c = 0; c < n; c++) {
      var piv = c; for (var r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-14) return null;
      var t = A[c]; A[c] = A[piv]; A[piv] = t;
      var d = A[c][c]; for (var k = 0; k < 2 * n; k++) A[c][k] /= d;
      for (r = 0; r < n; r++) if (r !== c) { var f = A[r][c]; for (k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map(function (r) { return r.slice(n); });
  }

  // ── Geodesy ────────────────────────────────────────────────────────────────
  var R_EARTH = 6371008.8, D2R = Math.PI / 180;
  function haversine(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * D2R) * Math.cos(lat2 * D2R);
    var x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) - Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  // local east/north metres of (lat,lon) relative to (lat0,lon0)
  function enu(lat0, lon0, lat, lon) {
    return [(lon - lon0) * D2R * R_EARTH * Math.cos(lat0 * D2R), (lat - lat0) * D2R * R_EARTH];
  }
  function offsetLL(lat, lon, dE, dN) {
    return [lat + dN / R_EARTH / D2R, lon + dE / (R_EARTH * Math.cos(lat * D2R)) / D2R];
  }
  function angDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // ── Parsers ────────────────────────────────────────────────────────────────
  function isLabFile(parts) { return parts[9] === 'Lab' || !parts[6]; }
  // NMEA DDMM.MMMMM -> decimal degrees. West-coast lon negated (instrument convention).
  function nmeaDD(raw, isLon) {
    var v = parseFloat(raw); if (isNaN(v)) return null;
    var deg = Math.floor(v / 100), mins = v - deg * 100, dd = deg + mins / 60;
    return isLon ? -dd : dd;
  }
  function parseTime(ts) {
    if (!ts) return NaN;
    var s = String(ts).trim();
    var m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) / 1000 + parseFloat(m[6]);
    var t = Date.parse(s); if (finite(t)) return t / 1000;
    m = s.match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    return NaN;
  }

  // Packet: 1 header + 1 col-header + 31 data rows. col[0]=freq, col[1]=ch1-0 delta rad, col[9]=ch1 mag
  function parseAnyFile(text) {
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var pkts = [];
    for (var i = 0; i < lines.length;) {
      var raw = lines[i].replace(/^﻿/, '');
      if (!raw.startsWith('#,')) { i++; continue; }
      var p = raw.split(',');
      var idx = parseInt(p[8]), xmt = parseInt(p[12]), ts = p[3], run = (p[2] || '').trim();
      var lab = isLabFile(p);
      var lat = lab ? null : nmeaDD((p[6] || '').trim(), false);
      var lon = lab ? null : nmeaDD((p[7] || '').trim(), true);
      if (!isNaN(idx) && !isNaN(xmt)) {
        var freqs = {};
        for (var r = i + 2; r < i + 33 && r < lines.length; r++) {
          var dl = lines[r].trim();
          if (!dl || dl.startsWith('#')) break;
          var c = dl.split(',');
          if (c.length < 10) continue;
          var freq = parseFloat(c[0]), dp = parseFloat(c[1]), mg = parseFloat(c[9]);
          if (!isNaN(freq) && !isNaN(dp) && !isNaN(mg)) freqs[freq] = [dp, mg];
        }
        if (Object.keys(freqs).length) {
          pkts.push({ idx: idx, ts: ts, t: parseTime(ts), run: run, xmt: xmt, lat: lat, lon: lon, freqs: freqs, type: lab ? 'lab' : 'field' });
        }
      }
      i += 33;
    }
    return pkts;
  }

  // ── Waypoints (CSV / TXT / GPX) ────────────────────────────────────────────
  function parseCoord(raw, isLon) {
    if (raw === undefined || raw === null) return NaN;
    var s = String(raw).trim().replace(/["']/g, function (c) { return c === '"' ? ' ' : ' '; });
    if (!s) return NaN;
    var hemi = (s.match(/[NSEWnsew]/) || [''])[0].toUpperCase();
    var neg = /^-/.test(s) || hemi === 'S' || hemi === 'W';
    var nums = s.replace(/[NSEWnsew°º]/g, ' ').replace(/^-/, '').trim().split(/[\s:]+/).filter(Boolean).map(parseFloat);
    if (!nums.length || nums.some(isNaN)) return NaN;
    var v;
    if (nums.length >= 3) v = nums[0] + nums[1] / 60 + nums[2] / 3600;
    else if (nums.length === 2) v = nums[0] + nums[1] / 60;
    else {
      v = nums[0];
      var lim = isLon ? 180 : 90;
      if (v > lim) { var deg = Math.floor(v / 100); v = deg + (v - deg * 100) / 60; } // NMEA DDMM.mmmm
    }
    return neg ? -v : v;
  }
  function parseWaypoints(text, fileName) {
    var wps = [];
    if (/<gpx|<wpt/i.test(text)) {
      var re = /<(wpt|rtept|trkpt)\b([^>]*)>([\s\S]*?)<\/\1>|<(wpt|rtept)\b([^>]*)\/>/gi, m;
      while ((m = re.exec(text))) {
        var attrs = m[2] || m[5] || '', body = m[3] || '';
        var la = attrs.match(/lat\s*=\s*"([^"]+)"/i), lo = attrs.match(/lon\s*=\s*"([^"]+)"/i);
        if (!la || !lo) continue;
        var nm = body.match(/<name>([\s\S]*?)<\/name>/i), ds = body.match(/<(desc|cmt|type)>([\s\S]*?)<\/\1>/i);
        wps.push({ name: nm ? nm[1].trim() : 'WP' + (wps.length + 1), lat: +la[1], lon: +lo[1], material: ds ? matchMaterial(ds[2]) : null, source: fileName });
      }
      return wps;
    }
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() && !/^\s*(#|\/\/)/.test(l); });
    if (!lines.length) return wps;
    var delim = lines[0].indexOf('\t') >= 0 ? '\t' : lines[0].indexOf(';') >= 0 ? ';' : ',';
    var split = function (l) { return l.split(delim).map(function (c) { return c.trim().replace(/^"|"$/g, ''); }); };
    var head = split(lines[0]).map(function (h) { return h.toLowerCase(); });
    var find = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
    var iLat = find(/^(lat|latitude|y|lat_dd|lat\s*\(.*\))$/), iLon = find(/^(lon|long|lng|longitude|x|lon_dd|lon\s*\(.*\))$/);
    if (iLat < 0) iLat = find(/lat/); if (iLon < 0) iLon = find(/lon|lng/);
    var iName = find(/^(name|id|label|waypoint|wp|target|ident)/), iMat = find(/material|type|class|sample|target_type|desc/);
    var start = 1;
    if (iLat < 0 || iLon < 0) {
      // No header: guess name,lat,lon or lat,lon
      start = 0; var c0 = split(lines[0]);
      if (c0.length >= 3 && isNaN(parseFloat(c0[0]))) { iName = 0; iLat = 1; iLon = 2; iMat = c0.length > 3 ? 3 : -1; }
      else { iLat = 0; iLon = 1; iName = c0.length > 2 ? 2 : -1; iMat = -1; }
    }
    if (iMat === iName) iMat = -1;
    for (var li = start; li < lines.length; li++) {
      var c = split(lines[li]);
      var lat = parseCoord(c[iLat], false), lon = parseCoord(c[iLon], true);
      if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      wps.push({ name: iName >= 0 && c[iName] ? c[iName] : 'WP' + (wps.length + 1), lat: lat, lon: lon,
        material: iMat >= 0 ? matchMaterial(c[iMat]) : null, source: fileName });
    }
    return wps;
  }
  // If waypoint longitudes lack a W sign but field tracks are west-negative, flip them.
  function alignWaypointHemisphere(wps, refLon) {
    if (!finite(refLon) || !wps.length) return wps;
    return wps.map(function (w) {
      if (refLon < 0 && w.lon > 0 && Math.abs(w.lon + refLon) < 2) return Object.assign({}, w, { lon: -w.lon, flipped: true });
      return w;
    });
  }
  function matchMaterial(s) {
    if (!s) return null; var t = String(s).toLowerCase();
    var keys = [['seawater', 'Seawater blank'], ['blank', 'Seawater blank'], ['galv', 'Galvanized Steel'], ['steel', 'Steel'],
      ['ilmen', 'Ilmenite'], ['gas oil', 'Class 3 Gas Oil'], ['class 3', 'Class 3 Gas Oil'], ['class3', 'Class 3 Gas Oil'],
      ['alaska', 'Alaska Crude Oil'], ['ans', 'Alaska Crude Oil'], ['rebel', 'ITB Rebel Crude'], ['itb', 'ITB Rebel Crude'],
      ['asphalt', 'Asphalt'], ['bitum', 'Asphalt'], ['crude', 'Hydrocarbon IP'], ['oil', 'Hydrocarbon IP'], ['hydro', 'Hydrocarbon IP'],
      ['metal', 'Metallic IP'], ['iron', 'Metallic IP'], ['mixed', 'Mixed'], ['control', 'Seawater blank'], ['none', 'No anomaly']];
    for (var i = 0; i < keys.length; i++) if (t.indexOf(keys[i][0]) >= 0) return keys[i][1];
    return null;
  }

  // ── Lab stats ──────────────────────────────────────────────────────────────
  function computeLabStats(packets) {
    var byXmt = {};
    packets.forEach(function (pk) {
      var x = pk.xmt; if (!byXmt[x]) byXmt[x] = {};
      Object.keys(pk.freqs).forEach(function (k) {
        var f = parseFloat(k); if (!byXmt[x][f]) byXmt[x][f] = { dp: [], mag: [] };
        byXmt[x][f].dp.push(pk.freqs[k][0]); byXmt[x][f].mag.push(pk.freqs[k][1]);
      });
    });
    return Object.keys(byXmt).map(Number).sort(function (a, b) { return a - b; }).map(function (xmt) {
      var fm = byXmt[xmt], fk = Object.keys(fm).map(Number).sort(function (a, b) { return a - b; });
      var rows = fk.map(function (freq) {
        var dps = fm[freq].dp, n = dps.length, mDp = mean(dps), sDp = n > 1 ? std(dps) : 0;
        return { freq: freq, meanDp: mDp, stdDp: sDp, meanMag: mean(fm[freq].mag), n: n };
      });
      return { xmt: xmt, nPkts: fm[fk[0]] ? fm[fk[0]].dp.length : 0, rows: rows };
    });
  }
  // Build a reference signature (mrad at each harmonic) from a lab-stats group.
  function labSignatureFromGroup(grp, material, run) {
    var harms = getHarms(grp.xmt), mean_ = [], std_ = [], freqs = [];
    harms.forEach(function (f) {
      var row = grp.rows.filter(function (r) { return Math.abs(r.freq - f) < 1e-6; })[0];
      if (row) { freqs.push(f); mean_.push(row.meanDp * 1000); std_.push(row.stdDp * 1000); }
    });
    return { material: material, xmt: grp.xmt, freqs: freqs, mean: mean_, std: std_, n: grp.nPkts, run: run };
  }

  // ── Background ─────────────────────────────────────────────────────────────
  function computeBG(packets, harms, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var perHz = {}, f0 = harms[0];
    if (opts.mode === 'legacy') {
      harms.forEach(function (f) {
        var dps = packets.map(function (pk) { var v = pk.freqs[f]; return v ? v[0] * 1000 : NaN; });
        var bgV = dps.filter(function (v) { return !isNaN(v) && Math.abs(v) < 15; });
        if (bgV.length < 3) bgV = dps.filter(function (v) { return !isNaN(v); });
        if (!bgV.length) { perHz[f] = { mean: 0, std: 1, base: null }; return; }
        var m = mean(bgV), s = bgV.length > 1 ? std(bgV) : 1;
        perHz[f] = { mean: m, std: s || 1, base: null };
      });
      var d1 = packets.map(function (pk) { var v = pk.freqs[f0]; return v ? v[0] * 1000 : NaN; });
      var mBg = packets.map(function (pk, i) { var v = pk.freqs[f0]; return v && !isNaN(d1[i]) && Math.abs(d1[i]) < 15 ? v[1] : NaN; }).filter(finite);
      var magMean = mBg.length ? mean(mBg) : 1;
      return { mode: 'legacy', mean: perHz[f0].mean, std: perHz[f0].std, magMean: magMean, magBase: null, perHz: perHz };
    }
    // Robust: running-median detrend + MAD noise (Hampel-style)
    harms.forEach(function (f) {
      var dps = packets.map(function (pk) { var v = pk.freqs[f]; return v ? v[0] * 1000 : NaN; });
      var base = runningMedian(dps, opts.detrendWin);
      var resid = dps.map(function (v, i) { return v - base[i]; });
      var s = 1.4826 * mad(resid, 0 + median(resid));
      if (!finite(s) || s <= 1e-6) s = std(resid) || 1;
      perHz[f] = { mean: median(dps), std: s, base: base };
    });
    var mags = packets.map(function (pk) { var v = pk.freqs[f0]; return v ? v[1] : NaN; });
    var magBase = runningMedian(mags, opts.detrendWin);
    return { mode: 'robust', mean: perHz[f0].mean, std: perHz[f0].std, magMean: median(mags) || 1, magBase: magBase, perHz: perHz };
  }
  function bgAt(bg, f, i) {
    var p = bg.perHz[f]; if (!p) return bg.mean;
    return p.base && finite(p.base[i]) ? p.base[i] : p.mean;
  }

  // ── Detection ──────────────────────────────────────────────────────────────
  function detectAnomalies(packets, harms, bg, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var f0 = harms[0], s0 = bg.perHz[f0] ? bg.perHz[f0].std : bg.std, T = opts.zThresh, anomalies = [];
    for (var i = 0; i < packets.length; i++) {
      var pk = packets[i], v0 = pk.freqs[f0]; if (!v0) continue;
      var z0 = Math.abs(v0[0] * 1000 - bgAt(bg, f0, i)) / s0;
      if (opts.mode === 'legacy') { if (z0 >= 3.0) anomalies.push({ i: i, pk: pk, snr: z0, snr0: z0, hits: 0 }); continue; }
      var zmax = z0, hits = 0;
      for (var h = 1; h < harms.length; h++) {
        var v = pk.freqs[harms[h]]; if (!v) continue;
        var ph = bg.perHz[harms[h]], z = Math.abs(v[0] * 1000 - bgAt(bg, harms[h], i)) / ph.std;
        if (z >= T) hits++; if (z > zmax) zmax = z;
      }
      if (z0 >= T || hits >= opts.minHarmHits) anomalies.push({ i: i, pk: pk, snr: zmax, snr0: z0, hits: hits });
    }
    var gap = opts.mode === 'legacy' ? 5 : opts.gapPkts, clusters = [], cur = [];
    anomalies.forEach(function (a) {
      if (!cur.length || a.pk.idx - cur[cur.length - 1].pk.idx <= gap) cur.push(a);
      else { clusters.push(cur); cur = [a]; }
    });
    if (cur.length) clusters.push(cur);
    if (opts.mode !== 'legacy' && opts.minPkts > 1) clusters = clusters.filter(function (c) { return c.length >= opts.minPkts; });
    return clusters;
  }

  // ── Track kinematics (course/speed over ground from GPS) ───────────────────
  function computeKinematics(packets, k) {
    k = k || 3;
    var n = packets.length, out = new Array(n);
    // median dt per index step for files with bad timestamps
    var steps = [];
    for (var i = 1; i < n; i++) {
      var dt = packets[i].t - packets[i - 1].t, di = packets[i].idx - packets[i - 1].idx;
      if (finite(dt) && dt > 0 && di > 0 && dt < 60) steps.push(dt / di);
    }
    var secPerIdx = median(steps); if (!finite(secPerIdx) || secPerIdx <= 0) secPerIdx = 1;
    for (i = 0; i < n; i++) {
      var a = null, b = null;
      for (var j = Math.max(0, i - k); j <= i; j++) if (packets[j].lat !== null) { a = j; break; }
      for (j = Math.min(n - 1, i + k); j >= i; j--) if (packets[j].lat !== null) { b = j; break; }
      if (a === null || b === null || a === b) { out[i] = { cog: null, sog: null }; continue; }
      var pa = packets[a], pb = packets[b], d = haversine(pa.lat, pa.lon, pb.lat, pb.lon);
      var dtt = pb.t - pa.t; if (!(finite(dtt) && dtt > 0 && dtt < 120)) dtt = (pb.idx - pa.idx) * secPerIdx;
      out[i] = d < 0.5 ? { cog: null, sog: d / dtt } : { cog: bearing(pa.lat, pa.lon, pb.lat, pb.lon), sog: d / dtt };
    }
    return out;
  }
  function laybackShift(lat, lon, cog, sog, L, tau) {
    if (lat === null || lon === null || !finite(cog)) return [lat, lon];
    var d = (L || 0) + (tau || 0) * (finite(sog) ? sog : 0);
    if (!d) return [lat, lon];
    return offsetLL(lat, lon, -d * Math.sin(cog * D2R), -d * Math.cos(cog * D2R));
  }

  // ── Rule classifier (v26 rule tree, with detrended per-packet background) ──
  function classifyRules(cluster, harms, bg, kin) {
    var rep = cluster[0];
    cluster.forEach(function (a) { if (a.snr > rep.snr) rep = a; });
    var pk = rep.pk, i = rep.i, dp = {}, dpDev = {};
    harms.forEach(function (f) { var v = pk.freqs[f]; dp[f] = v ? v[0] * 1000 : 0; dpDev[f] = dp[f] - bgAt(bg, f, i); });
    var mag0 = pk.freqs[harms[0]];
    var magRef = bg.magBase && finite(bg.magBase[i]) ? bg.magBase[i] : bg.magMean;
    var magPct = mag0 ? ((mag0[1] - magRef) / magRef) * 100 : 0;
    var dp1dev = dpDev[harms[0]];
    var posHigh = 0; for (var h = 2; h < harms.length; h++) if (dpDev[harms[h]] > 3) posHigh++;
    var negLow = 0; for (h = 0; h < 3; h++) if (dpDev[harms[h]] < -5) negLow++;
    var altPol = (dp[harms[0]] * dp[harms[1]] < 0 && dp[harms[1]] * dp[harms[2]] < 0);
    var maxSNR = finite(rep.snr0) ? rep.snr0 : rep.snr, maxSNRall = maxSNR;
    harms.forEach(function (f) { var p = bg.perHz[f]; if (p) { var z = Math.abs(dpDev[f]) / p.std; if (z > maxSNRall) maxSNRall = z; } });
    var cls, confPct;
    if (Math.abs(dp1dev) > 150) { cls = 'Artifact'; confPct = 99; }
    else if (magPct < -30) { cls = 'Artifact'; confPct = 99; }
    else if (posHigh >= 3 && Math.abs(dp1dev) < 10 && maxSNRall > 10) { cls = 'Hydrocarbon IP'; confPct = Math.min(95, 80 + maxSNRall / 5); }
    else if (posHigh >= 2 && Math.abs(dp1dev) < 12 && maxSNRall > 5) { cls = 'Hydrocarbon IP'; confPct = Math.min(80, 60 + maxSNRall / 4); }
    else if (dp1dev < -8 && negLow >= 2 && !altPol && maxSNR > 8) { cls = 'Metallic IP'; confPct = Math.min(92, 75 + maxSNR / 8); }
    else if (dp1dev < -5 && negLow >= 1 && maxSNR > 5) { cls = 'Metallic IP'; confPct = Math.min(75, 55 + maxSNR / 6); }
    else if (dp1dev < -5 && posHigh >= 2) { cls = 'Mixed'; confPct = Math.min(70, 55 + maxSNR / 8); }
    else if (posHigh >= 2 && maxSNRall > 3) { cls = 'Hydrocarbon IP'; confPct = Math.min(60, 40 + maxSNRall / 3); }
    else { cls = 'Weak/Inconclusive'; confPct = Math.min(35, 15 + maxSNR * 3); }
    // Spectral slope of deviation vs log10(f) — mrad/decade (Cole-Cole shape proxy)
    var xs = harms.map(function (f) { return Math.log10(f); }), ys = harms.map(function (f) { return dpDev[f]; });
    var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
    xs.forEach(function (x, k) { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) * (x - mx); });
    var kk = kin && kin[i] ? kin[i] : { cog: null, sog: null };
    return { cls: cls, confPct: Math.round(confPct), dp: dp, dpDev: dpDev, magPct: magPct,
      maxSNR: maxSNR, maxSNRall: maxSNRall, phaseSlope: sxx ? sxy / sxx : 0, posHigh: posHigh, negLow: negLow,
      pktStart: cluster[0].pk.idx, pktEnd: cluster[cluster.length - 1].pk.idx, pktPeak: pk.idx, i: i,
      ts: pk.ts, t: pk.t, nPkts: cluster.length, lat: pk.lat, lon: pk.lon, cog: kk.cog, sog: kk.sog };
  }

  // ── Lab signature matching (weighted spectral-angle) ───────────────────────
  function labMatch(ev, harms, bg, sigs) {
    if (!sigs || !sigs.length) return [];
    var xmt = harms[0] === 2 ? 2 : harms[0] === 8 ? 8 : 4;
    var blanks = sigs.filter(function (s) { return s.material === 'Seawater blank' && s.xmt === xmt; });
    var blank = blanks.length ? blanks[blanks.length - 1] : null;
    var out = [];
    sigs.forEach(function (s) {
      if (s.material === 'Seawater blank' || s.xmt !== xmt) return;
      var sx = 0, ss = 0, xx = 0, n = 0, W = [], X = [], S = [];
      harms.forEach(function (f) {
        var k = s.freqs.indexOf(f); if (k < 0) return;
        var sv = s.mean[k], sd = s.std[k] || 0;
        if (blank) { var kb = blank.freqs.indexOf(f); if (kb >= 0) { sv -= blank.mean[kb]; sd = Math.sqrt(sd * sd + Math.pow(blank.std[kb] || 0, 2)); } }
        var fs = bg.perHz[f] ? bg.perHz[f].std : 1, w = 1 / (fs * fs + sd * sd + 1e-6), x = ev.dpDev[f];
        if (!finite(x) || !finite(sv)) return;
        W.push(w); X.push(x); S.push(sv); sx += w * x * sv; ss += w * sv * sv; xx += w * x * x; n++;
      });
      if (n < 3 || ss <= 0 || xx <= 0) return;
      var cos = sx / Math.sqrt(ss * xx), a = sx / ss, chi = 0;
      for (var k = 0; k < n; k++) chi += W[k] * Math.pow(X[k] - a * S[k], 2);
      out.push({ material: s.material, run: s.run, cos: cos, angleDeg: Math.acos(Math.max(-1, Math.min(1, cos))) / D2R,
        scale: a, chi2red: chi / Math.max(1, n - 1), nHarm: n, blankUsed: !!blank });
    });
    return out.sort(function (p, q) { return q.cos - p.cos; });
  }
  function fuseClass(ev, best, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var base = { cls: ev.cls, conf: ev.confPct, src: 'rules', conflict: false };
    if (!best || best.cos < opts.labCosMin || best.scale <= 0 || ev.cls === 'Artifact') return base;
    var rf = family(ev.cls), lf = family(best.material);
    if (rf === lf) return { cls: best.material, conf: Math.round(Math.min(97, Math.max(ev.confPct, 50 + 45 * best.cos * Math.min(1, ev.maxSNRall / 10)))), src: 'rules+lab', conflict: false };
    if (rf === 'weak' && ev.maxSNRall >= opts.zThresh) return { cls: best.material, conf: Math.round(Math.min(70, 40 + 30 * best.cos)), src: 'lab', conflict: false };
    return { cls: ev.cls, conf: Math.max(10, ev.confPct - 20), src: 'rules', conflict: true, labCls: best.material };
  }

  // ── Full per-file analysis ─────────────────────────────────────────────────
  function analyzeField(packets, opts, labSigs) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var xmt = packets[0].xmt, harms = getHarms(xmt), bg = computeBG(packets, harms, opts);
    var kin = computeKinematics(packets);
    var clusters = detectAnomalies(packets, harms, bg, opts);
    var events = clusters.map(function (cl) {
      var ev = classifyRules(cl, harms, bg, kin);
      ev.labMatches = labMatch(ev, harms, bg, labSigs);
      ev.labBest = ev.labMatches[0] || null;
      var fu = fuseClass(ev, ev.labBest, opts);
      ev.fusedCls = fu.cls; ev.fusedConf = fu.conf; ev.fusedSrc = fu.src; ev.labConflict = fu.conflict;
      var c = opts.applyLayback ? laybackShift(ev.lat, ev.lon, ev.cog, ev.sog, opts.laybackM, opts.latencyS) : [ev.lat, ev.lon];
      ev.latC = c[0]; ev.lonC = c[1];
      return ev;
    });
    // corrected sensor track (for pass counting)
    var track = [], lenM = 0, prev = null;
    packets.forEach(function (pk, i) {
      if (pk.lat === null) return;
      var c = opts.applyLayback ? laybackShift(pk.lat, pk.lon, kin[i].cog, kin[i].sog, opts.laybackM, opts.latencyS) : [pk.lat, pk.lon];
      track.push({ lat: c[0], lon: c[1], cog: kin[i].cog, i: i });
      if (prev) { var d = haversine(prev[0], prev[1], pk.lat, pk.lon); if (d < 200) lenM += d; }
      prev = [pk.lat, pk.lon];
    });
    return { xmt: xmt, harms: harms, bg: bg, kin: kin, clusters: clusters, events: events, track: track, trackLenM: lenM };
  }

  // ── Layback calibration ────────────────────────────────────────────────────
  // fileEvents: [{fi, run, events:[ev]}]  (events carry RAW lat/lon + cog/sog)
  function collectCalibrationMatches(fileEvents, waypoints, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var best = {};
    fileEvents.forEach(function (fe) {
      fe.events.forEach(function (ev, ei) {
        if (ev.lat === null || !finite(ev.cog) || ev.maxSNRall < opts.minSNRcal || ev.cls === 'Artifact') return;
        var nw = null, nd = Infinity;
        waypoints.forEach(function (w, wi) { var d = haversine(w.lat, w.lon, ev.lat, ev.lon); if (d < nd) { nd = d; nw = wi; } });
        if (nw === null || nd > opts.matchRadiusM) return;
        var w = waypoints[nw], e = enu(w.lat, w.lon, ev.lat, ev.lon);
        var uE = Math.sin(ev.cog * D2R), uN = Math.cos(ev.cog * D2R);
        var along = e[0] * uE + e[1] * uN, cross = e[0] * uN - e[1] * uE;
        if (Math.abs(cross) > opts.maxCrossM) return;
        var key = fe.fi + '|' + nw, m = { fi: fe.fi, run: fe.run, ei: ei, wi: nw, wp: w.name, along: along, cross: cross,
          sog: ev.sog, cog: ev.cog, snr: ev.maxSNRall, dist: nd, cls: ev.fusedCls || ev.cls };
        if (!best[key] || best[key].snr < m.snr) best[key] = m;
      });
    });
    return Object.keys(best).map(function (k) { return best[k]; });
  }
  function axialMean(degs) {
    var s = 0, c = 0; degs.forEach(function (d) { s += Math.sin(2 * d * D2R); c += Math.cos(2 * d * D2R); });
    return ((Math.atan2(s, c) / D2R / 2) + 360) % 180;
  }
  function fitLayback(matches) {
    var res = { n: matches.length, ok: false };
    if (matches.length < 2) { res.msg = 'Need at least 2 strong detections matched to waypoints.'; return res; }
    var axis = axialMean(matches.map(function (m) { return m.cog; }));
    matches.forEach(function (m) { m.dir = Math.cos((m.cog - axis) * D2R) >= 0 ? 1 : -1; m.inlier = true; });
    var nF = matches.filter(function (m) { return m.dir > 0; }).length, nR = matches.length - nF;
    var sogs = matches.map(function (m) { return m.sog; }).filter(finite);
    var useV = sogs.length === matches.length && matches.length >= 5 && std(sogs) >= 0.15;
    var useS = nF >= 1 && nR >= 1 && matches.length >= 3;
    var fit = null, cols;
    for (var iter = 0; iter < 3; iter++) {
      var use = matches.filter(function (m) { return m.inlier; });
      var p = 1 + (useV ? 1 : 0) + (useS ? 1 : 0);
      if (use.length < p + 1) { useV = false; p = 1 + (useS ? 1 : 0); }
      if (use.length < p + 1) { useS = false; p = 1; }
      cols = ['L'].concat(useV ? ['tau'] : []).concat(useS ? ['bias'] : []);
      var X = use.map(function (m) { var r = [1]; if (useV) r.push(m.sog); if (useS) r.push(m.dir); return r; });
      var y = use.map(function (m) { return m.along; });
      fit = lstsq(X, y); if (!fit) break;
      var rr = matches.map(function (m) { var r = [1]; if (useV) r.push(m.sog); if (useS) r.push(m.dir);
        return m.along - r.reduce(function (s, v, k) { return s + v * fit.beta[k]; }, 0); });
      var sc = 1.4826 * mad(rr, 0 + median(rr));
      matches.forEach(function (m, k) { m.resid = rr[k]; m.inlier = !(sc > 0.5 && Math.abs(rr[k]) > 3 * sc && use.length > p + 2); });
    }
    if (!fit) { res.msg = 'Fit failed (degenerate geometry).'; return res; }
    var inl = matches.filter(function (m) { return m.inlier; }), dof = Math.max(1, inl.length - cols.length);
    var sse = inl.reduce(function (s, m) { return s + m.resid * m.resid; }, 0), s2 = sse / dof;
    var get = function (name) { var k = cols.indexOf(name); return k < 0 ? null : { v: fit.beta[k], se: Math.sqrt(Math.max(0, fit.inv[k][k] * s2)) }; };
    // Per-waypoint reciprocal-pair estimate (waypoint error cancels): mean of fwd & rev means
    var byWp = {};
    inl.forEach(function (m) { (byWp[m.wi] = byWp[m.wi] || { f: [], r: [] })[m.dir > 0 ? 'f' : 'r'].push(m.along); });
    var pairs = Object.keys(byWp).filter(function (k) { return byWp[k].f.length && byWp[k].r.length; })
      .map(function (k) { return (mean(byWp[k].f) + mean(byWp[k].r)) / 2; });
    var L = get('L'), tau = get('tau'), bias = get('bias');
    var medSog = median(inl.map(function (m) { return m.sog; }));
    return { ok: true, n: matches.length, nInliers: inl.length, nFwd: nF, nRev: nR, axisDeg: axis,
      L: L.v, seL: L.se, tau: tau ? tau.v : 0, seTau: tau ? tau.se : null, bias: bias ? bias.v : null,
      seBias: bias ? bias.se : null, usedSpeed: !!tau, usedDir: !!bias, rms: Math.sqrt(sse / Math.max(1, inl.length)),
      medSog: medSog, effOffset: L.v + (tau ? tau.v * (finite(medSog) ? medSog : 0) : 0),
      Lpairs: pairs.length ? median(pairs) : null, nPairs: pairs.length,
      crossMean: mean(inl.map(function (m) { return m.cross; })), crossStd: std(inl.map(function (m) { return m.cross; })),
      alongMedianRaw: median(matches.map(function (m) { return m.along; })), matches: matches };
  }

  // ── Corroboration (multi-run sites) ────────────────────────────────────────
  // points: [{lat,lon,cls,conf,fi,run,cog,snr,ei}]
  function buildSites(points, fileTracks, waypoints, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var n = points.length, parent = points.map(function (_, i) { return i; });
    function fnd(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      if (Math.abs(points[i].lat - points[j].lat) > 0.001) continue;
      if (haversine(points[i].lat, points[i].lon, points[j].lat, points[j].lon) <= opts.mergeRadiusM) parent[fnd(i)] = fnd(j);
    }
    var groups = {};
    points.forEach(function (p, i) { (groups[fnd(i)] = groups[fnd(i)] || []).push(p); });
    var sites = Object.keys(groups).map(function (k) {
      var g = groups[k], wsum = 0, la = 0, lo = 0;
      g.forEach(function (p) { var w = Math.max(1, p.snr || 1); wsum += w; la += w * p.lat; lo += w * p.lon; });
      la /= wsum; lo /= wsum;
      var runs = {}, cls = {}, fam = {};
      g.forEach(function (p) { runs[p.fi] = p.run; cls[p.cls] = (cls[p.cls] || 0) + 1; fam[family(p.cls)] = (fam[family(p.cls)] || 0) + 1; });
      var top = Object.keys(cls).sort(function (a, b) { return cls[b] - cls[a]; })[0];
      var topFam = Object.keys(fam).sort(function (a, b) { return fam[b] - fam[a]; })[0];
      var cogs = g.map(function (p) { return p.cog; }).filter(finite), recip = false;
      for (var a = 0; a < cogs.length && !recip; a++) for (var b = a + 1; b < cogs.length; b++) if (angDiff(cogs[a], cogs[b]) > 120) { recip = true; break; }
      var scatter = Math.sqrt(mean(g.map(function (p) { var d = haversine(la, lo, p.lat, p.lon); return d * d; })) || 0);
      // runs whose (corrected) sensor track passed over the site
      var passR = Math.max(opts.mergeRadiusM, opts.passRadiusM), passed = {};
      (fileTracks || []).forEach(function (ft) {
        for (var q = 0; q < ft.track.length; q++) {
          var tp = ft.track[q]; if (Math.abs(tp.lat - la) > 0.0005) continue;
          if (haversine(la, lo, tp.lat, tp.lon) <= passR) { passed[ft.fi] = ft.run; break; }
        }
      });
      Object.keys(runs).forEach(function (fi) { passed[fi] = runs[fi]; });
      var nRuns = Object.keys(runs).length, nPass = Object.keys(passed).length;
      var consensus = cls[top] / g.length, famConsensus = fam[topFam] / g.length;
      var nw = null, nd = Infinity;
      (waypoints || []).forEach(function (w) { var d = haversine(w.lat, w.lon, la, lo); if (d < nd) { nd = d; nw = w; } });
      var weakSite = topFam === 'weak' || topFam === 'artifact' || topFam === 'none';
      var tier = nRuns < 2 ? 'Single run' : weakSite ? 'Weak repeat' :
        nRuns >= 3 && famConsensus >= 0.67 && recip ? 'Confirmed' : famConsensus >= 0.5 ? 'Corroborated' : 'Conflicting';
      return { lat: la, lon: lo, members: g, nDet: g.length, nRuns: nRuns, nPass: nPass, runs: runs,
        repeatability: nPass ? nRuns / nPass : 0, cls: top, consensus: consensus, famConsensus: famConsensus,
        reciprocal: recip, scatterM: scatter, meanSNR: mean(g.map(function (p) { return p.snr; })),
        maxConf: Math.max.apply(null, g.map(function (p) { return p.conf || 0; })),
        nearestWp: nw ? nw.name : null, nearestWpM: nw ? nd : null, tier: tier };
    });
    var order = { 'Confirmed': 0, 'Corroborated': 1, 'Conflicting': 2, 'Weak repeat': 3, 'Single run': 4 };
    return sites.sort(function (a, b) { return order[a.tier] - order[b.tier] || b.nRuns - a.nRuns || b.meanSNR - a.meanSNR; });
  }

  // ── Detection performance vs known waypoints ───────────────────────────────
  function detectionMetrics(fileTracks, points, waypoints, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var perWp = waypoints.map(function (w) {
      var passes = 0, hits = 0, famOk = 0, famN = 0, classes = {};
      fileTracks.forEach(function (ft) {
        var passed = ft.track.some(function (tp) { return Math.abs(tp.lat - w.lat) < 0.0005 && haversine(w.lat, w.lon, tp.lat, tp.lon) <= opts.passRadiusM; });
        var dets = points.filter(function (p) { return p.fi === ft.fi && haversine(w.lat, w.lon, p.lat, p.lon) <= opts.detRadiusM; });
        if (!passed && !dets.length) return;
        passes++;
        if (dets.length) {
          hits++;
          var bestP = dets.reduce(function (a, b) { return (b.snr || 0) > (a.snr || 0) ? b : a; });
          classes[bestP.cls] = (classes[bestP.cls] || 0) + 1;
          if (w.material && w.material !== 'Seawater blank' && w.material !== 'No anomaly') { famN++; if (family(bestP.cls) === family(w.material)) famOk++; }
        }
      });
      var errs = points.filter(function (p) { return haversine(w.lat, w.lon, p.lat, p.lon) <= opts.detRadiusM; })
        .map(function (p) { return haversine(w.lat, w.lon, p.lat, p.lon); });
      return { name: w.name, material: w.material, passes: passes, hits: hits, pd: passes ? hits / passes : null,
        famOk: famOk, famN: famN, classes: classes, meanErrM: errs.length ? mean(errs) : null };
    });
    var isFA = function (p) { return !waypoints.some(function (w) { return haversine(w.lat, w.lon, p.lat, p.lon) <= opts.detRadiusM; }); };
    var fa = points.filter(isFA), km = fileTracks.reduce(function (s, ft) { return s + ft.trackLenM; }, 0) / 1000;
    var P = perWp.reduce(function (s, w) { return s + w.passes; }, 0), H = perWp.reduce(function (s, w) { return s + w.hits; }, 0);
    var fOk = perWp.reduce(function (s, w) { return s + w.famOk; }, 0), fN = perWp.reduce(function (s, w) { return s + w.famN; }, 0);
    var errsAll = []; perWp.forEach(function (w) { if (w.meanErrM !== null) errsAll.push(w.meanErrM); });
    return { perWp: perWp, passes: P, hits: H, pd: P ? H / P : null, pdCI: wilson(H, P), falseAlarms: fa.length, trackKm: km,
      faPerKm: km > 0 ? fa.length / km : null, famAcc: fN ? fOk / fN : null, famN: fN, meanPosErrM: errsAll.length ? mean(errsAll) : null,
      precision: points.length ? (points.length - fa.length) / points.length : null };
  }
  function wilson(k, n) {
    if (!n) return null; var z = 1.96, p = k / n, d = 1 + z * z / n;
    var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }

  // ── Classifier accuracy ────────────────────────────────────────────────────
  function confusion(truth, pred) {
    var classes = [];
    truth.concat(pred).forEach(function (c) { if (classes.indexOf(c) < 0) classes.push(c); });
    classes.sort();
    var idx = {}; classes.forEach(function (c, i) { idx[c] = i; });
    var M = classes.map(function () { return classes.map(function () { return 0; }); });
    truth.forEach(function (t, k) { M[idx[t]][idx[pred[k]]]++; });
    var N = truth.length, diag = 0; classes.forEach(function (_, i) { diag += M[i][i]; });
    var po = N ? diag / N : 0, pe = 0;
    classes.forEach(function (_, i) {
      var r = M[i].reduce(function (s, v) { return s + v; }, 0), c = M.reduce(function (s, row) { return s + row[i]; }, 0);
      pe += (r / N) * (c / N);
    });
    var per = classes.map(function (c, i) {
      var tp = M[i][i], sup = M[i].reduce(function (s, v) { return s + v; }, 0), pp = M.reduce(function (s, row) { return s + row[i]; }, 0);
      var P = pp ? tp / pp : 0, Rr = sup ? tp / sup : 0;
      return { cls: c, precision: P, recall: Rr, f1: P + Rr ? 2 * P * Rr / (P + Rr) : 0, support: sup };
    });
    var withSup = per.filter(function (p) { return p.support > 0; });
    return { classes: classes, M: M, n: N, accuracy: po, kappa: pe < 1 ? (po - pe) / (1 - pe) : 1, perClass: per,
      macroF1: withSup.length ? mean(withSup.map(function (p) { return p.f1; })) : 0, accCI: wilson(diag, N) };
  }
  function featureVec(r) { return [r.fv.dp1, r.fv.dp3, r.fv.dp_last, r.fv.magPct, finite(r.fv.slope) ? r.fv.slope : 0]; }
  function looKnn(rows, k) {
    k = k || 3;
    if (rows.length < 4) return null;
    var X = rows.map(featureVec), d = X[0].length, med = [], sc = [];
    for (var j = 0; j < d; j++) {
      var col = X.map(function (x) { return x[j]; }), m = median(col), s = 1.4826 * mad(col, m);
      if (!(s > 0)) s = std(col) || 1; med.push(m); sc.push(s);
    }
    var Z = X.map(function (x) { return x.map(function (v, j) { return (v - med[j]) / sc[j]; }); });
    var pred = rows.map(function (_, i) {
      var ds = [];
      Z.forEach(function (z, j) { if (j === i) return; var s = 0; for (var q = 0; q < d; q++) s += Math.pow(z[q] - Z[i][q], 2); ds.push([Math.sqrt(s), rows[j].material]); });
      ds.sort(function (a, b) { return a[0] - b[0]; });
      var votes = {}; ds.slice(0, k).forEach(function (p) { votes[p[1]] = (votes[p[1]] || 0) + 1 / (p[0] + 1e-3); });
      return Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; })[0];
    });
    return pred;
  }
  function reliability(truth, pred, conf) {
    var bins = [[0, 50], [50, 75], [75, 101]];
    return bins.map(function (b) {
      var ids = []; conf.forEach(function (c, i) { if (finite(c) && c >= b[0] && c < b[1]) ids.push(i); });
      var ok = ids.filter(function (i) { return truth[i] === pred[i]; }).length;
      return { range: b[0] + '–' + Math.min(100, b[1]) + '%', n: ids.length, acc: ids.length ? ok / ids.length : null,
        meanConf: ids.length ? mean(ids.map(function (i) { return conf[i]; })) : null };
    });
  }

  var API = {
    HARM: HARM, getHarms: getHarms, MAT_COLORS: MAT_COLORS, MAT_OPTIONS: MAT_OPTIONS, LAB_REF_OPTIONS: LAB_REF_OPTIONS,
    family: family, DEFAULT_PROC: DEFAULT_PROC, median: median, mad: mad, mean: mean, std: std, runningMedian: runningMedian,
    haversine: haversine, bearing: bearing, enu: enu, offsetLL: offsetLL, angDiff: angDiff,
    nmeaDD: nmeaDD, parseTime: parseTime, parseAnyFile: parseAnyFile, parseCoord: parseCoord, parseWaypoints: parseWaypoints,
    alignWaypointHemisphere: alignWaypointHemisphere, matchMaterial: matchMaterial,
    computeLabStats: computeLabStats, labSignatureFromGroup: labSignatureFromGroup,
    computeBG: computeBG, bgAt: bgAt, detectAnomalies: detectAnomalies, computeKinematics: computeKinematics,
    laybackShift: laybackShift, classifyRules: classifyRules, labMatch: labMatch, fuseClass: fuseClass, analyzeField: analyzeField,
    collectCalibrationMatches: collectCalibrationMatches, fitLayback: fitLayback, axialMean: axialMean,
    buildSites: buildSites, detectionMetrics: detectionMetrics, wilson: wilson,
    confusion: confusion, looKnn: looKnn, reliability: reliability
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.IPA = API;
})(typeof window !== 'undefined' ? window : globalThis);
