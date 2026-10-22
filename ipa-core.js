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
 *  - Layback is modelled LINEARLY along the boat's own recorded path: the towed sensor
 *    follows the path, sitting L + τ·v metres behind the GPS antenna (no heading projection).
 *  - Cohen (1960) kappa; standard precision/recall/F1 for classifier accuracy.
 */
(function (root) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var HARM = { 2: [2, 6, 10, 14, 18, 22], 3: [3, 9, 15, 21, 27, 33], 4: [4, 12, 20, 28, 36, 44], 8: [8, 24, 40, 56, 72, 88] };
  function getHarms(xmt) { return HARM[xmt] || HARM[4]; }

  var MAT_COLORS = {
    'Hydrocarbon IP': '#0080b0', 'Class 3 Gas Oil': '#4070c0', 'Alaska Crude Oil': '#c07820',
    'ITB Rebel Crude': '#1a8c4e', 'Metallic IP': '#b02040', 'Steel': '#cc2233',
    'Ilmenite': '#a04010', 'Galvanized Steel': '#807030', 'Mixed': '#5a50c8',
    'Asphalt': '#607060', 'Artifact': '#c05000', 'Weak/Inconclusive': '#708090', 'No anomaly': '#9090a0',
    'Seawater blank': '#90a0b0', 'Strong Anomaly': '#8a3ffc',
    'Group 5 Oil': '#2a6f97', 'Mineral Oil': '#5a8fb0', 'Copper': '#b86b2a', 'Lead': '#5c5c70', 'Zinc': '#7d8591',
    'Silver': '#8f98a3', 'Gold': '#c9a227', 'Silver Ore': '#6f7480', 'Bronze': '#a0662a', 'Rutile': '#8b4f39', 'Resistive (non-IP)': '#4f7f7a'
  };
  var MAT_OPTIONS = ['Hydrocarbon IP', 'Class 3 Gas Oil', 'Alaska Crude Oil', 'ITB Rebel Crude', 'Group 5 Oil', 'Mineral Oil',
    'Metallic IP', 'Steel', 'Ilmenite', 'Galvanized Steel', 'Copper', 'Lead', 'Zinc', 'Silver', 'Gold', 'Silver Ore', 'Bronze', 'Rutile', 'Mixed', 'Resistive (non-IP)', 'Asphalt', 'Strong Anomaly', 'Artifact', 'Weak/Inconclusive'];
  var LAB_REF_OPTIONS = ['Seawater blank', 'Class 3 Gas Oil', 'Alaska Crude Oil', 'ITB Rebel Crude', 'Group 5 Oil', 'Mineral Oil',
    'Asphalt', 'Hydrocarbon IP', 'Steel', 'Galvanized Steel', 'Ilmenite', 'Copper', 'Lead', 'Zinc', 'Silver', 'Gold', 'Silver Ore',
    'Bronze', 'Rutile', 'Metallic IP', 'Mixed'];

  var FAMILY = {
    'Hydrocarbon IP': 'hydrocarbon', 'Class 3 Gas Oil': 'hydrocarbon', 'Alaska Crude Oil': 'hydrocarbon',
    'ITB Rebel Crude': 'hydrocarbon', 'Asphalt': 'hydrocarbon', 'Group 5 Oil': 'hydrocarbon', 'Mineral Oil': 'hydrocarbon',
    'Copper': 'metallic', 'Lead': 'metallic', 'Zinc': 'metallic', 'Silver': 'metallic', 'Gold': 'metallic', 'Silver Ore': 'metallic',
    'Bronze': 'metallic', 'Rutile': 'metallic', 'Resistive (non-IP)': 'resistive',
    'Metallic IP': 'metallic', 'Steel': 'metallic', 'Ilmenite': 'metallic', 'Galvanized Steel': 'metallic',
    'Mixed': 'mixed', 'Strong Anomaly': 'strong', 'Artifact': 'artifact', 'Weak/Inconclusive': 'weak', 'No anomaly': 'none'
  };
  function family(cls) { return FAMILY[cls] || 'other'; }

  // ── v53: tiered classification (detection → family → material) ─────────────
  // Families are material classes. Specific materials sit inside one family; a confirmation or an AI call can
  // stop at any tier ("Anomaly → Metallic → material unknown"). The flat label kept for older code and the
  // training table is the deepest tier reached (labelOfTiers).
  var TIER_DETECTION = ['Anomaly', 'Weak/Inconclusive', 'Artifact', 'No anomaly'];
  var TIER_FAMILIES = ['Metallic', 'Hydrocarbon', 'Non-IP', 'Unknown'];
  var FAMILY_MATERIALS = {
    'Metallic': ['Steel', 'Galvanized Steel', 'Ilmenite', 'Rutile', 'Copper', 'Lead', 'Zinc', 'Silver', 'Silver Ore', 'Gold', 'Bronze'],
    'Hydrocarbon': ['Class 3 Gas Oil', 'Alaska Crude Oil', 'ITB Rebel Crude', 'Group 5 Oil', 'Mineral Oil', 'Asphalt'],
    'Non-IP': [], 'Unknown': []
  };
  var FAMILY_GENERIC = { 'Metallic': 'Metallic IP', 'Hydrocarbon': 'Hydrocarbon IP', 'Non-IP': 'Resistive (non-IP)', 'Unknown': 'Strong Anomaly' };
  function tierFamilyOf(material) {
    for (var f in FAMILY_MATERIALS) if (FAMILY_MATERIALS[f].indexOf(material) >= 0) return f;
    return null;
  }
  // Flat label (rules, lab, older AI, older confirmations) → tiers. depth = 1 detection, 2 family, 3 material.
  function tiersOf(label) {
    var L = String(label || '');
    if (!L) return { detection: null, family: null, material: null, depth: 0 };
    if (L === 'Weak/Inconclusive' || L === 'Artifact' || L === 'No anomaly') return { detection: L, family: null, material: null, depth: 1 };
    if (L === 'Strong Anomaly' || L === 'Mixed') return { detection: 'Anomaly', family: 'Unknown', material: null, depth: 1 };
    for (var f in FAMILY_GENERIC) if (FAMILY_GENERIC[f] === L && f !== 'Unknown') return { detection: 'Anomaly', family: f, material: null, depth: 2 };
    var fam = tierFamilyOf(L);
    if (fam) return { detection: 'Anomaly', family: fam, material: L, depth: 3 };
    return { detection: 'Anomaly', family: 'Unknown', material: null, depth: 1 };
  }
  // Tiers → the deepest flat label (always one of MAT_OPTIONS or 'No anomaly').
  function labelOfTiers(t) {
    if (!t || !t.detection) return null;
    if (t.detection !== 'Anomaly') return t.detection;
    if (t.material && tierFamilyOf(t.material) && (!t.family || t.family === tierFamilyOf(t.material))) return t.material;
    return FAMILY_GENERIC[t.family || 'Unknown'] || 'Strong Anomaly';
  }
  // Nearest logged known target (with a material) for an event, on the target's own drop date.
  function knownTargetFor(lat, lon, date, targets, maxM) {
    if (!finite(lat) || !finite(lon) || !targets) return null;
    maxM = maxM || 15; var best = null;
    targets.forEach(function (T) {
      if (!T.material || !tierFamilyOf(T.material)) return;
      if (T.date && date && T.date !== date) return;
      var d = distToTarget(lat, lon, T);
      if (d <= maxM && (!best || d < best.dist)) best = { target: T, dist: d };
    });
    return best;
  }

  var DEFAULT_PROC = {
    mode: 'robust',        // 'robust' | 'legacy' (fundamental 3σ, fixed background)
    detrendWin: 61,        // packets in running-median background window
    zThresh: 3.0,          // robust z threshold for anomalous packet
    minHarmHits: 1,        // harmonics (excl. fundamental) that must exceed zThresh (r7 §18 step 2: any single harmonic)
    rules: 'gt1',          // crossing classifier: 'gt1' (North Beach 2026 ground truth, corrected GPS) | 'r7' (WaTech-MatChar-r7 §17) | 'v32'
    mfMin: 3.0,            // gt1: matched-filter strength (3-packet mean of the 6-harmonic robust chi) needed for a material call
    artifactDevMrad: 150,  // |Δφ deviation| above this = phase wrap / dropout artifact
    reviewDevMrad: 100,    // r7: |Δφ| > 100 mrad at any harmonic = possible cable snag/contact → manual review flag
    magDetectPct: 5,       // r7 §18 step 3: a packet whose fundamental magnitude DROPS by ≥ this % is also flagged (0 = off).
                           // Decreases only: field magnitude has routine +8–12% upward excursions (p95, Nbeach/Fall 2024).
    minSNRmaterial: 6,     // r7 rules name a material only above this crossing SNR (r7 steel mean SNR 31, ilmenite 19.7)
    artifactMagPct: -50,   // Mag% below this = physical contact artifact (r7: cable snag −73.8%; steel reaches −30%)
    gapPkts: 2,            // contiguous-packet gap inside a sub-cluster
    mergeGapM: 25,         // sub-clusters closer than this along the path = one crossing
    minPkts: 1,            // min packets per crossing
    detChannels: 'ch1',    // receiver channels used for DETECTION: 'ch1' | 'all' (every active channel). Features always use all.
    nHarm: 6,              // odd harmonics used for detection: 6 (r7) … 'all' (every odd harmonic in the file, up to 31)
    magRef: 'ch0',         // magnitude reference: 'ch0' = channel mag ÷ ch0 mag (removes TX-current drift) | 'raw'
    labCosMin: 0.90,       // spectral-angle cosine required to accept a lab match
    applyLayback: true,
    laybackM: 28.7,        // L: along-path sensor offset behind the (re-timed) GPS (m). North Beach 2026 steel crossings, all days
    laybackByDate: { '2026-04-21': 30.1, '2026-04-22': 30.9, '2026-04-23': 22.7 },  // per-day calibration from known targets
    latencyS: 0,           // τ: extra offset per m/s of speed (s) — timing latency, half-packet, cable lift
    gpsFix: 'retime',      // 'retime' = put every packet on the GPS fix with its own UTC time (see retimePositions) | 'off'
    gpsOffsetM: 4.12,      // GPS antenna forward of the cable tie-down (survey drawing)
    cableM: 31,            // deployed cable length (m) — physical upper bound on L is gpsOffset + cable
    targetLinkM: 10,       // waypoints within this distance form one target
    dayFilter: true,       // only score a line against targets dropped on the line's date (logged drop dates)
    autoGroup: true,       // group field lines automatically by survey date
    anchorPassM: 15,       // calibration: boat must pass within this of a target (raw GPS)
    minLeadM: -5,          // calibration: detection may lead the boat's closest approach by at most this
    maxLeadM: 80,          // calibration: ... and trail it by at most this
    minSNRcal: 6,          // calibration: min crossing SNR
    mergeRadiusM: 15,      // corroboration: cluster radius between runs (corrected positions)
    passRadiusM: 12,       // corroboration: track within this of a site counts as a pass
    detRadiusM: 15         // coverage: detection within this of a target = HIT
  };


  // ── Small maths helpers ────────────────────────────────────────────────────
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  // Phase deviation in mrad wrapped to (−π, π]: angles that differ by 2π are equal (MIP Data Processing Procedure r2 §2.4).
  var PI_M = Math.PI * 1000;
  function wrapMrad(x) { if (!finite(x)) return x; var y = ((x + PI_M) % (2 * PI_M) + 2 * PI_M) % (2 * PI_M) - PI_M; return y === -PI_M ? PI_M : y; }
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
    // Sliding window kept sorted (binary-search insert/remove): same result as re-sorting each window, ~10× faster.
    var n = arr.length, half = Math.max(1, Math.floor(win / 2)), out = new Array(n);
    if (win >= n) { var m = median(arr); for (var k = 0; k < n; k++) out[k] = m; return out; }
    var w = [], lo = 0, hi = -1;
    function pos(v) { var a = 0, b = w.length; while (a < b) { var c = (a + b) >> 1; if (w[c] < v) a = c + 1; else b = c; } return a; }
    for (var i = 0; i < n; i++) {
      var nlo = Math.max(0, i - half), nhi = Math.min(n - 1, i + half);
      while (hi < nhi) { hi++; if (finite(arr[hi])) w.splice(pos(arr[hi]), 0, arr[hi]); }
      while (lo < nlo) { if (finite(arr[lo])) w.splice(pos(arr[lo]), 1); lo++; }
      var L = w.length;
      out[i] = L ? (L % 2 ? w[(L - 1) >> 1] : (w[L / 2 - 1] + w[L / 2]) / 2) : NaN;
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
        var freqs = {}, chan = {};
        for (var r = i + 2; r < i + 33 && r < lines.length; r++) {
          var dl = lines[r].trim();
          if (!dl || dl.startsWith('#')) break;
          var c = dl.split(',');
          if (c.length < 10) continue;
          var freq = parseFloat(c[0]), dp = parseFloat(c[1]), mg = parseFloat(c[9]);
          if (!isNaN(freq) && !isNaN(dp) && !isNaN(mg)) freqs[freq] = [dp, mg];
          // every receiver channel: ch1-0 … ch7-0 phase deltas (rad) and ch0 … ch7 magnitudes
          if (!isNaN(freq) && c.length >= 16) {
            var cd = [], cm = [];
            for (var k = 1; k <= 7; k++) cd.push(parseFloat(c[k]));
            for (var k2 = 8; k2 <= 15; k2++) cm.push(parseFloat(c[k2]));
            chan[freq] = { d: cd, m: cm };
          }
        }
        if (Object.keys(freqs).length) {
          pkts.push({ idx: idx, ts: ts, t: parseTime(ts), run: run, xmt: xmt, lat: lat, lon: lon, freqs: freqs, chan: Object.keys(chan).length ? chan : null, type: lab ? 'lab' : 'field', gpsT: (p[5] || '').trim() });
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
    if (/<kml|<Placemark/i.test(text)) {
      var pm = /<Placemark\b[\s\S]*?<\/Placemark>/gi, mm;
      while ((mm = pm.exec(text))) {
        var blk = mm[0], nm0 = blk.match(/<name>([\s\S]*?)<\/name>/i), co = blk.match(/<coordinates>\s*([-0-9.eE]+)\s*,\s*([-0-9.eE]+)/i);
        if (!co) continue;
        var ds0 = blk.match(/<description>([\s\S]*?)<\/description>/i);
        var nmv = nm0 ? nm0[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : 'WP' + (wps.length + 1);
        wps.push({ name: nmv, lat: +co[2], lon: +co[1], material: matchMaterial((ds0 ? ds0[1] : '') + ' ' + nmv), source: fileName });
      }
      return wps;
    }
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
    var keys = [['seawater', 'Seawater blank'], ['blank', 'Seawater blank'], ['baseline', 'Seawater blank'], ['galv', 'Galvanized Steel'], ['steel', 'Steel'],
      ['group 5', 'Group 5 Oil'], ['group_5', 'Group 5 Oil'], ['mineral oil', 'Mineral Oil'], ['silver ore', 'Silver Ore'], ['silver', 'Silver'],
      ['gold', 'Gold'], ['copper', 'Copper'], ['cu wire', 'Copper'], ['bronze', 'Bronze'], ['rutile', 'Rutile'], ['lead', 'Lead'], ['zinc', 'Zinc'],
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
  // legacy: per-harmonic mean/std of |dp|<15 mrad packets (v26 behaviour)
  // robust: running-median baseline + 1.4826·MAD noise (drift-tolerant)
  function computeBG(packets, harms, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var perHz = {}, f0 = harms[0];
    if (opts.mode === 'legacy') {
      harms.forEach(function (f) {
        var dps = packets.map(function (pk) { var v = pk.freqs[f]; return v ? v[0] * 1000 : NaN; });
        var bgV = dps.filter(function (v) { return !isNaN(v) && Math.abs(v) < 15; });
        if (bgV.length < 3) bgV = dps.filter(function (v) { return !isNaN(v); });
        if (!bgV.length) { perHz[f] = { mean: 0, std: 1, base: null }; return; }
        var s = bgV.length > 1 ? std(bgV) : 1;
        perHz[f] = { mean: mean(bgV), std: s || 1, base: null };
      });
      var d1 = packets.map(function (pk) { var v = pk.freqs[f0]; return v ? v[0] * 1000 : NaN; });
      var mBg = packets.map(function (pk, i) { var v = pk.freqs[f0]; return v && !isNaN(d1[i]) && Math.abs(d1[i]) < 15 ? v[1] : NaN; }).filter(finite);
      return { mode: 'legacy', mean: perHz[f0].mean, std: perHz[f0].std, magMean: mBg.length ? mean(mBg) : 1, magBase: null, perHz: perHz };
    }
    harms.forEach(function (f) {
      var dps = packets.map(function (pk) { var v = pk.freqs[f]; return v ? v[0] * 1000 : NaN; });
      var base = runningMedian(dps, opts.detrendWin);
      var resid = dps.map(function (v, i) { return v - base[i]; });
      var s = 1.4826 * mad(resid, median(resid));
      if (!finite(s) || s <= 1e-6) s = std(resid) || 1;
      perHz[f] = { mean: median(dps), std: s, base: base };
    });
    var mags = packets.map(function (pk) { var v = pk.freqs[f0]; return v ? v[1] : NaN; });
    return { mode: 'robust', mean: perHz[f0].mean, std: perHz[f0].std, magMean: median(mags) || 1,
      magBase: runningMedian(mags, opts.detrendWin), perHz: perHz };
  }
  function bgAt(bg, f, i) {
    var p = bg.perHz[f]; if (!p) return bg.mean;
    return p.base && finite(p.base[i]) ? p.base[i] : p.mean;
  }
  function magRefAt(bg, i) { return bg.magBase && finite(bg.magBase[i]) ? bg.magBase[i] : bg.magMean; }

  // ── Track kinematics along the RAW GPS path ────────────────────────────────
  // cum[i]  : cumulative distance travelled (m) — the 1-D coordinate everything uses
  // sog[i]  : speed over ground from a centred ≥12 m window (m/s)
  // cog[i]  : course over ground over the same window (deg)
  // Positions are first smoothed with a centred moving average (±smoothK fixes):
  // summing raw 1 Hz GPS steps adds the jitter to the distance (≈25% too long at
  // 1 m/s with 0.5 m noise), which would bias every along-path measurement.
  function computeKinematics(packets, winM, smoothK) {
    winM = winM || 12; smoothK = smoothK === undefined ? 5 : smoothK;
    var n = packets.length, cum = new Array(n), t = new Array(n), last = null, acc = 0, i, j;
    var sm = new Array(n);
    for (i = 0; i < n; i++) {
      if (packets[i].lat === null) { sm[i] = null; continue; }
      var sl = 0, so = 0, c = 0;
      for (j = Math.max(0, i - smoothK); j <= Math.min(n - 1, i + smoothK); j++) {
        var q = packets[j]; if (q.lat === null) continue;
        if (Math.abs(q.lat - packets[i].lat) > 0.001) continue;   // ignore GPS spikes (>100 m)
        sl += q.lat; so += q.lon; c++;
      }
      sm[i] = { lat: sl / c, lon: so / c };
    }
    var steps = [];
    for (i = 1; i < n; i++) {
      var dt0 = packets[i].t - packets[i - 1].t, di = packets[i].idx - packets[i - 1].idx;
      if (finite(dt0) && dt0 > 0 && di > 0 && dt0 < 60) steps.push(dt0 / di);
    }
    var secPerIdx = median(steps); if (!finite(secPerIdx) || secPerIdx <= 0) secPerIdx = 1;
    var t0 = finite(packets[0] && packets[0].t) ? packets[0].t : 0, idx0 = packets[0] ? packets[0].idx : 0;
    for (i = 0; i < n; i++) {
      var pk = packets[i];
      t[i] = finite(pk.t) ? pk.t : t0 + (pk.idx - idx0) * secPerIdx;
      if (sm[i]) {
        if (last) { var d = haversine(last.lat, last.lon, sm[i].lat, sm[i].lon); if (d < 200) acc += d; }
        last = sm[i];
      }
      cum[i] = acc;
    }
    var out = new Array(n), half = winM / 2;
    for (i = 0; i < n; i++) {
      if (!sm[i]) { out[i] = { cum: cum[i], t: t[i], sog: null, cog: null, slat: null, slon: null }; continue; }
      var a = i, b = i;
      for (j = i; j >= 0; j--) { if (packets[j].lat !== null) a = j; if (cum[i] - cum[j] >= half) break; }
      for (j = i; j < n; j++) { if (packets[j].lat !== null) b = j; if (cum[j] - cum[i] >= half) break; }
      var dd = cum[b] - cum[a], dtt = t[b] - t[a];
      var sog = dtt > 0 && dd > 0 ? dd / dtt : null;
      var cog = dd >= 2 ? bearing(sm[a].lat, sm[a].lon, sm[b].lat, sm[b].lon) : null;
      out[i] = { cum: cum[i], t: t[i], sog: sog, cog: cog, slat: sm[i].lat, slon: sm[i].lon };
    }
    var lastS = null, lastC = null;
    for (i = 0; i < n; i++) { if (out[i].sog !== null) lastS = out[i].sog; else out[i].sog = lastS; if (out[i].cog !== null) lastC = out[i].cog; else out[i].cog = lastC; }
    for (i = n - 1; i >= 0; i--) { if (out[i].sog === null && i < n - 1) out[i].sog = out[i + 1].sog; if (out[i].cog === null && i < n - 1) out[i].cog = out[i + 1].cog; }
    return out;
  }
  // Position on the recorded boat path at cumulative distance `target`.
  // The towed sensor FOLLOWS the boat's path, so this is where the sensor was.
  function pointAtCum(packets, kin, target) {
    var lo = -1, hi = -1, i;
    for (i = 0; i < packets.length; i++) if (packets[i].lat !== null) { if (lo < 0) lo = i; hi = i; }
    if (lo < 0) return [null, null];
    if (target <= kin[lo].cum) {   // before the start of the recorded path: extend backwards
      var c0 = kin[lo].cog, back = kin[lo].cum - target;
      if (!finite(c0) || back <= 0) return [kin[lo].slat, kin[lo].slon];
      return offsetLL(kin[lo].slat, kin[lo].slon, -back * Math.sin(c0 * D2R), -back * Math.cos(c0 * D2R));
    }
    var a = lo, b = hi;
    while (b - a > 1) { var m = (a + b) >> 1; if (kin[m].cum <= target) a = m; else b = m; }
    while (a > lo && packets[a].lat === null) a--;
    while (b < hi && packets[b].lat === null) b++;
    var seg = kin[b].cum - kin[a].cum, f = seg > 0 ? (target - kin[a].cum) / seg : 0;
    f = Math.max(0, Math.min(1, f));
    return [kin[a].slat + f * (kin[b].slat - kin[a].slat), kin[a].slon + f * (kin[b].slon - kin[a].slon)];
  }
  // Linear layback model: offset behind the GPS antenna along the path = L + τ·v
  function laybackDist(v, L, tau) { return Math.max(0, (L || 0) + (tau || 0) * (finite(v) ? v : 0)); }

  // ── Detection: packets → crossings ─────────────────────────────────────────
  // 1. flag packets (fundamental z ≥ T, or robust: ≥N harmonics z ≥ T)
  // 2. split phase-wrap / magnitude-dropout packets out as Artifact crossings
  // 3. contiguous packets (index gap ≤ gapPkts) form sub-clusters
  // 4. consecutive sub-clusters within mergeGapM metres of path merge into ONE crossing
  function detectAnomalies(packets, harms, bg, opts, kin) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var legacy = opts.mode === 'legacy', f0 = harms[0], s0 = bg.perHz[f0] ? bg.perHz[f0].std : bg.std;
    var T = legacy ? 3 : opts.zThresh, normal = [], artifacts = [];
    for (var i = 0; i < packets.length; i++) {
      var pk = packets[i], v0 = pk.freqs[f0]; if (!v0) continue;
      var dev0 = wrapMrad(v0[0] * 1000 - bgAt(bg, f0, i)), z0 = Math.abs(dev0) / s0, zmax = z0, hits = 0;
      if (!legacy) for (var h = 1; h < harms.length; h++) {
        var v = pk.freqs[harms[h]]; if (!v) continue;
        var z = Math.abs(wrapMrad(v[0] * 1000 - bgAt(bg, harms[h], i))) / bg.perHz[harms[h]].std;
        if (z >= T) hits++; if (z > zmax) zmax = z;
      }
      var ref = magRefAt(bg, i), magPct = ref ? (v0[1] - ref) / ref * 100 : 0;
      var magHit = !legacy && opts.magDetectPct > 0 && magPct <= -opts.magDetectPct;
      if (!(z0 >= T || (!legacy && hits >= opts.minHarmHits) || magHit)) continue;
      var rec = { i: i, pk: pk, snr: zmax, snr0: z0, hits: hits };
      if (Math.abs(dev0) > opts.artifactDevMrad || magPct < opts.artifactMagPct) artifacts.push(rec); else normal.push(rec);
    }
    var gap = legacy ? 2 : opts.gapPkts;
    function sub(items) {
      var out = [], cur = [];
      items.forEach(function (a) { if (!cur.length || a.pk.idx - cur[cur.length - 1].pk.idx <= gap) cur.push(a); else { out.push(cur); cur = [a]; } });
      if (cur.length) out.push(cur); return out;
    }
    function merge(subs) {
      var out = [];
      subs.forEach(function (s) {
        if (out.length && kin) {
          var prev = out[out.length - 1], a = prev[prev.length - 1].i, b = s[0].i;
          if (packets[a].lat !== null && packets[b].lat !== null && Math.abs(kin[b].cum - kin[a].cum) <= opts.mergeGapM) {
            out[out.length - 1] = prev.concat(s); return;
          }
        }
        out.push(s);
      });
      return out;
    }
    var clusters = merge(sub(normal));
    if (opts.minPkts > 1 && !legacy) clusters = clusters.filter(function (c) { return c.length >= opts.minPkts; });
    var art = sub(artifacts); art.forEach(function (c) { c.isArtifact = true; });
    return clusters.concat(art).sort(function (a, b) { return a[0].pk.idx - b[0].pk.idx; });
  }

  // ── Crossing classifier: integrated over the whole crossing ────────────────
  function classifyRules(cluster, harms, bg, kin, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var rep = cluster[0], n = cluster.length, f0 = harms[0];
    cluster.forEach(function (a) { if (a.snr > rep.snr) rep = a; });
    var s0 = bg.perHz[f0] ? bg.perHz[f0].std : bg.std;
    var wSum = cluster.reduce(function (s, a) { return s + a.snr; }, 0) || 1, dpDev = {}, dp = {};
    harms.forEach(function (f) {
      var acc = 0;
      cluster.forEach(function (a) { var v = a.pk.freqs[f]; var b = bgAt(bg, f, a.i); acc += (v ? wrapMrad(v[0] * 1000 - b) : 0) * a.snr; });
      dpDev[f] = acc / wSum;
      dp[f] = dpDev[f] + bgAt(bg, f, rep.i);
    });
    var dp1dev = dpDev[f0];
    var mAcc = 0; cluster.forEach(function (a) { var v = a.pk.freqs[f0]; var b = bgAt(bg, f0, a.i); mAcc += v ? wrapMrad(v[0] * 1000 - b) : 0; });
    var snrInt = Math.abs(mAcc / n) / (s0 / Math.sqrt(n));
    var maxSNR = finite(rep.snr0) ? rep.snr0 : rep.snr, eff = Math.max(maxSNR, snrInt), maxSNRall = eff;
    harms.forEach(function (f) { var p = bg.perHz[f]; if (p) { var z = Math.abs(dpDev[f]) / p.std; if (z > maxSNRall) maxSNRall = z; } });
    maxSNRall = Math.max(maxSNRall, rep.snr);
    var mag0 = rep.pk.freqs[f0], ref = magRefAt(bg, rep.i), magPct = mag0 && ref ? (mag0[1] - ref) / ref * 100 : 0;
    // r7 §18 step 3: Mag% of the crossing = the strongest magnitude DECREASE among its packets (else the peak packet's value)
    var magMin = Infinity; cluster.forEach(function (a) { var v = a.pk.freqs[f0], r = magRefAt(bg, a.i); if (v && r) { var m = (v[1] - r) / r * 100; if (m < magMin) magMin = m; } });
    if (magMin < 0 && magMin < magPct) magPct = magMin;
    var posHigh = 0, negLow = 0, h;
    for (h = 2; h < harms.length; h++) if (dpDev[harms[h]] > 3) posHigh++;
    for (h = 0; h < 3; h++) if (dpDev[harms[h]] < -5) negLow++;
    var altPol = dpDev[harms[0]] * dpDev[harms[1]] < 0 && dpDev[harms[1]] * dpDev[harms[2]] < 0;
    var cls, conf, note = null, review = false;
    // r7 features (WaTech-MatChar-r7 §18 step 4): Δφ at fundamental, 3rd, 5th, 7th harmonic (4/12/20/28 Hz at 4 Hz)
    var d1 = dpDev[harms[0]], d3 = dpDev[harms[1]], d5 = dpDev[harms[2]], d7 = dpDev[harms[3]];
    var magPk = mag0 && ref ? (mag0[1] - ref) / ref * 100 : 0;
    if (opts.rules === 'r7') {
      // r7 §18 step 4 reads Δφ at the single most anomalous packet of the crossing, not the SNR-weighted integral
      var pkDev = function (f) { var v = rep.pk.freqs[f]; return v ? wrapMrad(v[0] * 1000 - bgAt(bg, f, rep.i)) : 0; };
      d1 = pkDev(harms[0]); d3 = pkDev(harms[1]); d5 = pkDev(harms[2]); d7 = pkDev(harms[3]);
      altPol = d1 * d3 < 0 && d3 * d5 < 0;
    }
    var maxAbs = 0, nAnom = 0;
    harms.forEach(function (f) { var v = Math.abs(dpDev[f]); if (v > maxAbs) maxAbs = v; var p = bg.perHz[f]; if (p && v / p.std >= 3) nAnom++; });
    var z1 = Math.abs(dpDev[harms[0]]) / s0, slope7 = (d7 - d1) / 3;
    var posGrow = d5 > 0 && d7 > 0 && slope7 > 0.5 && d7 >= d3;
    if (maxAbs > opts.reviewDevMrad) { review = true; note = '|Δφ| > ' + opts.reviewDevMrad + ' mrad: possible cable snag/contact (r7 §17), review manually'; }
    if (cluster.isArtifact || Math.abs(dp1dev) > opts.artifactDevMrad || magPct < opts.artifactMagPct) { cls = 'Artifact'; conf = 99; }
    else if (opts.rules === 'r7') {
      // WaTech-MatChar-r7 §17 decision table: magnitude first, then Δφ at the 5th harmonic for ilmenite.
      if (n === 1 && maxSNRall < 8) { cls = 'Weak/Inconclusive'; conf = Math.min(30, 10 + maxSNRall * 3); note = note || 'single packet below SNR 8'; }
      else if (maxSNRall < opts.minSNRmaterial && !(magPct <= -20)) { cls = 'Weak/Inconclusive'; conf = Math.min(35, 15 + eff * 3); note = note || 'crossing SNR below ' + opts.minSNRmaterial + ': no material call'; }
      else if (magPct <= -20 && z1 < 3 && nAnom <= 1) { cls = 'Resistive (non-IP)'; conf = 55; note = note || 'Mag <= -20% flat with no phase (r7 rule 7, e.g. mineral oil displacing saline)'; }
      else if (magPct < -2) {
        if (d5 > 5 && !altPol && magPk > -8) { cls = 'Ilmenite'; conf = Math.min(85, 60 + maxSNRall / 2); note = note || 'Mag% < -2, Δφ(5th) = +' + d5.toFixed(1) + ' mrad, no alternating polarity (r7 §12/§17)'; }
        else if (nAnom === 1 && maxSNRall > 2 && z1 < 3) { cls = 'Asphalt'; conf = 40; note = note || 'Mag% < -2 with a single-harmonic anomaly (r7 §17; asphalt vs steel not yet discriminated)'; }
        else { cls = 'Steel'; conf = Math.min(88, 60 + maxSNRall / 2); note = note || ('Mag% = ' + magPct.toFixed(1) + ' (r7: magnitude decrease is the primary steel indicator)' + (altPol ? ', alternating polarity' : (d1 < 0 && d3 < 0 && d5 < 0 && d7 < 0 ? ', uniform negative' : ''))); }
      }
      else if (Math.abs(magPct) < 2 && posGrow && maxSNRall > 2) { cls = 'Hydrocarbon IP'; conf = Math.min(70, 45 + maxSNRall); note = note || 'Mag ~ 0 with positive phase growing with harmonic (r7 rules 5/6, lab 250 mA+)'; }
      // r7 rule 6 (Mag > +7% flat, no phase = crude at <=125 mA) is lab-only: at 500 mA field magnitude routinely rises +8-12% (noise), so it is not applied.
      else if (snrInt >= 8 && n >= 4) { cls = 'Strong Anomaly'; conf = Math.min(85, 50 + snrInt * 2); }
      else { cls = 'Weak/Inconclusive'; conf = Math.min(35, 15 + eff * 3); }
      if (review) conf = Math.min(conf, 50);
    }
    // v32 phase-shape rules (Processing -> Classifier rules)
    else if (n === 1 && maxSNRall < 8) { cls = 'Weak/Inconclusive'; conf = Math.min(30, 10 + maxSNRall * 3); }
    else if (posHigh >= 3 && Math.abs(dp1dev) < 10 && maxSNRall > 10) { cls = 'Hydrocarbon IP'; conf = Math.min(95, 80 + maxSNRall / 5); }
    else if (posHigh >= 2 && Math.abs(dp1dev) < 12 && maxSNRall > 5) { cls = 'Hydrocarbon IP'; conf = Math.min(80, 60 + maxSNRall / 4); }
    else if (dp1dev < -8 && negLow >= 2 && !altPol && eff > 8) { cls = 'Metallic IP'; conf = Math.min(92, 75 + eff / 8); }
    else if (dp1dev < -5 && negLow >= 1 && eff > 5) { cls = 'Metallic IP'; conf = Math.min(75, 55 + eff / 6); }
    else if (dp1dev < -5 && posHigh >= 2) { cls = 'Mixed'; conf = Math.min(70, 55 + eff / 8); }
    else if (posHigh >= 2 && maxSNRall > 3) { cls = 'Hydrocarbon IP'; conf = Math.min(60, 40 + maxSNRall / 3); }
    else if (snrInt >= 8 && n >= 4) { cls = 'Strong Anomaly'; conf = Math.min(85, 50 + snrInt * 2); }
    else { cls = 'Weak/Inconclusive'; conf = Math.min(35, 15 + eff * 3); }
    // spectral slope of the deviation vs log10(f)
    var xs = harms.map(function (f) { return Math.log10(f); }), ys = harms.map(function (f) { return dpDev[f]; });
    var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
    xs.forEach(function (x, k) { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) * (x - mx); });
    // SNR-weighted position of the crossing: raw centroid + along-path coordinate
    var la = 0, lo = 0, cu = 0, w = 0;
    cluster.forEach(function (a) { if (a.pk.lat === null) return; la += a.pk.lat * a.snr; lo += a.pk.lon * a.snr; if (kin) cu += kin[a.i].cum * a.snr; w += a.snr; });
    var k = kin && kin[rep.i] ? kin[rep.i] : { cog: null, sog: null };
    return { cls: cls, confPct: Math.round(conf), dp: dp, dpDev: dpDev, magPct: magPct, maxSNR: maxSNR, maxSNRall: maxSNRall,
      snrInt: Math.round(snrInt * 10) / 10, phaseSlope: sxx ? sxy / sxx : 0, posHigh: posHigh, negLow: negLow, isArtifact: !!cluster.isArtifact,
      altPol: altPol, nAnom: nAnom, slope7: slope7, rulesNote: note, review: review, rulesVersion: opts.rules,
      pktStart: cluster[0].pk.idx, pktEnd: cluster[cluster.length - 1].pk.idx, pktPeak: rep.pk.idx, i: rep.i,
      ts: rep.pk.ts, t: rep.pk.t, nPkts: n, lat: w ? la / w : rep.pk.lat, lon: w ? lo / w : rep.pk.lon,
      cum: w && kin ? cu / w : (kin && kin[rep.i] ? kin[rep.i].cum : null), cog: k.cog, sog: k.sog };
  }

  // ── Lab signature matching (weighted spectral angle) ───────────────────────
  // Average several blank runs from one lab session into one blank (per-harmonic mean; pooled std).
  function avgBlank(list) {
    if (!list.length) return null; if (list.length === 1) return list[0];
    var fr = list[0].freqs, m_ = [], s_ = [];
    fr.forEach(function (f) {
      var m = [], v = [];
      list.forEach(function (b) { var k = b.freqs.indexOf(f); if (k >= 0 && finite(b.mean[k])) { m.push(b.mean[k]); v.push(Math.pow(b.std[k] || 0, 2)); } });
      m_.push(m.length ? mean(m) : NaN); s_.push(v.length ? Math.sqrt(mean(v)) : 0);
    });
    return { material: 'Seawater blank', xmt: list[0].xmt, freqs: fr, mean: m_, std: s_, project: list[0].project };
  }
  // v37: each target run is blank-subtracted with the baselines from ITS OWN lab session (same project + xmt);
  // falls back to the latest blank at that frequency. Returns the best-matching run per material.
  function labMatch(ev, harms, bg, sigs) {
    if (!sigs || !sigs.length) return [];
    var xmt = harms[0];
    var blanks = sigs.filter(function (s) { return s.material === 'Seawater blank' && s.xmt === xmt; });
    var lastBlank = blanks.length ? blanks[blanks.length - 1] : null, byProj = {}, projBlank = {}, out = [];
    blanks.forEach(function (b) { if (b.project) (byProj[b.project] = byProj[b.project] || []).push(b); });
    Object.keys(byProj).forEach(function (p) { projBlank[p] = avgBlank(byProj[p]); });
    sigs.forEach(function (s) {
      if (s.material === 'Seawater blank' || s.material === 'No anomaly' || s.xmt !== xmt) return;
      var blank = (s.project && projBlank[s.project]) || lastBlank;
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
        scale: a, chi2red: chi / Math.max(1, n - 1), nHarm: n, blankUsed: !!blank,
        sessionBlank: !!(s.project && projBlank[s.project]), project: s.project || null });
    });
    out.sort(function (p, q) { return q.cos - p.cos; });
    var seen = {}, best = [];
    out.forEach(function (m) { if (seen[m.material]) { seen[m.material].nRuns++; return; } m.nRuns = 1; seen[m.material] = m; best.push(m); });
    return best;
  }
  function fuseClass(ev, best, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var base = { cls: ev.cls, conf: ev.confPct, src: 'rules', conflict: false };
    if (!best || best.cos < opts.labCosMin || best.scale <= 0 || ev.cls === 'Artifact') return base;
    // Field-rule calls are not overridden by lab spectral shape (lab currents and geometry differ from the field):
    // gt1 never; r7 for its field-validated classes.
    if (opts.rules === 'gt1' || (opts.rules === 'r7' && ['Steel', 'Ilmenite', 'Asphalt', 'Resistive (non-IP)'].indexOf(ev.cls) >= 0))
      return { cls: ev.cls, conf: ev.confPct, src: 'rules (' + opts.rules + ')', conflict: family(best.material) !== family(ev.cls), labCls: best.material };
    var rf = family(ev.cls), lf = family(best.material);
    if (rf === lf) return { cls: best.material, conf: Math.round(Math.min(97, Math.max(ev.confPct, 50 + 45 * best.cos * Math.min(1, ev.maxSNRall / 10)))), src: 'rules+lab', conflict: false };
    if ((rf === 'weak' || rf === 'strong') && ev.maxSNRall >= opts.zThresh) return { cls: best.material, conf: Math.round(Math.min(rf === 'strong' ? 80 : 70, 40 + 30 * best.cos)), src: 'lab', conflict: false };
    return { cls: ev.cls, conf: Math.max(10, ev.confPct - 20), src: 'rules', conflict: true, labCls: best.material };
  }

  // ── GPS re-timing ─────────────────────────────────────────────────────────
  // The acquisition software attaches one queued GPS sentence to each data packet. The receiver
  // sends sentences faster than packets are made, so the queue grows and each packet carries an
  // ever older fix (minutes to hours by the end of a day). Each sentence still has its own UTC time,
  // so a day's fixes (pooled from every file of that day) can be put back on the right time:
  // a packet recorded at local time t gets the fix whose UTC time = t + offset.
  function localSecOf(ts) { var m = /(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(ts || '')); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; }
  function fixAt(fx, s, maxGapS) {
    var lo = 0, hi = fx.length - 1; if (!fx.length || s < fx[0][0] - 0.6 || s > fx[hi][0] + 0.6) return null;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (fx[m][0] <= s) lo = m; else hi = m; }
    var a = fx[lo], b = fx[hi];
    if (s <= a[0]) return Math.abs(a[0] - s) <= 0.6 ? [a[1], a[2]] : null;
    if (s >= b[0]) return Math.abs(b[0] - s) <= 0.6 ? [b[1], b[2]] : null;
    if (b[0] - a[0] > maxGapS) return null;
    var f = (s - a[0]) / (b[0] - a[0]); return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
  }
  // table: { offsetS, fixes: [[localSec, lat, lon], …] }. Packets with no fix within maxGapS lose their
  // position (lat/lon null) rather than keep a wrong one. Original positions stay in rawLat/rawLon.
  function retimePositions(packets, table, maxGapS) {
    maxGapS = maxGapS || 8; var n = 0, fx = (table && table.fixes) || [];
    packets.forEach(function (pk) {
      if (pk.type === 'lab') return;
      if (pk.rawLat === undefined) { pk.rawLat = pk.lat; pk.rawLon = pk.lon; }
      var sec = localSecOf(pk.ts), q = sec === null ? null : fixAt(fx, sec, maxGapS);
      if (q) { pk.lat = q[0]; pk.lon = q[1]; n++; } else { pk.lat = null; pk.lon = null; }
      pk.gpsFixed = !!q;
    });
    return packets.length ? n / packets.length : 0;
  }
  function restoreRawPositions(packets) { packets.forEach(function (pk) { if (pk.rawLat !== undefined) { pk.lat = pk.rawLat; pk.lon = pk.rawLon; pk.gpsFixed = undefined; } }); }
  // Build a day's fix table from parsed packet arrays (all files of that day)
  function buildFixTable(packetSets, offsetS) {
    offsetS = offsetS === undefined ? 7 * 3600 : offsetS;
    var fx = [];
    packetSets.forEach(function (pks) { pks.forEach(function (pk) {
      var g = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)/.exec(pk.gpsT || ''); if (!g) return;
      var la = pk.rawLat !== undefined ? pk.rawLat : pk.lat, lo = pk.rawLon !== undefined ? pk.rawLon : pk.lon; if (la === null || lo === null) return;
      var t = (+g[1]) * 3600 + (+g[2]) * 60 + (+g[3]) - offsetS; if (t < 0) t += 86400; fx.push([t, la, lo]);
    }); });
    fx.sort(function (a, b) { return a[0] - b[0]; });
    var u = []; fx.forEach(function (f) { if (!u.length || f[0] - u[u.length - 1][0] > 0.05) u.push(f); });
    return { offsetS: offsetS, fixes: u };
  }

  // ── Receiver channels ─────────────────────────────────────────────────────
  // A channel is active when its fundamental phase is stable; unconnected inputs read ±π noise.
  function activeChannels(packets) {
    if (!packets.length || !packets[0].chan) return [1];
    var f0 = getHarms(packets[0].xmt)[0], out = [];
    for (var c = 1; c <= 7; c++) {
      var d = [], m = [];
      for (var i = 0; i < packets.length; i++) { var v = packets[i].chan && packets[i].chan[f0]; if (v && finite(v.d[c - 1])) { d.push(v.d[c - 1]); m.push(v.m[c]); } }
      if (d.length < 5) continue;
      var med = median(d), sc = 1.4826 * mad(d, med), mm = median(m.filter(finite));
      if (Math.abs(med) < 0.6 && sc < 0.05 && mm > 0) out.push(c);
    }
    return out.length ? out : [1];
  }
  // Every odd harmonic of the transmit frequency present in the file (4, 12, 20 … at 4 Hz)
  function oddHarmonics(packets, xmt) {
    var s = {}; packets.slice(0, 5).forEach(function (pk) { Object.keys(pk.freqs).forEach(function (f) { s[f] = 1; }); });
    return Object.keys(s).map(Number).filter(function (f) { var k = f / xmt; return Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) % 2 === 1; }).sort(function (a, b) { return a - b; });
  }
  // Packets as seen by channel c (phase delta + magnitude, optionally ÷ ch0 magnitude)
  function channelPackets(packets, c, magRef) {
    if (c === 1 && magRef !== 'ch0') return packets;
    return packets.map(function (pk) {
      if (!pk.chan) return pk;
      var fr = {};
      Object.keys(pk.chan).forEach(function (f) { var v = pk.chan[f], mg = v.m[c]; if (magRef === 'ch0') mg = v.m[0] ? mg / v.m[0] : NaN; fr[f] = [v.d[c - 1], mg]; });
      return Object.assign({}, pk, { freqs: fr });
    });
  }
  // Deviation from background (mrad), robust z and Mag% at packet i, for every channel and odd harmonic
  function channelSpectra(per, chans, freqs, i) {
    var out = {};
    chans.forEach(function (c) {
      var P = per[c]; if (!P || !P.vp[i]) return;
      var pk = P.vp[i], dev = [], z = [], mag = [], zMax = 0, n = P.vp.length;
      freqs.forEach(function (f) {
        var v = pk.freqs[f], pz = P.bg.perHz[f];
        if (!v || !pz) { dev.push(null); z.push(null); mag.push(null); return; }
        var d = wrapMrad(v[0] * 1000 - bgAt(P.bg, f, i)), zz = Math.abs(d) / pz.std;
        dev.push(Math.round(d * 100) / 100); z.push(Math.round(zz * 10) / 10); if (zz > zMax) zMax = zz;
        var w = []; for (var j = Math.max(0, i - 30); j <= Math.min(n - 1, i + 30); j++) { var q = P.vp[j].freqs[f]; if (q && finite(q[1])) w.push(q[1]); }
        var ref = w.length ? median(w) : NaN; mag.push(ref && finite(v[1]) ? Math.round((v[1] - ref) / ref * 1000) / 10 : null);
      });
      out[c] = { dev: dev, z: z, mag: mag, zMax: Math.round(zMax * 10) / 10, magPct: mag[0] };
    });
    return out;
  }

  // Matched filter: 3-packet mean of the multi-harmonic robust chi. Targets span several packets; noise spikes do not.
  function chi6At(P, i, harms) {
    var s = 0, k = 0; harms.forEach(function (h) { var v = P.vp[i] && P.vp[i].freqs[h], p = P.bg.perHz[h]; if (!v || !p) return; var z = wrapMrad(v[0] * 1000 - bgAt(P.bg, h, i)) / p.std; s += z * z; k++; });
    return k ? Math.sqrt(s / k) : 0;
  }
  function matchedChi(P, cl, harms) {
    var n = P.vp.length, best = 0;
    cl.forEach(function (a) { var s = 0, k = 0; for (var d = -1; d <= 1; d++) { var j = a.i + d; if (j < 0 || j >= n) continue; s += chi6At(P, j, harms); k++; } var m = k ? s / k : 0; if (m > best) best = m; });
    return best;
  }
  // gt1: rules from the North Beach Apr 2026 ground truth (re-timed GPS, per-day layback).
  // Steel is the only material with a repeatable field response; asphalt (3B) was weak and inconsistent
  // and ilmenite (3D) was not distinguishable from background on any channel or harmonic, so neither is called.
  function groundTruthRules(ev, harms, opts) {
    if (ev.cls === 'Artifact' || ev.cls === 'Resistive (non-IP)') return;
    var d1 = ev.dpDev ? ev.dpDev[harms[0]] : 0;
    if (!(ev.mf >= opts.mfMin)) {
      ev.cls = 'Weak/Inconclusive'; ev.confPct = Math.min(ev.confPct, 35);
      ev.rulesNote = (ev.review ? ev.rulesNote + '; ' : '') + 'matched-filter strength ' + (ev.mf || 0).toFixed(1) + ' below ' + opts.mfMin + ' (target-free North Beach windows reach ~2–4)';
      return;
    }
    if (ev.cls === 'Hydrocarbon IP') { ev.rulesNote = 'growing positive phase, Mag ≈ 0 (lab-derived rule, not field-validated)'; ev.confPct = Math.min(ev.confPct, 50); return; }
    if (d1 < 0 || ev.magPct < -2) {
      ev.cls = 'Steel'; ev.confPct = Math.round(Math.min(90, 45 + 8 * ev.mf));
      ev.rulesNote = (ev.review ? ev.rulesNote + '; ' : '') + 'strong multi-packet response (' + ev.mf.toFixed(1) + ') with ' + (d1 < 0 ? 'negative fundamental phase' : '') + (d1 < 0 && ev.magPct < -2 ? ' and ' : '') + (ev.magPct < -2 ? 'magnitude drop ' + ev.magPct.toFixed(1) + '%' : '') + ' — matches North Beach steel';
    } else {
      ev.cls = 'Strong Anomaly'; ev.confPct = Math.round(Math.min(70, 35 + 6 * ev.mf));
      ev.rulesNote = 'strong response (' + ev.mf.toFixed(1) + ') but positive fundamental phase and no magnitude drop: not the North Beach steel pattern';
    }
    if (ev.review) ev.confPct = Math.min(ev.confPct, 50);
  }

  // ── Per-file analysis (raw frame; layback applied separately) ──────────────
  function analyzeField(packets, opts, labSigs) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var xmt = packets[0].xmt, harms = getHarms(xmt), kin = computeKinematics(packets);
    var chans = activeChannels(packets), odd = oddHarmonics(packets, xmt);
    if (odd.length < harms.length) odd = harms.slice();
    var nH = opts.nHarm === 'all' ? odd.length : Math.max(harms.length, +opts.nHarm || harms.length);
    var detH = odd.slice(0, nH); harms.forEach(function (f) { if (detH.indexOf(f) < 0) detH.push(f); });
    var per = {};
    [1].concat(chans).forEach(function (c) { if (!per[c]) { var vp = channelPackets(packets, c, opts.magRef); per[c] = { vp: vp, bg: computeBG(vp, odd, opts) }; } });
    var bg = per[1].bg;
    var clusters = detectAnomalies(per[1].vp, detH, bg, opts, kin);
    clusters.forEach(function (cl) { cl.detCh = 1; });
    if (opts.detChannels === 'all') chans.forEach(function (c) {
      if (c === 1) return;
      detectAnomalies(per[c].vp, detH, per[c].bg, opts, kin).forEach(function (cl) {
        var a = cl[0].pk.idx, b = cl[cl.length - 1].pk.idx, g = opts.gapPkts + 2;
        if (!clusters.some(function (k) { return k[0].pk.idx - g <= b && a <= k[k.length - 1].pk.idx + g; })) { cl.detCh = c; clusters.push(cl); }
      });
    });
    clusters.sort(function (x, y) { return x[0].pk.idx - y[0].pk.idx; });
    var T = opts.mode === 'legacy' ? 3 : opts.zThresh;
    var events = clusters.map(function (cl) {
      var c = cl.detCh || 1, ev = classifyRules(cl, harms, per[c].bg, kin, opts.rules === 'gt1' ? Object.assign({}, opts, { rules: 'r7' }) : opts);
      ev.detCh = c; ev.magRef = opts.magRef; ev.mf = Math.round(matchedChi(per[c], cl, harms) * 100) / 100;
      if (opts.rules === 'gt1') { groundTruthRules(ev, harms, opts); ev.rulesVersion = 'gt1'; }
      ev.spec = channelSpectra(per, chans, odd, ev.i);
      ev.seenOn = chans.filter(function (ch) { return ev.spec[ch] && ev.spec[ch].zMax >= T; });
      ev.labMatches = c === 1 ? labMatch(ev, harms, bg, labSigs) : [];
      ev.labBest = ev.labMatches[0] || null;
      var fu = fuseClass(ev, ev.labBest, opts);
      ev.fusedCls = fu.cls; ev.fusedConf = fu.conf; ev.fusedSrc = fu.src; ev.labConflict = fu.conflict;
      return ev;
    });
    var lenM = kin.length ? kin[kin.length - 1].cum : 0, chBg = {};
    chans.forEach(function (c) { chBg[c] = per[c].bg; });
    return { xmt: xmt, harms: harms, bg: bg, kin: kin, clusters: clusters, events: events, trackLenM: lenM,
      chans: chans, freqsAll: odd, detH: detH, chBg: chBg };
  }
  // Apply the linear layback model: every event and packet is moved BACK along the
  // recorded path by L + τ·v. L=τ=0 returns raw positions.
  function correctFile(fa, packets, L, tau) {
    // Positions are only trusted inside a continuous stretch of GPS fixes: a detection (or track point) whose
    // sensor position would have to be taken from across a gap in the fixes gets no corrected position,
    // instead of being pinned to the edge of the last valid fix.
    var kin = fa.kin, on = (L || 0) !== 0 || (tau || 0) !== 0, n = packets.length, seg = new Array(n), sid = 0;
    for (var i = 0; i < n; i++) { if (packets[i].lat === null) { seg[i] = -1; sid++; } else seg[i] = sid; }
    function backAlong(i, d) {
      if (i < 0 || i >= n || seg[i] < 0) return null;
      if (!on) return [packets[i].lat, packets[i].lon];
      var target = kin[i].cum - d, j = i;
      while (j > 0 && seg[j - 1] === seg[i] && kin[j].cum > target) j--;
      if (kin[j].cum > target) return null;                 // ran out of continuous fixes before reaching the sensor
      if (j === i) return [kin[i].slat, kin[i].slon];
      var a = j, b = j + 1, span = kin[b].cum - kin[a].cum, f = span > 0 ? (target - kin[a].cum) / span : 0;
      f = Math.max(0, Math.min(1, f));
      return [kin[a].slat + f * (kin[b].slat - kin[a].slat), kin[a].slon + f * (kin[b].slon - kin[a].slon)];
    }
    var events = fa.events.map(function (ev) {
      var i = ev.i, p = null;
      if (finite(i) && seg[i] >= 0) {
        var d = laybackDist(ev.sog, L, tau) + (finite(ev.cum) ? kin[i].cum - ev.cum : 0);
        p = backAlong(i, d);
      }
      return Object.assign({}, ev, { latC: p ? p[0] : null, lonC: p ? p[1] : null });
    });
    var track = [];
    packets.forEach(function (pk, i) {
      if (pk.lat === null) return;
      var p = backAlong(i, laybackDist(kin[i].sog, L, tau));
      if (p) track.push({ lat: p[0], lon: p[1], cog: kin[i].cog, i: i });
    });
    return Object.assign({}, fa, { events: events, track: track });
  }

  // ── Saved per-line results ("summaries") ─────────────────────────────────
  // A summary is everything the map, corroboration, coverage and layback need from one line:
  // the GPS path (lat, lon, t, idx per packet), the background noise per harmonic and the
  // detected events. It is ~1% of the raw file, so a whole survey opens in seconds.
  // Lab matching is redone on open, so new lab references apply without reprocessing.
  var SUMMARY_VER = 4;
  function rnd(x, d) { return finite(x) ? +x.toFixed(d) : x; }
  function summarizeField(fa, packets) {
    var pk = packets.map(function (p) { return [p.lat === null ? null : rnd(p.lat, 7), p.lon === null ? null : rnd(p.lon, 7), rnd(p.t, 2), p.idx]; });
    var perHz = {};
    Object.keys(fa.bg.perHz).forEach(function (f) { var p = fa.bg.perHz[f]; perHz[f] = { mean: p.mean, std: p.std }; });
    var events = fa.events.map(function (ev) {
      var o = {};
      Object.keys(ev).forEach(function (k) { if (k === 'labMatches' || k === 'labBest' || k === 'labConflict' || k.indexOf('fused') === 0) return; o[k] = ev[k]; });
      return o;
    });
    var p0 = packets[0], pN = packets[packets.length - 1];
    return { sv: SUMMARY_VER, run: p0.run, type: p0.type, xmt: fa.xmt, harms: fa.harms, ts0: p0.ts, tsN: pN.ts,
      bg: { mode: fa.bg.mode, mean: fa.bg.mean, std: fa.bg.std, magMean: fa.bg.magMean, perHz: perHz },
      nClusters: fa.clusters.length, trackLenM: fa.trackLenM, pk: pk, events: events, chans: fa.chans || [1], freqsAll: fa.freqsAll || fa.harms,
      gpsCover: packets.length ? packets.filter(function (q) { return q.lat !== null; }).length / packets.length : 0, gpsFixed: packets.some(function (q) { return q.gpsFixed !== undefined; }) };
  }
  // Rebuild a light file from a summary: packets carry position/time only (no harmonics).
  function expandSummary(s) {
    var n = s.pk.length;
    var packets = s.pk.map(function (a, i) {
      return { lat: a[0], lon: a[1], t: a[2], idx: a[3], ts: i === 0 ? s.ts0 : i === n - 1 ? s.tsN : '', run: s.run, xmt: s.xmt, type: s.type || 'field', freqs: {} };
    });
    return { packets: packets, kin: computeKinematics(packets) };
  }
  // Analysis object for a light file, with lab matching / fusion redone against the current references.
  function liteAnalysis(s, kin, opts, labSigs) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var events = s.events.map(function (e) {
      var ev = Object.assign({}, e);
      ev.labMatches = (ev.detCh || 1) === 1 ? labMatch(ev, s.harms, s.bg, labSigs) : [];
      ev.labBest = ev.labMatches[0] || null;
      var fu = fuseClass(ev, ev.labBest, opts);
      ev.fusedCls = fu.cls; ev.fusedConf = fu.conf; ev.fusedSrc = fu.src; ev.labConflict = fu.conflict;
      return ev;
    });
    return { xmt: s.xmt, harms: s.harms, bg: s.bg, kin: kin, clusters: [], nClusters: s.nClusters, events: events, trackLenM: s.trackLenM, lite: true, chans: s.chans || [1], freqsAll: s.freqsAll || s.harms, gpsCover: s.gpsFixed ? s.gpsCover : null };
  }

  // ── Known targets: waypoints → physical target sites ───────────────────────
  // Waypoints within linkM of each other are one target. A target is a segment between
  // its two most distant members, so a long/linear target is judged along its length.
  // Deploy-day code from names like 1A-3 / 2C-6 (leading digit + letter); 0 = unknown.
  function waypointDayCode(name) { var m = /^([1-9])[A-Za-z]/.exec(String(name || '').trim()); return m ? parseInt(m[1], 10) : 0; }
  function buildTargets(waypoints, linkM) {
    linkM = linkM || 10;
    var n = waypoints.length; if (!n) return [];
    var parent = waypoints.map(function (_, i) { return i; });
    function fnd(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    // Waypoints tied to a logged site (siteId) form exactly that site (so 1B/1C and the two 3C
    // halves stay separate); waypoints without a site are linked by distance as before.
    var siteFirst = {};
    waypoints.forEach(function (w, i) { if (!w.siteId) return; if (siteFirst[w.siteId] === undefined) siteFirst[w.siteId] = i; else { var ra = fnd(siteFirst[w.siteId]), rb = fnd(i); if (ra !== rb) parent[rb] = ra; } });
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      if (waypoints[i].siteId || waypoints[j].siteId) continue;
      if (haversine(waypoints[i].lat, waypoints[i].lon, waypoints[j].lat, waypoints[j].lon) <= linkM) { var ra = fnd(i), rb = fnd(j); if (ra !== rb) parent[rb] = ra; }
    }
    var groups = {};
    waypoints.forEach(function (w, i) { (groups[fnd(i)] = groups[fnd(i)] || []).push(w); });
    var targets = Object.keys(groups).map(function (key, ti) {
      var g = groups[key], A = g[0], B = g[0], best = 0;
      for (var a = 0; a < g.length; a++) for (var b = a + 1; b < g.length; b++) { var d = haversine(g[a].lat, g[a].lon, g[b].lat, g[b].lon); if (d > best) { best = d; A = g[a]; B = g[b]; } }
      var names = g.map(function (w) { return String(w.name); });
      var alpha = names.filter(function (s) { return /^[0-9]+[A-Za-z]/.test(s); });
      var label = alpha.length ? alpha[0].match(/^[0-9]+[A-Za-z]/)[0] : (g.length > 1 ? names[0] + '…' + names[g.length - 1] : names[0]);
      if (g[0].siteName && g.every(function (w) { return w.siteName === g[0].siteName; })) label = g[0].siteName;
      var dates = {};
      g.forEach(function (w) { if (w.date) dates[w.date] = (dates[w.date] || 0) + 1; });
      var date = Object.keys(dates).sort(function (x, y) { return dates[y] - dates[x]; })[0] || null;
      var votes = {}, mats = {};
      names.forEach(function (nm) { var d = waypointDayCode(nm); if (d) votes[d] = (votes[d] || 0) + 1; });
      g.forEach(function (w) { if (w.material) mats[w.material] = (mats[w.material] || 0) + 1; });
      var day = +Object.keys(votes).sort(function (x, y) { return votes[y] - votes[x]; })[0] || 0;
      var mat = Object.keys(mats).sort(function (x, y) { return mats[y] - mats[x]; })[0] || null;
      return { id: 'T' + ti, label: label, members: names, n: g.length, day: day, date: date, material: mat,
        lat: mean(g.map(function (w) { return w.lat; })), lon: mean(g.map(function (w) { return w.lon; })),
        aLat: A.lat, aLon: A.lon, bLat: B.lat, bLon: B.lon, lenM: best };
    });
    return targets.sort(function (a, b) { return b.lat - a.lat; }).map(function (t, i) { t.id = 'T' + i; return t; });
  }
  // A seeded target only counts for lines recorded on its logged drop date. Targets with no
  // date (bathymetry features) count for every line. Without a date, fall back to the day code
  // in the name vs the line's day number within its own survey.
  function dayMismatch(T, F) {
    if (T.date && F.date) return T.date !== F.date;
    if (T.date) return false;
    return !!(T.day && F.dayRank && T.day !== F.dayRank);
  }
  function distToTarget(lat, lon, T) {
    var p = enu(T.aLat, T.aLon, lat, lon), b = enu(T.aLat, T.aLon, T.bLat, T.bLon), L2 = b[0] * b[0] + b[1] * b[1];
    var t = L2 ? Math.max(0, Math.min(1, (p[0] * b[0] + p[1] * b[1]) / L2)) : 0;
    return Math.hypot(p[0] - t * b[0], p[1] - t * b[1]);
  }

  // ── Survey days & automatic grouping ───────────────────────────────────────
  function dateOf(pk) {
    var m = String(pk && pk.ts || '').match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    if (pk && finite(pk.t) && pk.t > 1e8) return new Date(pk.t * 1000).toISOString().slice(0, 10);
    return null;
  }
  function samplePts(packets, k) {
    var v = packets.filter(function (p) { return p.lat !== null; }); if (!v.length) return [];
    var step = Math.max(1, Math.floor(v.length / (k || 12))), out = [];
    for (var i = 0; i < v.length; i += step) out.push([v[i].lat, v[i].lon]);
    out.push([v[v.length - 1].lat, v[v.length - 1].lon]); return out;
  }
  function nearTargets(pts, targets, maxM) {
    if (!targets || !targets.length) return true;
    return pts.some(function (p) { return targets.some(function (T) { return haversine(p[0], p[1], T.lat, T.lon) <= (maxM || 2000); }); });
  }
  // Named survey areas (centre, radius). A line belongs to the nearest one within its radius.
  var PLACES = [
    { name: 'North Beach', lat: 47.708, lon: -122.387, r: 3000 },
    { name: 'Eagle Harbor', lat: 47.615, lon: -122.497, r: 4000 },
    { name: 'Point Wells', lat: 47.775, lon: -122.399, r: 3000 }
  ];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function placeOf(pts) {
    if (!pts.length) return null;
    var la = pts.map(function (p) { return p[0]; }).sort(function (a, b) { return a - b; })[pts.length >> 1];
    var lo = pts.map(function (p) { return p[1]; }).sort(function (a, b) { return a - b; })[pts.length >> 1];
    var best = null, bd = Infinity;
    PLACES.forEach(function (P) { var d = haversine(la, lo, P.lat, P.lon); if (d <= P.r && d < bd) { bd = d; best = P.name; } });
    return best || (la.toFixed(3) + ', ' + lo.toFixed(3));
  }
  function dayDiff(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  // fileInfos: [{fi, run, packets}] (field files). Returns per-file {date, place, survey, dayRank}.
  // A survey = consecutive dates (gaps ≤ 7 days) at the same place; dayRank = day number within it.
  // knownDays (optional): [{date, lat, lon}] for every line in the library, so day numbers don't
  // depend on which lines happen to be open.
  function surveyDays(fileInfos, targets, knownDays) {
    // Each survey date gets ONE place: the named area most of that date's lines are in
    // (transit legs and lines outside the area stay with their day).
    var info = {}, votes = {};
    function vote(date, place) { if (!date || !place) return; var v = votes[date] = votes[date] || {}; v[place] = (v[place] || 0) + 1; }
    (knownDays || []).forEach(function (k) { if (finite(k.lat) && finite(k.lon)) vote(k.date, placeOf([[k.lat, k.lon]])); });
    fileInfos.forEach(function (f) {
      var pts = samplePts(f.packets), d = dateOf(f.packets[0]), place = placeOf(pts);
      info[f.fi] = { date: d, linePlace: place, pts: pts, near: nearTargets(pts, targets, 2000) };
      if (!knownDays || !knownDays.length) vote(d, place);
    });
    var datePlace = {};
    Object.keys(votes).forEach(function (d) {
      var v = votes[d], named = Object.keys(v).filter(function (p) { return PLACES.some(function (P) { return P.name === p; }); });
      var pool = named.length ? named : Object.keys(v);
      datePlace[d] = pool.sort(function (a, b) { return v[b] - v[a]; })[0];
    });
    var byPlace = {};
    Object.keys(datePlace).forEach(function (d) { (byPlace[datePlace[d]] = byPlace[datePlace[d]] || []).push(d); });
    var dayOf = {};
    Object.keys(byPlace).forEach(function (place) {
      var start = null, n = 0, prev = null;
      byPlace[place].sort().forEach(function (d) {
        if (!prev || dayDiff(prev, d) > 7) { start = d; n = 0; }
        n++; prev = d;
        var m = start.split('-');
        dayOf[d] = { rank: n, survey: place + ' ' + MONTHS[+m[1] - 1] + ' ' + m[0] };
      });
    });
    Object.keys(info).forEach(function (fi) {
      var r = info[fi], k = r.date ? dayOf[r.date] : null;
      r.place = r.date ? (datePlace[r.date] || r.linePlace) : r.linePlace;
      r.dayRank = k ? k.rank : 0; r.survey = k ? k.survey : null;
    });
    return { byFile: info };
  }
  // One group per survey day and place, named e.g. "North Beach Apr 2026 · Day 1".
  function autoGroups(fileInfos, days) {
    var byKey = {};
    fileInfos.forEach(function (f) {
      var d = days.byFile[f.fi] || {}, k = d.date ? d.date + '|' + (d.place || '') : 'undated';
      (byKey[k] = byKey[k] || []).push(f.fi);
    });
    return Object.keys(byKey).sort().map(function (key) {
      var ids = byKey[key].sort(function (x, y) { return x - y; }), d = days.byFile[ids[0]] || {};
      if (key === 'undated') return { id: 'day-undated', name: 'Undated', auto: true, date: null, dayRank: 0, fileIds: ids };
      return { id: 'day-' + key.replace(/[^A-Za-z0-9-]+/g, '_'), name: (d.survey ? d.survey + ' · Day ' + d.dayRank : d.place || 'Lines') + ' (' + d.date + ')',
        auto: true, date: d.date, place: d.place, dayRank: d.dayRank, fileIds: ids };
    });
  }

  // ── Layback calibration anchors (all in the RAW path frame) ────────────────
  // For each line that passes a known target: the boat's closest approach defines
  // cum_close; the strongest crossing after it defines cum_det. The measured offset
  //   along = cum_det − cum_close
  // is exactly the distance the sensor trails the GPS (plus timing), independent of
  // heading noise and of whatever correction is currently applied.
  function collectAnchors(files, targets, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var out = [];
    files.forEach(function (F) {
      var pk = F.packets, kin = F.fa.kin;
      targets.forEach(function (T, ti) {
        if (opts.dayFilter && dayMismatch(T, F)) return;
        var dmin = Infinity, imin = -1;
        for (var i = 0; i < pk.length; i++) { if (kin[i].slat === null) continue; var d = distToTarget(kin[i].slat, kin[i].slon, T); if (d < dmin) { dmin = d; imin = i; } }
        if (imin < 0 || dmin > opts.anchorPassM) return;
        var c0 = kin[imin].cum, best = null;
        F.fa.events.forEach(function (ev, ei) {
          if (ev.isArtifact || ev.cls === 'Artifact' || !finite(ev.cum) || ev.maxSNRall < opts.minSNRcal) return;
          var lead = ev.cum - c0;
          if (lead < opts.minLeadM || lead > opts.maxLeadM) return;
          if (!best || ev.maxSNRall > best.ev.maxSNRall) best = { ev: ev, ei: ei, lead: lead };
        });
        if (!best) return;
        out.push({ key: F.key + '|' + T.label, fi: F.fi, run: F.run, ei: best.ei, wi: ti, wp: T.label, target: T.label,
          along: best.lead, cross: dmin, sog: best.ev.sog, cog: best.ev.cog, snr: best.ev.maxSNRall,
          cls: best.ev.fusedCls || best.ev.cls, dayRank: F.dayRank });
      });
    });
    return out;
  }
  function axialMean(degs) {
    var s = 0, c = 0; degs.forEach(function (d) { s += Math.sin(2 * d * D2R); c += Math.cos(2 * d * D2R); });
    return ((Math.atan2(s, c) / D2R / 2) + 360) % 180;
  }
  // Linear least squares: along = L + τ·v (+ b·dir when reciprocal lines exist),
  // with 3-robust-σ outlier rejection. Returns L, τ, b with standard errors.
  function fitLayback(matches) {
    var res = { n: matches.length, ok: false };
    if (matches.length < 2) { res.msg = 'Need at least 2 line/target crossings with a detection.'; return res; }
    var axis = axialMean(matches.map(function (m) { return finite(m.cog) ? m.cog : 0; }));
    matches.forEach(function (m) { m.dir = Math.cos(((finite(m.cog) ? m.cog : 0) - axis) * D2R) >= 0 ? 1 : -1; m.inlier = true; });
    var nF = matches.filter(function (m) { return m.dir > 0; }).length, nR = matches.length - nF;
    var sogs = matches.map(function (m) { return m.sog; }).filter(finite);
    var useV = sogs.length === matches.length && matches.length >= 5 && std(sogs) >= 0.15;
    // Reciprocal-bias terms: one per target that was crossed in BOTH directions (its own
    // waypoint position error along the line cancels), else a single shared term.
    var recipT = {};
    matches.forEach(function (m) { var r = recipT[m.wi] = recipT[m.wi] || { f: 0, r: 0 }; if (m.dir > 0) r.f++; else r.r++; });
    var biasIds = Object.keys(recipT).filter(function (k) { return recipT[k].f && recipT[k].r; });
    var fit = null, cols, p, mode;
    for (var iter = 0; iter < 3; iter++) {
      var use = matches.filter(function (m) { return m.inlier; });
      mode = biasIds.length >= 1 && use.length >= 2 + biasIds.length + (useV ? 1 : 0) + 1 ? 'target' : (nF && nR && use.length >= 3 ? 'shared' : 'none');
      var nb = mode === 'target' ? biasIds.length : mode === 'shared' ? 1 : 0;
      p = 1 + (useV ? 1 : 0) + nb;
      if (use.length < p + 1 && useV) { useV = false; p--; }
      cols = ['L'].concat(useV ? ['tau'] : []);
      if (mode === 'target') biasIds.forEach(function (k) { cols.push('b' + k); }); else if (mode === 'shared') cols.push('bias');
      var row = function (m) {
        var r = [1]; if (useV) r.push(m.sog);
        if (mode === 'target') biasIds.forEach(function (k) { r.push(String(m.wi) === k ? m.dir : 0); });
        else if (mode === 'shared') r.push(m.dir);
        return r;
      };
      fit = lstsq(use.map(row), use.map(function (m) { return m.along; })); if (!fit) break;
      var rr = matches.map(function (m) { return m.along - row(m).reduce(function (s, v, k) { return s + v * fit.beta[k]; }, 0); });
      var sc = 1.4826 * mad(rr, median(rr));
      matches.forEach(function (m, k) { m.resid = rr[k]; m.inlier = !(sc > 0.5 && Math.abs(rr[k]) > 3 * sc && use.length > p + 2); });
    }
    if (!fit) { res.msg = 'Fit failed (degenerate geometry).'; return res; }
    var inl = matches.filter(function (m) { return m.inlier; }), dof = Math.max(1, inl.length - cols.length);
    var sse = inl.reduce(function (s, m) { return s + m.resid * m.resid; }, 0), s2 = sse / dof;
    var get = function (nm) { var k = cols.indexOf(nm); return k < 0 ? null : { v: fit.beta[k], se: Math.sqrt(Math.max(0, fit.inv[k][k] * s2)) }; };
    var biases = cols.filter(function (c) { return c === 'bias' || c[0] === 'b'; }).map(function (c) { var g = get(c); return { id: c === 'bias' ? 'all' : c.slice(1), v: g.v, se: g.se }; });
    var byWp = {};
    inl.forEach(function (m) { (byWp[m.wi] = byWp[m.wi] || { f: [], r: [] })[m.dir > 0 ? 'f' : 'r'].push(m.along); });
    var pairs = Object.keys(byWp).filter(function (k) { return byWp[k].f.length && byWp[k].r.length; }).map(function (k) { return (mean(byWp[k].f) + mean(byWp[k].r)) / 2; });
    var L = get('L'), tau = get('tau'), medSog = median(inl.map(function (m) { return m.sog; }));
    return { ok: true, n: matches.length, nInliers: inl.length, nFwd: nF, nRev: nR, axisDeg: axis,
      L: L.v, seL: L.se, tau: tau ? tau.v : 0, seTau: tau ? tau.se : null, usedSpeed: !!tau, usedDir: biases.length > 0,
      biasMode: mode, biases: biases, bias: biases.length ? mean(biases.map(function (b) { return b.v; })) : null,
      rms: Math.sqrt(sse / Math.max(1, inl.length)), medSog: medSog,
      effOffset: L.v + (tau ? tau.v * (finite(medSog) ? medSog : 0) : 0),
      Lpairs: pairs.length ? median(pairs) : null, nPairs: pairs.length,
      crossMean: mean(inl.map(function (m) { return m.cross; })), crossStd: std(inl.map(function (m) { return m.cross; })),
      alongMedianRaw: median(matches.map(function (m) { return m.along; })), matches: matches };
  }

  // ── Coverage: did each line pass each known target, and detect it? ─────────
  // Uses CORRECTED positions. PASS = sensor track within detRadiusM of the target;
  // HIT = a (non-artifact) crossing within detRadiusM; FAIL = passed, nothing detected;
  // UNATTRIB = a crossing not near any target.
  function evaluateCoverage(files, targets, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    var rows = [], R = opts.detRadiusM;
    files.forEach(function (F) {
      var evs = F.events.filter(function (e) { return !e.isArtifact && e.cls !== 'Artifact' && e.latC !== null && e.latC !== undefined; });
      var used = {};
      targets.forEach(function (T) {
        if (opts.dayFilter && dayMismatch(T, F)) return;
        var dmin = Infinity;
        F.track.forEach(function (p) { var d = distToTarget(p.lat, p.lon, T); if (d < dmin) dmin = d; });
        if (dmin > R) return;
        // HIT = a non-weak crossing within R; WEAK = only weak/no-anomaly crossings there (the detector also fires on noise)
        var hit = null, hd = Infinity, weakHit = false;
        evs.forEach(function (e) { var d = distToTarget(e.latC, e.lonC, T); if (d > R) return; var fm = family(e.finalCls || e.fusedCls || e.cls);
          if (fm === 'weak' || fm === 'none') { weakHit = true; return; }
          if (!hit || e.maxSNRall > hit.maxSNRall) { hit = e; hd = d; } });
        if (hit) used[F.events.indexOf(hit)] = 1;
        rows.push({ fi: F.fi, run: F.run, dayRank: F.dayRank, target: T.label, targetId: T.id, material: T.material, closest: dmin,
          status: hit ? 'HIT' : weakHit ? 'WEAK' : 'FAIL', cls: hit ? (hit.finalCls || hit.fusedCls || hit.cls) : '', evDist: hit ? hd : null, snr: hit ? hit.maxSNRall : null,
          ei: hit ? F.events.indexOf(hit) : null, magPct: hit ? hit.magPct : null, evTs: hit ? hit.ts : null, evCum: hit ? hit.cum : null });
      });
      evs.forEach(function (e) {
        if (used[F.events.indexOf(e)]) return;
        var nt = null, nd = Infinity;
        targets.forEach(function (T) { var d = distToTarget(e.latC, e.lonC, T); if (d < nd) { nd = d; nt = T; } });
        if (nt && nd <= R) return;   // near a target on a filtered day: not a false alarm
        rows.push({ fi: F.fi, run: F.run, dayRank: F.dayRank, target: nt ? nt.label : '—', targetId: nt ? nt.id : null, closest: null,
          status: 'UNATTRIB', cls: e.finalCls || e.fusedCls || e.cls, evDist: nd, snr: e.maxSNRall });
      });
    });
    var perT = targets.map(function (T) {
      var r = rows.filter(function (x) { return x.targetId === T.id && x.status !== 'UNATTRIB'; });
      var h = r.filter(function (x) { return x.status === 'HIT'; }), cls = {}, famOk = 0, famN = 0;
      h.forEach(function (x) { cls[x.cls] = (cls[x.cls] || 0) + 1; if (T.material && T.material !== 'Seawater blank' && T.material !== 'No anomaly') { famN++; if (family(x.cls) === family(T.material)) famOk++; } });
      return { id: T.id, label: T.label, material: T.material, day: T.day, date: T.date || null, passes: r.length, hits: h.length, pd: r.length ? h.length / r.length : null,
        classes: cls, famOk: famOk, famN: famN, meanErrM: h.length ? mean(h.map(function (x) { return x.evDist; })) : null };
    });
    var P = perT.reduce(function (s, t) { return s + t.passes; }, 0), H = perT.reduce(function (s, t) { return s + t.hits; }, 0);
    var fOk = perT.reduce(function (s, t) { return s + t.famOk; }, 0), fN = perT.reduce(function (s, t) { return s + t.famN; }, 0);
    var ua = rows.filter(function (x) { return x.status === 'UNATTRIB'; }), uaReal = ua.filter(function (x) { var f = family(x.cls); return f !== 'weak' && f !== 'artifact'; });
    var km = files.reduce(function (s, F) { return s + (F.trackLenM || 0); }, 0) / 1000;
    var errs = perT.map(function (t) { return t.meanErrM; }).filter(finite);
    return { rows: rows, perTarget: perT, passes: P, hits: H, pd: P ? H / P : null, pdCI: wilson(H, P),
      unattributed: ua.length, falseAlarms: uaReal.length, trackKm: km, faPerKm: km > 0 ? uaReal.length / km : null,
      famAcc: fN ? fOk / fN : null, famN: fN, meanPosErrM: errs.length ? mean(errs) : null };
  }

  // ── Corroboration of detections across runs (known AND unknown targets) ────
  // points: [{lat,lon,cls,conf,fi,run,cog,snr,ei}] (corrected positions)
  function buildSites(points, fileTracks, targets, opts) {
    opts = Object.assign({}, DEFAULT_PROC, opts || {});
    // Centroid clustering, strongest detections first: a detection joins a site only if it lies within
    // mergeRadiusM of the site's (SNR-weighted) centre, so sites cannot chain across a whole area.
    // Weak/no-anomaly detections may join an existing site but never start one.
    var order = points.map(function (_, i) { return i; }).sort(function (a, b) { return (points[b].snr || 0) - (points[a].snr || 0); });
    var cs = [], groups = {};
    order.forEach(function (i) {
      var p = points[i], fm = family(p.cls), weak = fm === 'weak' || fm === 'none', best = -1, bd = Infinity;
      for (var k = 0; k < cs.length; k++) {
        if (Math.abs(cs[k].lat - p.lat) > 0.001) continue;
        var d = haversine(cs[k].lat, cs[k].lon, p.lat, p.lon); if (d <= opts.mergeRadiusM && d < bd) { bd = d; best = k; }
      }
      if (best < 0) { if (weak) return; best = cs.length; cs.push({ lat: p.lat, lon: p.lon, w: 0 }); groups[best] = []; }
      var c = cs[best], w = Math.max(1, p.snr || 1);
      c.lat = (c.lat * c.w + p.lat * w) / (c.w + w); c.lon = (c.lon * c.w + p.lon * w) / (c.w + w); c.w += w;
      groups[best].push(p);
    });
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
      var passR = Math.max(opts.mergeRadiusM, opts.passRadiusM), passed = {};
      (fileTracks || []).forEach(function (ft) {
        for (var q = 0; q < ft.track.length; q++) {
          var tp = ft.track[q]; if (Math.abs(tp.lat - la) > 0.0005) continue;
          if (haversine(la, lo, tp.lat, tp.lon) <= passR) { passed[ft.fi] = ft.run; break; }
        }
      });
      Object.keys(runs).forEach(function (fi) { passed[fi] = runs[fi]; });
      var nRuns = Object.keys(runs).length, nPass = Object.keys(passed).length;
      var nt = null, nd = Infinity;
      (targets || []).forEach(function (T) { var d = distToTarget(la, lo, T); if (d < nd) { nd = d; nt = T; } });
      var weakSite = topFam === 'weak' || topFam === 'artifact' || topFam === 'none';
      var famConsensus = fam[topFam] / g.length;
      var tier = nRuns < 2 ? 'Single run' : weakSite ? 'Weak repeat' :
        nRuns >= 3 && famConsensus >= 0.67 && recip ? 'Confirmed' : famConsensus >= 0.5 ? 'Corroborated' : 'Conflicting';
      return { lat: la, lon: lo, members: g, nDet: g.length, nRuns: nRuns, nPass: nPass, runs: runs,
        repeatability: nPass ? nRuns / nPass : 0, cls: top, consensus: cls[top] / g.length, famConsensus: famConsensus,
        reciprocal: recip, scatterM: scatter, meanSNR: mean(g.map(function (p) { return p.snr; })),
        maxConf: Math.max.apply(null, g.map(function (p) { return p.conf || 0; })),
        nearestWp: nt ? nt.label : null, nearestWpM: nt ? nd : null, knownTarget: !!(nt && nd <= opts.detRadiusM), tier: tier };
    });
    var order = { 'Confirmed': 0, 'Corroborated': 1, 'Conflicting': 2, 'Weak repeat': 3, 'Single run': 4 };
    return sites.sort(function (a, b) { return order[a.tier] - order[b.tier] || b.nRuns - a.nRuns || b.meanSNR - a.meanSNR; });
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
    computeLabStats: computeLabStats, labSignatureFromGroup: labSignatureFromGroup, wrapMrad: wrapMrad,
    computeBG: computeBG, bgAt: bgAt, detectAnomalies: detectAnomalies, computeKinematics: computeKinematics,
    pointAtCum: pointAtCum, laybackDist: laybackDist, classifyRules: classifyRules, labMatch: labMatch, fuseClass: fuseClass,
    tiersOf: tiersOf, labelOfTiers: labelOfTiers, tierFamilyOf: tierFamilyOf, knownTargetFor: knownTargetFor,
    TIER_DETECTION: TIER_DETECTION, TIER_FAMILIES: TIER_FAMILIES, FAMILY_MATERIALS: FAMILY_MATERIALS, FAMILY_GENERIC: FAMILY_GENERIC,
    analyzeField: analyzeField, correctFile: correctFile, retimePositions: retimePositions, restoreRawPositions: restoreRawPositions, buildFixTable: buildFixTable, localSecOf: localSecOf, activeChannels: activeChannels, oddHarmonics: oddHarmonics, channelPackets: channelPackets,
    SUMMARY_VER: SUMMARY_VER, summarizeField: summarizeField, expandSummary: expandSummary, liteAnalysis: liteAnalysis,
    waypointDayCode: waypointDayCode, buildTargets: buildTargets, distToTarget: distToTarget, dayMismatch: dayMismatch, placeOf: placeOf, PLACES: PLACES,
    dateOf: dateOf, surveyDays: surveyDays, autoGroups: autoGroups,
    collectAnchors: collectAnchors, fitLayback: fitLayback, axialMean: axialMean,
    evaluateCoverage: evaluateCoverage, buildSites: buildSites, wilson: wilson,
    confusion: confusion, looKnn: looKnn, reliability: reliability
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.IPA = API;
})(typeof window !== 'undefined' ? window : globalThis);
