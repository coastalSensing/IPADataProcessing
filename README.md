# IPA MIP Classifier Portal

Browser app for processing marine IP (IPA) streamer data, classifying anomalies, calibrating layback, and tracking classifier accuracy. Hosted on GitHub Pages, with Supabase for sign-in (GitHub OAuth) and the shared database.

## Files
| File | Purpose |
|---|---|
| `index.html` | React UI (Analysis, Map, Lab Stats, Layback, Metrics tabs) |
| `ipa-core.js` | Pure analysis engine (parsing, background, detection, lab matching, layback fit, corroboration, metrics). Also loads in Node for testing. |
| `supabase_schema.sql` | One-time migration: run in Supabase → SQL Editor |

## Workflow
1. **Lab Stats**: load lab `_p.txt` runs and tag each one with its material. Add a *Seawater blank* for each transmit frequency. These become shared reference signatures.
2. **Waypoints**: load a CSV (`name,lat,lon,material`; decimal degrees, DDMM.mmmm or `47 37.123 N` are all accepted) or a GPX file.
3. **Analysis**: load field runs. Events are detected against a running-median background (robust σ = 1.4826·MAD). An event is flagged when the fundamental exceeds the threshold, or when at least N harmonics do. Each event is classified by the rule tree, matched against lab signatures (weighted spectral angle), and optionally by Claude.
4. **Layback**: strong detections near waypoints are fitted to `along = L + τ·v + b·dir`, using heading and speed from the GPS track. Apply the fitted L and τ to correct positions.
5. **Metrics**:
   - Multi-run corroboration tiers
   - Pd and false alarms against the waypoints
   - Classifier accuracy against confirmed labels: confusion matrix, κ, F1, and confidence calibration

Set Processing → *Legacy v26* to reproduce the previous detection behaviour for comparison.
