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
2. **Waypoints → targets**: load a CSV (`name,lat,lon,material`), GPX, KML or KMZ. Waypoints within 10 m become one *target* (a segment). Names like `2C-6` carry a deploy-day code, so that target is only scored against lines from survey day 2.
3. **Analysis**: load field lines. They are **auto-grouped by survey date** (the date in the packet timestamps, which is how lines are captured). To regroup, drag a line onto another group, use the ▾ menu on a line, or tick several lines and use *Move to…*. Use *+ Group* for custom groups and ✎ to rename. Moves are remembered per file, and *Reset to day groups* undoes them all. Events are detected against a running-median background (robust σ = 1.4826·MAD). A packet is flagged when the fundamental exceeds the threshold, or when at least N harmonics do. Flagged packets are merged into one *crossing* when they are within 25 m along the path, with phase-wrap/dropout packets split out as artifacts. Each crossing is classified on SNR-weighted integrated values. Each event is classified by the rule tree, matched against lab signatures (weighted spectral angle), and optionally by Claude.
4. **Layback (linear, path-following)**: for every line passing a target, the offset along the smoothed GPS path from the boat's closest approach to the strongest crossing is fitted by least squares: `along = L + τ·v + b_target·dir`. Anchors can be excluded individually. Corrections move each crossing back along the recorded path by L + τ·v.
5. **Metrics**:
   - Multi-run corroboration tiers
   - Known-target coverage: PASS / HIT / FAIL per line × target, Pd, and unattributed crossings (false alarms)
   - Classifier accuracy against confirmed labels: confusion matrix, κ, F1, and confidence calibration

Set Processing → *Legacy* to use fundamental-only 3σ detection against a fixed background. Loaded files are cached in this browser (IndexedDB) and restored after a refresh. `oldversion` is kept in the repo for reference only.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for hosting on `ipa.coastalsensing.com`, the release checklist, keeping Supabase awake, and the training-data policy.
