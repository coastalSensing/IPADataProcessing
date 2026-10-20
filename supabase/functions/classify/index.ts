// IPA MIP Classifier — server-side Claude classification with continual learning.
//
// Every call:
//   1. checks the caller is signed in AND on the team (entered the team password),
//   2. pulls the most similar confirmed events from the SHARED database (balanced per material),
//      so every confirmation from the lab or field makes the next classification better,
//   3. asks Claude for a structured classification (JSON-schema output → always valid JSON),
//   4. logs the prediction to ai_predictions; the app links it to the confirmation that follows.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   required
//   CLAUDE_MODEL        optional default model (fallback below)
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically (fallbacks below).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Public (publishable) key is safe to embed; the env vars are preferred when present.
const SUPA_URL = Deno.env.get("SUPABASE_URL") || "https://cregneohqyqnllcylaof.supabase.co";
const SUPA_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
  "sb_publishable_8VsxLgCQQ5yWnEK1g37s6Q_6mLFr-FB";
const DEFAULT_MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const SYSTEM = `You classify anomalies in marine induced-polarization (MIP) towed-streamer IPA data for a survey team.
Data: phase difference (Δφ, mrad) between each receiver channel and ch0, at the transmit fundamental and its odd harmonics (4 Hz → 4/12/20/28/36/44 Hz …). "dev" = deviation from a running-median background; z = |dev| / robust noise sigma (1.4826*MAD). Mag% = change of the fundamental magnitude vs background (normally the channel magnitude divided by the ch0 magnitude, which removes transmitter-current drift).
Receiver channels: the EVENT block is the detection channel (usually ch1). The CHANNELS block gives the same packet on every active channel (normally ch1, ch2, ch3; ch3 behaves like the combined ch1+ch2 dipole; ch2 is about twice as noisy as ch1). A response seen on two or three channels is more credible than one seen on a single channel; a moderate anomaly on ch2 alone is often noise.
Noise: field noise is heavy-tailed. In North Beach background (no target) one-minute windows the largest single-packet z on ch1 is typically 3–6, so z below ~6 on one packet is weak evidence on its own. Real steel crossings in the same data reach z 15–130.

Ground truth (North Beach, Apr 2026; re-analysed Oct 2026 after GPS positions were re-timed to each fix's own UTC time and layback was calibrated on steel crossings at 22–31 m):
- Steel pipes (1A–1C, 2A–2C, 3A, 3C, 3E): a strong multi-packet response on 54 of 71 passes. At the strongest packet, the median ch1 deviation at 4/12/20/28/36/44 Hz was −9.5, −7.1, −12.2, −4.4, −4.8, −2.4 mrad; the fundamental phase was negative on 71% of passes; magnitude (channel ÷ ch0) fell below −2% on 60% (median −3.6%). Phase shape still varies with geometry, so do not rule out steel from shape alone. ch1 and ch3 respond alike; ch2 is noisier.
- Asphalt (3B): a strong response on only 3 of 7 passes, not separable from steel by any channel, harmonic or magnitude feature. Do not call Asphalt from field data.
- Ilmenite (3D): a strong response on 3 of 10 passes, with no consistent signature on any channel or harmonic. Treat ilmenite as not field-detectable with this setup; do not call Ilmenite.
- The older r7 reference (WaTech-MatChar-r7) built its ilmenite and asphalt signatures from the neighbouring steel targets because its GPS positions were stale; ignore r7's ilmenite (positive 20 Hz) and asphalt rules. Its steel statistics overstate the magnitude drop (r7: mean −10.2%, 89% below −2%).
- "mf" is the matched-filter strength: the 3-packet mean of the 6-harmonic robust chi. Target-free North Beach windows reach about 2–4; the app's rules need mf ≥ 3 for a material call.
- The RULE ENGINE line comes from the app's ground-truth rules (gt1): Steel = strong response with negative fundamental phase or a magnitude drop; Strong Anomaly = strong but not that pattern.
- |Δφ| > 100 mrad at any harmonic: possible cable snag / physical contact; say so in "caution" and keep confidence low.
Lab (not yet field-validated; lab currents 50–1250 mA may not transfer to 500 mA field):
- Hydrocarbons (Class 3 Gas Oil, ITB Rebel, Alaska crude at ≥250 mA, Group 5): positive phase growing with harmonic, Mag ≈ 0. At low current (≤125 mA) crude shows a flat +7 to +31% magnitude with no phase.
- Mineral oil / high-resistivity non-IP: large NEGATIVE flat magnitude (~−43%), no phase.
- Gold, silver ore, copper: no IP response (bulk resistivity only); do not label a strong phase anomaly as these.
- Galvanized steel / ilmenite in lab: negative phase growing with harmonic; polarity can reverse at high current.

How to use the team's confirmed examples:
- They are ground truth from this team's lab and field work, retrieved as the nearest neighbours of this event in feature space (smaller dist = more similar), balanced across materials.
- When several close neighbours agree, weight them heavily; when they conflict with the reference rules, say so in "caution".
- If there are few or no examples for a material, rely on the reference rules and lower your confidence.
Only use the allowed labels. Report calibrated confidence: a 70% label should be right about 70% of the time.`;

