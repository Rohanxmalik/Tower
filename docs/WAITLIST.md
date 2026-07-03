# Collect Tower Cloud waitlist signups in a Google Sheet

The waitlist form on the site ([`site/index.html`](../site/index.html), the "Tower Cloud"
card) works out of the box — with no setup it opens a pre-filled email to the maintainer.
To capture signups **automatically into a Google Sheet**, pick one of the two options below,
then paste the resulting URL into **one line** of the site.

Both are free. **Option A (Google Apps Script)** goes straight into a Sheet with $0 and no
extra account — recommended. **Option B (Formspree)** is a hosted form service that also
emails you each signup.

---

## Where the URL goes (same for both options)

Open [`site/index.html`](../site/index.html), find this line (search for `ENDPOINT`):

```js
const ENDPOINT = "";
```

Paste your URL between the quotes, save, commit, and push. GitHub Pages redeploys and the
form starts writing to your sheet. The site auto-detects which kind of URL it is (Apps
Script vs Formspree) — you don't change anything else.

---

## Option A — Google Apps Script → straight into a Sheet (free, recommended)

You'll make a Google Sheet, attach a tiny script that appends a row per signup, and publish
it as a web app. ~5 minutes.

**1. Make the sheet.** Go to [sheets.new](https://sheets.new). In the first row, type
these three headers (row 1): `timestamp`, `email`, `product`. Name the sheet anything.

**2. Open the script editor.** In that sheet: **Extensions → Apps Script**. A code editor
opens in a new tab.

**3. Paste this code** (delete whatever's there first):

```js
function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const p = (e && e.parameter) || {};
  sheet.appendRow([new Date(), p.email || "", p.product || "Tower Cloud"]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
    ContentService.MimeType.JSON,
  );
}
```

**4. Deploy it as a web app.** Click **Deploy → New deployment** → the gear icon → **Web
app**. Set:

- **Execute as:** _Me_
- **Who has access:** _Anyone_ ← must be "Anyone" so the website can post to it

Click **Deploy**. Google will ask you to **authorize** — approve it (it's your own script).

**5. Copy the Web app URL.** It looks like
`https://script.google.com/macros/s/AKfy…long…/exec`. That's your `ENDPOINT`.

**6. Paste it into the site** (see [Where the URL goes](#where-the-url-goes-same-for-both-options)),
commit, push. Submit a test email on the live site — a new row appears in your sheet within
a second.

> Changed the script later? You must **Deploy → Manage deployments → Edit → Version: New
> version** for changes to take effect (the `/exec` URL stays the same).

---

## Option B — Formspree (hosted form + email + Sheets)

Formspree emails you every signup and can push to Google Sheets. The free plan covers 50
submissions/month.

**1. Create the form.** Sign up at [formspree.io](https://formspree.io) → **New Form** →
name it "Tower Cloud waitlist" → set the notification email to yours. You'll get an endpoint
like `https://formspree.io/f/abcdwxyz`.

**2. Paste it into the site** as your `ENDPOINT`
(see [Where the URL goes](#where-the-url-goes-same-for-both-options)), commit, push. Submit
a test email on the live site; **confirm** the first submission via the email Formspree
sends (one-time anti-spam step). After that, signups flow in.

**3. Send them to a Google Sheet.** Two ways:

- **Formspree → Google Sheets (paid plans):** in the form's **Plugins / Integrations**, add
  **Google Sheets**, authorize, pick a spreadsheet. New submissions append automatically.
- **Free alternative:** in Google Sheets install the **Email → Sheets** add-on (e.g.
  _Sheet+_ / _Email Parser_), or forward Formspree's notification emails to a
  [Zapier](https://zapier.com)/[Make](https://make.com) "Email → add row" zap. If you want
  Sheets on the free tier with zero glue, use **Option A** instead — it's simpler.

---

## Which should I use?

- **Just want the emails in a Sheet, for free, minimal moving parts →** Option A (Apps
  Script).
- **Want email notifications + spam filtering + a submissions dashboard, and don't mind
  Formspree's paid Sheets plugin →** Option B.

Either way, the site code already handles both — you only ever edit the one `ENDPOINT` line.
