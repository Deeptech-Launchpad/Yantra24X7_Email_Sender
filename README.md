# Yantra 24x7 Bulk Email

A standalone application for a sales team to send personalised bulk email from their own Gmail accounts:
upload an Excel list → choose a template → add CC and attachments (including one PDF per company from a ZIP)
→ review every email → approve → the app sends them one at a time and reports on every recipient.

It is **independent**: its own code, configuration, database (a SQLite file), files, users and Gmail authorizations.
It does not use, call or share anything with the Marketing AI Agent or NXT Sales. See `docs/inventory.md` for what was
recreated from the Marketing AI Agent's Bulk Email.

**It ships in TEST MODE.** Until `SEND_MODE=live` is set, no email is sent: each email is written to `DATA_DIR/outbox`
as an `.eml` file that opens in any mail program, so the whole flow can be checked safely.

---

## The screens

The layout and the flow follow the Marketing AI Agent's Bulk Email, in this company's orange:

- **Bulk email** (the home page): a **Sender** panel (each sender account, *Authorized*, how much it can still send today, *Check sender*), then the list of bulk emails with their counts.
- **New bulk email**, three steps: **1. Upload Excel** (sheet, one email per company or per person, the template(s), sender, Reply-To and CC, and the list as read) → **2. Review emails** (every email with the reason for each one not sent, a preview exactly as sent, attachments and the company ZIP below it) → **3. Date, time and start** (times, the explicit approval, *Approve and start sending*).
- A bulk email's page: counts, every recipient with its status and reason, retry / resolve, pause / resume / cancel, CSV report.
- Templates, Sender accounts (add with Google sign-in or an app password), Do-not-email list and Users have their own pages.

Not carried over from the Marketing AI Agent: *Send to one person* and the *Skipped companies* page (skipped recipients and their reasons are in the review, on the bulk email's page and in the CSV).

## What it does

| | |
|---|---|
| **Recipients** | Upload an `.xlsx`. Columns are found by their headings (Company Name, Contact Person 1, Email Id1, Contact Person 2, Email 2, Status …). A workbook with several sheets: choose the sheet (by default the first with an email heading, so a summary sheet is skipped). **Several sheets in one campaign, each with its own email** (for example the Mailer 1 / 2 / 3 sheets of one workbook: the *Mailer 1* sheet is sent the *Mailer 1* template, and so on — the template is picked by name where it can be, and the review shows the sheet and the email of every person; at most 3 sheets). **One email per company** (the first named person receives it, colleagues are copied) or **one email per person** (every row its own email, nobody copied; `[First Name]` is the *First Name* column exactly as written). Up to 5,000 recipients. Only work addresses (webmail is off unless ticked). Rows without a usable address are listed with the reason. |
| **Counts** | Eligible, invalid (no address / no name to greet), duplicate (an address already in the campaign), excluded (Status column, do-not-email list, already queued, outcome unknown, same email already sent, excluded by hand), blocked (company PDF problem). |
| **Templates** | Saved templates (subject + formatted body; paste from Gmail, Outlook or Word), or one written for the campaign. `[First Name]` and `[Company Name]` are filled per person. Up to 3 templates per campaign, in order or at random. Preview before sending. |
| **Sender accounts** | Each member connects their own Gmail / Google Workspace account with Google's sign-in (send-only permission), **or adds it with a Gmail app password** (sent through Gmail's mail server; checked by signing in, stored encrypted, never shown again). Shown with status and daily usage; check readiness; signature; daily limit; disconnect / reconnect. Admins can share an account with the team. |
| **Replies and CC** | An optional Reply-To address for the campaign (replies — and List-Unsubscribe — go there instead of the sender). The company's other contacts (on/off) plus up to 10 addresses on every email. Do-not-email addresses are left out of the copy. |
| **Attachments** | Up to 5 files on every email (10 MB each, 18 MB per email in all; programs/scripts blocked) and/or one ZIP (up to 1 GB, uploaded in pieces) of PDFs named after the companies: each recipient gets only their own company's PDF. Missing, ambiguous, damaged or too-large files block the campaign until fixed or explicitly excluded. Real files are attached — never links. |
| **Approval** | A final summary (recipients, sender, CC, templates, attachments, times) and an explicit confirmation. Start re-checks everything and is refused if anything changed since the review (it compares a fingerprint of every reviewed email). |
| **Sending** | One campaign at a time per account, one email at a time, at least N minutes apart, within the account's daily limit. Each email is claimed before it is sent. |
| **Safety** | Gmail refused it → **failed** (a person may retry). Gmail's limit or a lost permission → not sent, back in the queue, the campaign pauses. No clear answer (connection lost, timeout, Gmail error) → **outcome unknown**: never sent again automatically; looked up in Sent (optional) or resolved by a person. The same email is never sent twice to the same address. |
| **Reports** | Campaign status and counts, every recipient with status and reason, each email as sent, and a CSV download. |
| **Users** | admin / member / viewer, created by an admin. Everyone may see every campaign; only the person who started a campaign, or an admin, may pause, resume, cancel, retry or resolve it. |

