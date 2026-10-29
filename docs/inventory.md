# Inventory — what was recreated from the Marketing AI Agent's Bulk Email

Written on 2026-10-29 by inspecting (read-only) `marketing-agent/src/outreach/bulk/*`,
`marketing-agent/src/api/routes/bulkEmail.routes.ts` and `marketing-agent/web/src/engines/bulk/*`.
Nothing in the Marketing AI Agent was changed. This project does not import, call or share anything with it at run time:
the useful parts were **copied and adapted** into this repository.

## Component map

| Existing component (Marketing AI Agent) | What it does there | Here | How |
|---|---|---|---|
| `excel.ts` | Reads the first sheet of an .xlsx as text | `src/bulk/excel.ts` | Copied |
| `extract.ts` | Finds columns by heading, work-address rules, one email per company, colleagues CC'd, Status skip | `src/bulk/extract.ts` | Copied; the Status words are configurable (`EXCEL_SKIP_STATUS_WORDS`); repeated addresses are counted as duplicates |
| `schedule.ts` | IST date/time → instants, one email every N minutes | `src/bulk/schedule.ts` | Rewritten for any time zone (`APP_TIMEZONE`) |
| `signature.ts` + `customTemplate.ts` | Cleans pasted HTML (allow-list, safe CSS, https images), fills `[First Name]` / `[Company Name]` (escaped), plain-text part, 1–3 templates in order or seeded random | `src/bulk/content.ts` | Merged and adapted |
| `template.ts` (approved Versions 1–3) | AltiusNxt's own approved email texts | — | **Not copied** (another company's content). Replaced by a saved-template library (`src/bulk/templates.ts`) |
| `attachments.ts` | Common attachments; company ZIP upload in pieces (1 GB), staged on disk, locks, sweeps | `src/bulk/files.ts` | Adapted: every file on disk with a SHA-256, per-user ownership of staged files |
| `companyZip.ts` | Safe streaming ZIP reader, PDF checks, company-name matching, never guesses | `src/bulk/companyZip.ts` | Copied unchanged (pure code) |
| `service.ts` — review / start | Review rows with reasons, duplicate and follow-up rules, start with clean-up on failure | `src/bulk/review.ts`, `src/bulk/campaigns.ts` | Adapted; counts split into eligible / invalid / duplicate / excluded / blocked; manual exclusion |
| `service.ts` — dispatcher | One email at a time, claim before send, spacing, never resend unknown | `src/bulk/dispatcher.ts` | Adapted for direct Gmail sending (outcome classes, daily limit, stuck-send recovery, Sent-folder lookup) |
| `crmSend.ts` + NXT Sales `/api/marketing-bulk` + NXT Sales Gmail pipeline | Sending through NXT Sales' Gmail integration | `src/gmail/*`, `src/mail/*` | **Replaced**: this app holds its own Gmail OAuth authorizations and sends through the Gmail API itself. No dependency on NXT Sales |
| `senders.ts` (From authorization by DNS/DMARC) | Checks the From for the SMTP path | `src/bulk/senders.ts` | Replaced by Gmail account readiness (permission, scope, daily limit) |
| `tracking.ts` + open-tracking route | Invisible image per email, opens counted | `src/bulk/tracking.ts`, `GET /t/:token.gif` | Adapted; **off** until this app's own domain exists |
| Suppression (platform `checkSuppression`) | Opt-out list | `src/bulk/suppression.ts` | Recreated as this app's own do-not-email list (addresses or domains) |
| `skipped.ts` / reports | Skipped recipients report | `src/bulk/campaigns.ts` (`report.csv`) | Recreated as a full recipient-level CSV (formula-safe) |
| `BulkEmail.tsx`, `SingleSend.tsx`, `AttachmentsField.tsx`, `EmailTemplateField.tsx`, `zipUpload.ts` | The screens | `web/src/pages/*`, `web/src/zipUpload.ts` | Rebuilt as a standalone app (orange and white) |
| Platform sign-in, roles | Marketing AI Agent accounts | `src/auth/users.ts` | This app's own users (admin / member / viewer) |

## What was deliberately not recreated

- **Send to one person** (a separate screen in the Marketing AI Agent): a campaign from a one-row Excel does the same here.
- **The approved Versions 1–3 texts**, AltiusNxt domains, names, signatures and settings.
- **NXT Sales**: no CRM records, no CRM Activity, no connection to its database or API.
- Any token, credential, setting, campaign or recipient of the existing company.