function num(v: unknown, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : "?";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY. Add it under Edge Functions → Secrets." }, 500);

  // Supabase client acting as the caller, so row-level security applies to everything below.
  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(SUPA_URL, SUPA_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userRes } = await sb.auth.getUser();
  if (!userRes?.user) return json({ error: "Not signed in" }, 401);
  const { data: isTeam, error: teamErr } = await sb.rpc("am_i_team");
  if (teamErr) return json({ error: "Team check failed: " + teamErr.message }, 500);
  if (!isTeam) return json({ error: "Enter the team password first." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const ev = body.event || {};
  const harms: number[] = Array.isArray(body.harms) ? body.harms : [];
  const labels: string[] = Array.isArray(body.labels) && body.labels.length ? body.labels : ["No anomaly"];
  const xmt = Number(body.xmt_hz) || null;
  const model = typeof body.model === "string" && /^claude-[a-z0-9.\-]+$/.test(body.model) ? body.model : DEFAULT_MODEL;
  const f = ev.features || {};

  // ── Continual learning: nearest confirmed examples from everyone's work ──
  const nnArgs = {
    p_dp1: f.dp1 ?? 0, p_dp3: f.dp3 ?? 0, p_dplast: f.dp_last ?? 0, p_mag: f.magPct ?? 0, p_slope: f.slope ?? 0,
    p_k_per_class: 4, p_max: 30,
  };
  let { data: examples, error: nnErr } = await sb.rpc("nearest_confirmations", { p_xmt: xmt, ...nnArgs });
  let sameFreq = true;
  if (!nnErr && (!examples || examples.length < 3)) {
    // Too few at this transmit frequency: widen to all frequencies (flagged in the prompt).
    const r = await sb.rpc("nearest_confirmations", { p_xmt: null, ...nnArgs });
    if (!r.error && r.data && r.data.length > (examples?.length || 0)) { examples = r.data; sameFreq = false; }
  }
  if (nnErr) return json({ error: "Example lookup failed: " + nnErr.message + " (run supabase_schema.sql)" }, 500);
  const { data: counts } = await sb.rpc("training_class_counts", { p_xmt: null });

  const h = harms.length ? harms : Object.keys(ev.harmonics || {}).map(Number);
  const evLines = h.map((hz) => {
    const p = (ev.harmonics || {})[hz] || {};
    return `  ${hz}Hz: raw=${num(p.raw)} dev=${num(p.dev)} z=${num(p.z, 1)}`;
  }).join("\n");
  const labLines = (ev.labMatches || []).slice(0, 3).map((m: any) =>
    `- ${m.material}: cos=${num(m.cos, 3)} (angle ${num(m.angleDeg, 1)}°), scale=${num(m.scale)}, chi2red=${num(m.chi2red)}`
  ).join("\n");
  const exLines = (examples || []).map((t: any) =>
    `- ${t.material} [dist ${num(t.dist)}${sameFreq ? "" : `, ${t.xmt_hz}Hz xmt`}]: devFund=${num(t.dp_fund_mrad)}, devMid=${num(t.dp_mid_mrad)}, devHigh=${num(t.dp_high_mrad)}, mag%=${num(t.mag_pct, 1)}, slope=${num(t.phase_slope, 1)}, SNR=${num(t.max_snr, 1)}`
  ).join("\n");
  const countLine = (counts || []).map((c: any) => `${c.material} ${c.n}`).join(", ");
  const chLines = Array.isArray(ev.channels) ? ev.channels.map((c: any) =>
    `  ch${c.ch}: Mag%=${num(c.magPct, 1)} maxZ=${num(c.zMax, 1)} dev by harmonic=[${(Array.isArray(c.dev) ? c.dev : []).map((d: any) => d === null || d === undefined ? "—" : num(d, 1)).join(", ")}]`
  ).join("\n") : "";

  const userMsg =
`Transmit fundamental ${xmt ?? "?"}Hz${body.run ? `, run ${body.run}` : ""}.
EVENT:
${evLines}
  mag%=${num(ev.magPct)} nPkts=${ev.nPkts ?? "?"} fundSNR=${num(ev.fundSNR, 1)} maxSNR=${num(ev.maxSNR, 1)} phaseSlope=${num(ev.phaseSlope)} mrad/decade
  summary features: devFund=${num(f.dp1)} devMid=${num(f.dp3)} devHigh=${num(f.dp_last)}
  matched-filter strength mf=${num(ev.mf, 2)}; detected on ch${ev.detCh ?? 1}; magnitude reference: ${ev.magRef === "raw" ? "raw channel magnitude" : "channel ÷ ch0"}
${chLines ? "CHANNELS (same packet, every active channel; dev in mrad for the first harmonics):\n" + chLines : "CHANNELS: not provided (older app version)."}
RULE ENGINE: ${ev.rulesCls ?? "?"} (${ev.rulesConf ?? "?"}%)   FUSED (rules+lab): ${ev.fusedCls ?? "?"}\nRULE NOTE: ${ev.rulesNote ?? "none"}${ev.review ? " [REVIEW: |Δφ| > 100 mrad, possible cable snag]" : ""}  alternating polarity: ${ev.altPol ? "yes" : "no"}
${labLines ? "LAB REFERENCE SPECTRAL-ANGLE MATCHES (blank-subtracted, amplitude-invariant):\n" + labLines : "No lab reference signatures for this frequency."}

TEAM CONFIRMATIONS IN DATABASE: ${countLine || "none yet"}
${exLines ? `NEAREST CONFIRMED EXAMPLES${sameFreq ? "" : " (few at this frequency, so other frequencies included — compare cautiously)"}:\n${exLines}` : "No confirmed examples yet — rely on physics and lab references."}

Allowed labels: ${labels.join(", ")}.
Classify this event. Reply only with the JSON object.`;

  // Structured output (JSON schema). Sonnet 5.5+ rejects forced tool_choice, so the
  // response format is enforced with output_config.format instead.
  const schema = {
    type: "object",
    properties: {
      classification: { type: "string", enum: labels },
      confidence_pct: { type: "integer", description: "0 to 99" },
      confidence_label: { type: "string", enum: ["High", "Medium", "Low"] },
      key_indicators: { type: "string", description: "One sentence." },
      reasoning: { type: "string", description: "2-3 sentences, cite the examples or lab matches used." },
      caution: { type: ["string", "null"] },
    },
    required: ["classification", "confidence_pct", "confidence_label", "key_indicators", "reasoning", "caution"],
    additionalProperties: false,
  };

  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  const latency = Date.now() - t0;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: `Claude API ${r.status}: ${d?.error?.message || "error"}` }, 502);
  if (d.stop_reason === "max_tokens") return json({ error: "Claude ran out of tokens before finishing; try again." }, 502);
  if (d.stop_reason === "refusal") return json({ error: "Claude declined to classify this event." }, 502);
  const text = (d.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  let out: any;
  try { out = JSON.parse(text); } catch { return json({ error: "Claude returned unreadable output" }, 502); }
  // Enum casing can drift; map back to the exact allowed label.
  const exact = labels.find((l) => l.toLowerCase() === String(out.classification || "").toLowerCase());
  if (!exact) return json({ error: `Claude returned an unknown label: ${out.classification}` }, 502);
  out.classification = exact;
  out.confidence_pct = Math.max(0, Math.min(99, Math.round(Number(out.confidence_pct) || 0)));

  const { data: ins, error: insErr } = await sb.from("ai_predictions").insert({
    model: d.model || model,
    run_name: body.run ?? null,
    event_ts: ev.ts ?? null,
    xmt_hz: xmt,
    features: { ...f, harmonics: ev.harmonics, magPct: ev.magPct, nPkts: ev.nPkts, maxSNR: ev.maxSNR },
    rules_class: ev.rulesCls ?? null,
    fused_class: ev.fusedCls ?? null,
    lab_class: ev.labMatches?.[0]?.material ?? null,
    classification: out.classification,
    confidence_pct: out.confidence_pct,
    response: out,
    example_ids: (examples || []).map((e: any) => e.id),
    n_examples: (examples || []).length,
    input_tokens: d.usage?.input_tokens ?? null,
    output_tokens: d.usage?.output_tokens ?? null,
    latency_ms: latency,
    app_version: body.app_version ?? null,
  }).select("id").single();

  return json({
    ...out,
    prediction_id: ins?.id ?? null,
    n_examples: (examples || []).length,
    same_freq_examples: sameFreq,
    model: d.model || model,
    log_error: insErr?.message ?? null,
  });
});