---

## Project layout

```
yanthara bulk email process project/
├── README.md, .env.example, package.json, tsconfig*.json, vitest.config.ts
├── docs/inventory.md            what was recreated from the Marketing AI Agent, and how
├── prisma/schema.prisma         this app's database (SQLite)  ·  prisma/migrations/
├── scripts/create-user.ts       creates the first admin
├── src/
│   ├── index.ts, app.ts         start-up; the web application (API, tracking image, screens)
│   ├── config/env.ts            all configuration (validated)
│   ├── platform/                database client, errors, log + audit, secretBox (AES-256-GCM)
│   ├── auth/users.ts            sign-in, sessions, roles, users
│   ├── gmail/oauth.ts, api.ts   Google authorization (PKCE) and sending through the Gmail API
│   ├── mail/mime.ts, transport.ts   the message itself; test mode vs live
│   ├── bulk/                    excel, extract, content, schedule, files, companyZip, review,
│   │                            campaigns, dispatcher, senders, templates, suppression, tracking
│   └── routes/api.ts            every API route, validated
├── tests/                       100 tests: the whole workflow through the API against a fake Google and a fake Gmail mail server
└── web/                         the screens (React + Vite), orange and white; 17 tests
```

---

## Setup (development)

Requirements: Node.js 22 or newer.

```bash
npm install
cd web && npm install && cd ..
cp .env.example .env
# fill in SESSION_SECRET (≥ 32 random characters) and TOKEN_ENCRYPTION_KEY (npm run key:generate)
npx prisma migrate deploy        # creates data/yanthara.db
npm run user:create -- --email admin@yanthara.example --name "Admin Name" --role admin
npm run dev                      # API + sender on http://localhost:4300
cd web && npm run dev            # screens on http://localhost:5173 (calls the API on 4300)
```

Production build: `npm run build && (cd web && npm run build) && npm start` — one process serves the API, the sender and the screens on `PORT`.

Tests: `npm test` (server) and `cd web && npm test` (screens). Tests use throwaway databases and a fake Google server on 127.0.0.1 — nothing reaches Google and nothing is sent.

## Configuration (`.env`)

Names only — never commit `.env`. Every value is this application's own.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | | `production` on the server |
| `PORT` | | default 4300 |
| `HOST` | | default `127.0.0.1`: the app listens only on its own machine and is reached through the web server (nginx + HTTPS). `0.0.0.0` opens the port on every network address |
| `APP_BASE_URL` | yes | the address people open (e.g. `https://bulk.yanthara-domain`); used for Google's return address |
| `COMPANY_NAME` | | shown in the header (default Yanthara) |
| `DATABASE_URL` | yes | `file:../data/yanthara.db` (relative to `prisma/`) |
| `DATA_DIR` | yes | uploaded files, company PDFs, ZIPs and the test outbox (needs free disk space; back it up with the database) |
| `SESSION_SECRET` | yes | ≥ 32 random characters |
| `SESSION_HOURS` | | sign-in lasts this long (default 12) |
| `TOKEN_ENCRYPTION_KEY` | yes | 32 random bytes, base64 — encrypts Gmail permissions at rest. **Keep it safe: losing it means reconnecting every account** |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Gmail | the OAuth client (below) |
| `GOOGLE_OAUTH_REDIRECT_URL` | | default `APP_BASE_URL/api/oauth/google/callback` |
| `GMAIL_READONLY_CHECK` | | `true` also asks for read access, to look up emails with an unknown outcome in Sent (a restricted Google scope — see below) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | | Gmail's mail server, for accounts added with an app password (defaults `smtp.gmail.com`, `465`, `true`) |
| `SEND_MODE` | | `test` (default, nothing is sent) or `live` |
| `APP_TIMEZONE` | | default `Asia/Kolkata` |
| `MIN_INTERVAL_MINUTES` | | smallest gap between two emails of a campaign (default 1) |
| `DEFAULT_DAILY_LIMIT` | | new accounts' daily limit (default 400; Workspace allows 2,000, free Gmail 500) |
| `DISPATCH_TICK_SECONDS` | | how often the sender looks for due emails (default 20) |
| `REPEAT_COOLDOWN_DAYS` | | 0 = off; otherwise nobody gets a second email within N days |
| `EXCEL_SKIP_STATUS_WORDS` | | comma-separated Status words that skip a company (default `outreach`) |
| `LIST_UNSUBSCRIBE_MAILTO` | | adds a `List-Unsubscribe` header to the sender's own mailbox (default true) |
| `TRACKING_ENABLED`, `TRACKING_BASE_URL` | | open tracking — **off**; see the last section |
| `GOOGLE_*_URL`, `GMAIL_API_BASE` | | leave as they are (tests point them at a fake server) |

