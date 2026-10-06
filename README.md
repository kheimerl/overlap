# Overlap

An ad-free when2meet. It's a static site (GitHub Pages) with a Google Apps Script backend that stores only encrypted blobs in a Sheet.

## How it works

- **The link holds the key.** Creating an event generates a random 16-byte key and puts it in the URL fragment (`…/#<key>`). Browsers never send the fragment to a server.
- **Everything else is derived from that key** using HKDF:
  - the event ID the server stores rows under
  - an AES-GCM key that encrypts the event details and every response
  - a write token; the server keeps only its SHA-256 hash and checks it on every write
- **Rows belong to participants.** Each participant's row ID is the hash of a secret derived from the key plus their name and optional password. The server computes that hash itself, so only someone who can derive the secret can overwrite a row. Without a password, anyone with the link who types your name can edit your row, which is the same as when2meet.
- **The Sheet holds no plaintext.** There are no titles, names or times in it; `test/e2e.test.mjs` checks this.

Abuse controls in `apps-script/Code.gs`:

- **Event creation** costs a proof-of-work (16 bits; about 0.5 s in Chrome, set by `POW_BITS`).
- **Rate limits:** 30 new events per minute; 300 response saves per minute overall and 90 per event. A request without a valid link token is rejected before it takes the lock or counts toward any limit, so strangers can't use up everyone else's budget.
- **Caps:** 100 participants per event, 5,000 events and 20,000 responses in total, plus size limits on every field.
- **Input checks:** only base64url input is accepted, which also rules out formula injection.
- **Cleanup:** a daily trigger deletes events with no activity for 90 days.

### What these controls don't stop

The proof-of-work only slows down a browser; a script running native code solves 16 bits in milliseconds. A determined attacker can therefore create events (and respond to them) at the rate limits. That fills the 5,000-event cap in a few hours. The junk events count as active, so they don't expire for 90 days, and the service stays read-only until you clear the Sheet by hand. Existing events keep working, but nobody can create new ones.

A flood of requests can also use up your Apps Script quota (about 30 simultaneous executions per account), since every request runs the script. That causes downtime until the flood stops.

Apps Script can't see client IPs, so it can't tell an attacker from a busy group. The fix is a Cloudflare Worker in front (below), not more server-side heuristics. For a link shared within a research group, neither scenario is likely.

## Deploying

### 1. Check that UW allows public web apps (do this first)

Create any Apps Script project, open **Deploy → New deployment → Web app**, and look at the **Who has access** dropdown.

- If it offers **Anyone**, continue.
- If it only offers **Anyone within University of Washington**, the domain admin has turned off public web apps. Use a personal Google account for steps 2–3 instead. Nothing else changes.

### 2. Backend (Apps Script)

1. Create a new Google Sheet, then open **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo and save.
3. In the function dropdown, run **`setup`** and approve the permissions. It creates the `events` and `responses` sheets and the daily cleanup trigger.
4. Run **`selfTest`** and check that the execution log says `selfTest passed`. It confirms that Sheets stores IDs and blobs exactly as written, without converting them to numbers or dates.
5. **Deploy → New deployment → Web app**, with "Execute as: **Me**" and "Who has access: **Anyone**". Copy the URL, which ends in `/exec`.

To update the code later, use **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL; creating a new deployment gives you a new URL.

### 3. Frontend (GitHub Pages)

1. Paste the `/exec` URL into `DEPLOYED_API_URL` in `js/config.js`.
2. Push the repo to GitHub and enable **Settings → Pages → Deploy from branch** (root).

## Local development

```sh
npm run dev     # site on http://localhost:8000, API on :8788
npm test        # unit tests, plus end-to-end tests of the real Code.gs
API_DELAY_MS=1500 npm run dev   # simulate real Apps Script latency
```

The dev API runs the real `apps-script/Code.gs` against an in-memory imitation of Sheets (`dev/gas-shim.mjs`). The imitation reproduces the Apps Script behaviors the code depends on: signed digest bytes, padded base64, Sheets converting strings to numbers, and rejected CORS preflights. It's still an imitation, which is why `selfTest()` exists to check those behaviors in the real environment.

On localhost, the client automatically uses the dev API. No dependencies are needed beyond Node 22.

## Hardening further

If this gets public use, put a Cloudflare Worker in front of the Apps Script URL. It adds what Apps Script can't do itself:

- per-IP rate limiting
- Turnstile (Cloudflare's free invisible CAPTCHA) on event creation
- filtering of request floods before they reach your quota

The client only needs `DEPLOYED_API_URL` changed, and the CSP's `connect-src` in `index.html` updated to allow the Worker's origin.

## Known limitations

- The grid is shown in the event's time zone. Viewers elsewhere see a notice, and each slot shows their local time on hover or tap.
- There is no editing or deleting of an event after creation, and no way to remove someone's row. Events expire 90 days after their last activity.
- The painting grid needs a mouse or touch; there's no keyboard support yet.
- Lose the link and the event is gone: the server can't recover the key.
