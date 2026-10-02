# S&S Shop Invoicing — setup

Everything here is ready to upload as-is; nothing needs editing before it runs.

## 1. Put this on GitHub Pages (free hosting)

1. Go to github.com and create a new **public** repository (e.g. `ss-invoicing`).
   Public is required for free GitHub Pages, but nobody can use the app without
   your Supabase login, so the data itself stays private.
2. Upload every file and folder in this package to the **root** of that
   repository (`index.html`, `app.js`, `app.css`, `manifest.json`, `sw.js`,
   the `icons` folder, and the `.github` folder — GitHub's uploader shows
   hidden folders like `.github` once you drag the whole package in).
3. In the repo, go to **Settings → Pages**. Under "Build and deployment",
   set Source to **Deploy from a branch**, branch **main**, folder **/(root)**.
   Save.
4. After a minute or two, your app is live at
   `https://<your-username>.github.io/<repo-name>/`.

## 2. Install it on the iPhone

1. Open that link in **Safari** (not Chrome — this only works from Safari on iOS).
2. Tap the **Share** button, then **Add to Home Screen**.
3. It now opens full-screen, with its own icon, like a normal app.

## 3. Sign in

Use the login you created in Supabase under **Authentication → Users**
(the shop email and the password you chose there — not the one typed earlier
in this chat, since that one should be considered exposed).

## 4. The keep-alive job

The `.github/workflows/keepalive.yml` file pings your Supabase database every
3 days so the free project is never treated as inactive. It starts working
automatically once the repository exists — no setup needed. You can check it
ran under the repo's **Actions** tab.

One GitHub quirk worth knowing: GitHub disables scheduled workflows in a
repository that's had **no activity of any kind for 60 days**. Opening the
app and using it counts as Supabase activity, not GitHub activity, so if a
slow quarter goes by with no invoices *and* nobody touches the repo, the
workflow could pause itself. If that ever happens, a banner appears on the
repo's Actions tab with a one-click **Re-enable workflow** button — nothing
is lost, it just needs that click. If you'd like extra insurance, a free
service like cron-job.org can ping the same URL independently; ask me if
you'd like that set up.

## 5. Updating the app later

Since there's no build step, changing anything is just editing the file and
re-uploading it (or asking me to make the change and sending you the new
file). iPhones may keep showing the old cached version for a little while
after an update — closing the app fully (swipe it away in the app switcher)
and reopening it fetches the latest copy.

## What's included in this version

- Login, dashboard with money owed/collected this month
- Invoices: create, edit, search, filter by status, record payments
- Your 72 invoices and 101 payments from Invoice Simple, imported and
  locked so their original figures can never be altered
- Print / Save as PDF, and Share (WhatsApp, email, etc.)
- Clients and saved items
- Expenses with categories and receipt photos
- Settings: business profile, payment instructions, saved items, expense
  categories

## Not yet built (tell me if you'd like these next)

- Reports/CSV export beyond the dashboard's monthly summary
- Recurring invoices or recurring expenses
- Manually merging the "possible duplicate" clients flagged in the Clients tab
- Multiple staff logins