The app refuses to start when a required secret is missing or malformed (it names the setting, never a value).

---

## Configuring the company's Gmail sender accounts

Done once, by someone with access to the company's Google account (ideally a Google Workspace admin).

1. **Google Cloud project** — at <https://console.cloud.google.com> create a project for Yanthara (do not reuse another company's).
2. **Enable the Gmail API** — APIs & Services → Library → *Gmail API* → Enable.
3. **OAuth consent screen** — APIs & Services → OAuth consent screen:
   - **User type: Internal** if the company uses Google Workspace (only the company's own accounts can connect; no Google review needed). Otherwise *External*, and add each sender as a test user, or apply for verification (`gmail.send` is a *sensitive* scope).
   - App name, support email, the company's domain; scopes: `openid`, `.../auth/userinfo.email`, `.../auth/gmail.send` (and `.../auth/gmail.readonly` only if you set `GMAIL_READONLY_CHECK=true` — a *restricted* scope that, for External apps, needs Google's security review).
4. **OAuth client** — Credentials → Create credentials → OAuth client ID → *Web application*. Authorized redirect URI: exactly `APP_BASE_URL/api/oauth/google/callback` (for local testing `http://localhost:4300/api/oauth/google/callback`). Put the client ID and secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and restart.
5. **Each salesperson** signs in to the app → *Sender accounts* → **Connect Gmail** → signs in on Google's page and allows *Send email on your behalf*. The account appears as *connected*; **Check readiness** confirms it can send. Set the signature and a daily limit under *Settings*.
6. An **admin** may tick *Let every member send from this account* to share it.
7. To remove access: **Disconnect** (the permission is revoked at Google and erased here), or the person removes it at <https://myaccount.google.com/permissions> — the app then shows *reconnect needed*.

Nothing of the Marketing AI Agent's company is used: its own Google project, client, tokens and accounts stay where they are.

### Or: an account with a Gmail app password

No Google Cloud project is needed. In the Google account that will send: turn on **2-Step Verification**, then
**Security → App passwords** → create one (Google shows 16 letters). In the app: *Sender accounts* → **Add with
app password** → the Gmail address, the 16 letters, a sender name. The app signs in to Gmail's mail server to check it
(no email is sent) and keeps it encrypted. It is not the account's normal password; removing it in the Google account
stops this app at once (the account then shows *needs reconnect* → **New app password**). An app password cannot look
in Sent, so an email with an unknown outcome is checked in Gmail by a person.

### Going live

Only after an approved test in TEST MODE (check the `.eml` files in `DATA_DIR/outbox`): set `SEND_MODE=live`, restart,
and send a first small campaign to the team's own addresses (tick *Include personal / webmail addresses* for Gmail
test addresses).

---

## How sending stays safe

