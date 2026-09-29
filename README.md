# IPA MIP Classifier Portal

Browser app for processing marine IP (IPA) streamer data, classifying anomalies, calibrating layback, and tracking classifier accuracy. Hosted on GitHub Pages, with Supabase for sign-in (GitHub OAuth) and the shared database.

## Files
| File | Purpose |
|---|---|
| `index.html` | The whole app in one self-contained file (UI + inlined analysis engine). Works on GitHub Pages or opened directly from a download. |
| `ipa-core.js` | Standalone copy of the analysis engine for Node testing. **When changing the engine, update the inlined copy in `index.html` too.** |
| `supabase_schema.sql` | Database + private file bucket setup. Re-run in Supabase → SQL Editor whenever it changes (safe to repeat). |

## Workflow
0. **Data Library**: every `_p.txt`, lab and waypoint file you load is uploaded once to a private Supabase Storage bucket (signed-in team only) so the whole team can browse and load it. Nothing is stored in this public repo.
1. **Lab Stats**: load lab `_p.txt` runs and tag each one with its material. Add a *Seawater blank* for each transmit frequency. These become shared reference signatures.
2. **Waypoints**: load a CSV (`name,lat,lon,material`; decimal degrees, DDMM.mmmm or `47 37.123 N` are all accepted) or a GPX file.
3. **Analysis**: load field runs. Events are detected against a running-median background (robust σ = 1.4826·MAD). An event is flagged when the fundamental exceeds the threshold, or when at least N harmonics do. Each event is classified by the rule tree, matched against lab signatures (weighted spectral angle), and optionally by Claude.
4. **Layback**: strong detections near waypoints are fitted to `along = L + τ·v + b·dir`, using heading and speed from the GPS track. Apply the fitted L and τ to correct positions.
5. **Metrics**:
   - Multi-run corroboration tiers
   - Pd and false alarms against the waypoints
   - Classifier accuracy against confirmed labels: confusion matrix, κ, F1, and confidence calibration

Set Processing → *Legacy v26* to reproduce the previous detection behaviour for comparison.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for hosting on `ipa.coastalsensing.com`, the release checklist, keeping Supabase awake, and the training-data policy.
