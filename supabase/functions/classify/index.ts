// IPA MIP Classifier — server-side Claude classification with continual learning.
//
// Every call:
//   1. checks the caller is signed in AND on the team (entered the team password),
//   2. pulls the most similar confirmed events from the SHARED database (balanced per material),
//      so every confirmation from the lab or field makes the next classification better,
//   3. asks Claude for a structured classification (forced tool call → always valid JSON),
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
Data: ch1-0 phase difference in mrad at the transmit fundamental and its odd harmonics. "dev" values are deviations from a running-median background; z = |dev| / robust noise sigma (1.4826*MAD).

Physics guide:
- Hydrocarbon / organic IP: growing positive deviation toward higher harmonics with near-zero fundamental deviation (Olhoeft 1985 organic reactions; Wynn marine IP oil work).
- Metallic / electronic polarisation (steel, ilmenite): strong negative low-harmonic deviation, often with a magnitude decrease (Pelton 1978 / Wong 1979 Cole-Cole response).
- Artifact: |fundamental dev| > 150 mrad, magnitude drop > 30%, or single-packet spikes.
- Prefer lab-reference evidence when cos > 0.9 and SNR > 5.

How to use the team's confirmed examples:
- They are ground truth from this team's lab and field work, retrieved as the nearest neighbours of this event in feature space (smaller dist = more similar), balanced across materials.
- When several close neighbours agree, weight them heavily; they encode this rig's real behaviour. When they conflict with the physics guide, say so in "caution".
- If there are few or no examples for a material, rely on physics and lab references and lower your confidence.
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

  const userMsg =
`Transmit fundamental ${xmt ?? "?"}Hz${body.run ? `, run ${body.run}` : ""}.
EVENT:
${evLines}
  mag%=${num(ev.magPct)} nPkts=${ev.nPkts ?? "?"} fundSNR=${num(ev.fundSNR, 1)} maxSNR=${num(ev.maxSNR, 1)} phaseSlope=${num(ev.phaseSlope)} mrad/decade
  summary features: devFund=${num(f.dp1)} devMid=${num(f.dp3)} devHigh=${num(f.dp_last)}
RULE ENGINE: ${ev.rulesCls ?? "?"} (${ev.rulesConf ?? "?"}%)   FUSED (rules+lab): ${ev.fusedCls ?? "?"}
${labLines ? "LAB REFERENCE SPECTRAL-ANGLE MATCHES (blank-subtracted, amplitude-invariant):\n" + labLines : "No lab reference signatures for this frequency."}

TEAM CONFIRMATIONS IN DATABASE: ${countLine || "none yet"}
${exLines ? `NEAREST CONFIRMED EXAMPLES${sameFreq ? "" : " (few at this frequency, so other frequencies included — compare cautiously)"}:\n${exLines}` : "No confirmed examples yet — rely on physics and lab references."}

Allowed labels: ${labels.join(", ")}.
Classify this event with the classify_event tool.`;

  const tool = {
    name: "classify_event",
    description: "Return the classification for this IPA event.",
    input_schema: {
      type: "object",
      properties: {
        classification: { type: "string", enum: labels },
        confidence_pct: { type: "integer", minimum: 0, maximum: 99 },
        confidence_label: { type: "string", enum: ["High", "Medium", "Low"] },
        key_indicators: { type: "string", description: "One sentence." },
        reasoning: { type: "string", description: "2-3 sentences, cite the examples or lab matches used." },
        caution: { type: ["string", "null"] },
      },
      required: ["classification", "confidence_pct", "confidence_label", "key_indicators", "reasoning", "caution"],
    },
  };

  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [tool],
      tool_choice: { type: "tool", name: "classify_event" },
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  const latency = Date.now() - t0;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: `Claude API ${r.status}: ${d?.error?.message || "error"}` }, 502);
  const out = (d.content || []).find((c: any) => c.type === "tool_use")?.input;
  if (!out) return json({ error: "Claude returned no classification" }, 502);

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