- **What is approved is what is sent** — the review returns a fingerprint of every email (recipient, CC, subject, body, template, files, sender, mode); Start recomputes it and refuses if anything differs.
- **Claim, then send** — an email moves `scheduled → sending` in one database step, only while its campaign is running, before it is handed to Gmail; a second sender can never take it. The campaign is checked again just before handing over, so a pause or cancel stops the next email. A cancelled campaign's emails are never put back in the queue. A lease makes sure only one sender loop runs.
- **Test and live never mix** — each campaign records the mode it was approved in (`TEST` badge on the screens) and only sends in that mode: switching the app to live pauses a test campaign instead of sending it. Test emails do not count toward the real daily limit or as "already sent".
- **Recorded before handing over** — the attempt time and the email's own `Message-ID` are stored first, so its outcome can always be looked up.
- **Outcomes** — sent; *failed* (Gmail answered and refused: retry allowed by a person); *limit/permission* (certainly not sent: back in the queue, campaign paused with the reason); *unknown* (connection lost, timeout, 5xx: **never resent automatically**). An app crash mid-send is also treated as unknown.
- **Unknown outcomes** — with `GMAIL_READONLY_CHECK=true` the app looks the email up in Sent by its Message-ID and marks it sent when found. Otherwise a person checks the Sent folder and clicks *It was sent* / *Not sent* (only *Not sent* allows a retry). An address with an unknown outcome is excluded from new campaigns until resolved.
- **Never twice** — the same subject and text are never sent again to the same address; an address queued elsewhere is not added; the first row that lists an address owns it in a campaign.
- **Limits** — one campaign at a time per account, a minimum gap, the account's daily limit (rolling 24 hours, counting unknown outcomes).
- **Files** — every attachment is checked against its SHA-256 before it is attached; a company PDF must also be named after the recipient's company, or the email is not sent.
- **Do-not-email list** — checked at the review and again at the moment of sending (for the recipient and every CC; a blocked CC is left out and the record shows who really got the email).
- **Gmail sign-in** — authorization code with PKCE; a single-use state (10 minutes) says who started it, and an httpOnly cookie says which browser: a sign-in link cannot be finished in another browser.

---

## Opening the app at an IP address, without HTTPS

Not recommended for real use: the sign-in password — and any Gmail app password typed into the screens — travels
unencrypted. If you still want `http://SERVER-IP:4300`, set in `.env`: `HOST=0.0.0.0` and `APP_BASE_URL=http://SERVER-IP:4300`
(a plain-http address switches off the "upgrade to https" rule and HSTS, which would otherwise leave the page blank),
restart, and ideally limit the port to your own address in the firewall. The safer ways: HTTPS on a domain (nginx +
certbot, see Deployment), or an SSH tunnel (`ssh -L 4300:127.0.0.1:4300 user@server`, then open `http://localhost:4300`)
with the default `HOST=127.0.0.1`.

## Open tracking — the option is built; it switches on once the domain and server are known

Each bulk email has a **Track opens** option (step 3, *Date, time and start*; off unless ticked). It can be ticked only
when the server has tracking set up; until then the box is greyed out and says why. A tracked bulk email shows, on its
page, **Opened** (with the first time) or **Not opened yet** for every person who was sent the email, filters for
*opened* / *not opened*, an *Opened* count in the list, and an *Opened?* column in the CSV report. An open is a signal,
not proof of reading (images can be blocked or pre-loaded by scanners), and recipients are not told that opens are
recorded — review your privacy wording before using it.

The option needs this application's **own public HTTPS address** (the recipient's mail program loads the image from
it, so `localhost` cannot work); never another company's domain. When you provide the domain and server IP:

1. Point a DNS record (e.g. `bulk.<yanthara-domain>`) at the server IP.
2. Put the app behind HTTPS (e.g. nginx + Let's Encrypt) proxying to `PORT`; make sure `GET /t/<token>.gif` reaches the app.
3. Set `APP_BASE_URL=https://bulk.<yanthara-domain>` (and update the Google OAuth redirect URI to match), `TRACKING_BASE_URL=https://bulk.<yanthara-domain>`, `TRACKING_ENABLED=true`; restart.
4. Test: one email to an internal address; open it with images shown; the campaign shows *opened* within a minute.

How it counts: each email gets its own invisible image (only a hash of its token is stored); a fetch within 15 seconds
of sending is ignored (mail scanners) and repeats within a minute count once. Mail programs that block or pre-load
images make open counts approximate.

## Deployment (not done — needs approval)

Nothing has been deployed. A typical deployment: a Linux server with Node 22+, the project at a folder of its own,
`npm ci && (cd web && npm ci) && npx prisma migrate deploy && npm run build && (cd web && npm run build)`, one process
(`npm start`, e.g. under pm2 or systemd), HTTPS in front, and a daily backup of `data/` (database + files) and `.env`.
