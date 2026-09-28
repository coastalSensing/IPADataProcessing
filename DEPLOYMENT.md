# Hosting & release guide

**Architecture:** the app is static files (`index.html`, `ipa-core.js`) served by **GitHub Pages**. Sign-in and all shared data live in **Supabase**:

- training confirmations
- lab reference signatures
- waypoints
- layback calibrations

Every user loads the same code from GitHub and reads and writes the same Supabase database. Nothing is stored per-computer except UI preferences.

`coastalsensing.com` is hosted on **Squarespace**. Squarespace can't serve a separate app from a folder path, so the setup has two parts:

1. The app lives on a subdomain, **`ipa.coastalsensing.com`**, served by GitHub Pages with free HTTPS.
2. **`coastalsensing.com/ipa`** is a Squarespace URL redirect to that subdomain, so the short link on the main site works too.

> Don't embed the app in a Squarespace page with an iframe. GitHub sign-in refuses to load inside an iframe, so login would break.

---

## One-time setup

### 1. Verify the domain with GitHub (recommended; prevents subdomain takeover)
1. GitHub → **coastalSensing** organization → **Settings → Pages → Add a domain** → enter `coastalsensing.com`.
2. GitHub shows a TXT record (`_github-pages-challenge-coastalSensing` → a code). Add it in Squarespace:
   **Settings → Domains → coastalsensing.com → DNS → Custom records → Add record**:
   - Type `TXT`
   - Host `_github-pages-challenge-coastalSensing`
   - Data = the code GitHub gave you
3. Back in GitHub, click **Verify**. DNS changes can take minutes to hours.

### 2. Point the subdomain at GitHub Pages
In Squarespace, go to **Settings → Domains → coastalsensing.com → DNS → Custom records → Add record** and add:

| Type | Host | Data |
|---|---|---|
| CNAME | `ipa` | `coastalsensing.github.io` |

### 3. Tell GitHub Pages about the custom domain
1. Repo **IPADataProcessing → Settings → Pages → Custom domain**: enter `ipa.coastalsensing.com` → **Save**.
2. Wait for the green "DNS check successful", then tick **Enforce HTTPS**. The certificate can take up to about an hour.
3. The old `coastalsensing.github.io/IPADataProcessing/` address redirects automatically.

The deploy uses GitHub Actions, so no `CNAME` file is needed in the repo; the setting above is enough.

### 4. Tell Supabase the new address (otherwise sign-in bounces to the wrong URL)
In Supabase Dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://ipa.coastalsensing.com`
- **Redirect URLs**, add:
  - `https://ipa.coastalsensing.com/**`
  - `https://coastalsensing.github.io/IPADataProcessing/**` (keep this during the switch-over)

The GitHub OAuth App's callback URL stays `https://ztrtrymaqrrquxpcjcsp.supabase.co/auth/v1/callback`. Don't change it.

### 5. Add the short link on the main site
Squarespace → **Settings → Developer Tools → URL Mappings**, add the line:
```
/ipa -> https://ipa.coastalsensing.com 302
```
Optionally, add a navigation link called "IPA Portal" that points to `/ipa`.

### 6. Lock sign-in to the team (important)
By default, Supabase's GitHub sign-in accepts **any** GitHub account. Every signed-in user can read and write the shared tables. To restrict it:

1. Have each team member sign in once.
2. Supabase → **Authentication → Sign In / Providers → turn OFF "Allow new users to sign up"**.
3. Add new people later from **Authentication → Users → Invite user**, or turn sign-ups on briefly.

### 7. Database schema
Run `supabase_schema.sql` in Supabase → **SQL Editor** → Run. It's cumulative and safe to re-run; it only adds columns, tables and policies.

### 8. Keep the free project awake
Free-tier Supabase projects pause after about a week with no activity. The workflow `.github/workflows/supabase-keepalive.yml` makes a tiny read request twice a week. Check it under the repo's **Actions** tab. You can also run it manually with **Run workflow**.

---

## Releasing a new version (routine)
1. Edit `index.html` and/or `ipa-core.js`: upload the new files with GitHub's **Add file → Upload files**, or edit in the browser. Bump `APP_VERSION` in `index.html` for user-visible releases.
2. **Commit to `main`.** The *Deploy static content to Pages* action runs automatically, taking about 1 minute. It stamps the commit SHA into the page, so browsers fetch the new `ipa-core.js` rather than a cached copy.
3. Open the site and check that the top bar shows the new version and build (e.g. `v28 · a1b2c3d`). If it still shows the old one, hard-refresh with Ctrl+Shift+R.
4. **If the release changed `supabase_schema.sql`**, run it in the Supabase SQL Editor. The app keeps working before you do, but new fields won't be saved until you run it.
5. **Rollback:** GitHub → the commit → **Revert**, or re-upload the previous files. Supabase data is never touched by a code deploy.

For bigger changes, choose **"Create a new branch… and start a pull request"** when committing. You can then review the diff and merge when ready. The live site only changes on merge.

## Training data policy (legacy confirmations)
Confirmations saved before v27 are tagged `cohort = legacy`. They store raw phase values instead of deviations from background, and none of them were AI-reviewed. They stay in the database and appear in the sidebar, but by default they are **not** used as AI examples or k-NN training data.

To change this, go to **Metrics → Training data in use**:

- Choose the policy: *Current only*, *AI-reviewed only*, or *All*.
- Use **⊘** next to a confirmation to exclude it for everyone.
