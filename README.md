# NightStream — adult video discovery & creator platform

An original, responsive starter repository for an **adults-only** video discovery and creator platform. This is not Pornhub source code, branding, or a claim of affiliation. NightStream uses its own identity and a moderation-first workflow.

**Current scope:** responsive static frontend, Node.js API, PostgreSQL schema, account registration and email-verification flow, external age-assurance callback seam, local video uploads, byte-range playback, creator submission status, report intake, moderator review actions, audit records, Docker Compose, and built-in Node tests.

**It is not production-ready for public adult-content hosting.** External age verification, provider and jurisdiction review, operational moderation, anti-abuse controls, rights/consent record processes, secure object storage/CDN, backup/restore, monitoring, and legal/privacy work remain mandatory before launch. The built-in entry screen and date-of-birth field are not proof of age. No sample uploads, view counts, creator earnings, or wallet balances are fabricated.

## Requirements

- Node.js 20.11 or newer and npm 10+, or Docker Desktop / Docker Engine with Compose.
- PostgreSQL 14+ (PostgreSQL 16 is used by the Compose file).
- For production: HTTPS, a configured email provider, an external age-assurance provider, secure storage/CDN, moderation staffing, incident response, and legal review for each operating/target jurisdiction.

## Quick start with Docker (recommended)

1. Unzip the repository and open the `nightstream-platform` folder in a terminal.
2. Copy `.env.example` to `.env` and edit it. For a local-only run, leave `NODE_ENV` as `development`; use unique local passwords/secrets where practical.
3. Start the stack:

   ```bash
   docker compose up --build
   ```

4. Open `http://localhost:3000` on your laptop or phone on the same network. To access from a phone, use the computer's LAN IP and allow the port through the local firewall. Do not expose the development setup directly to the internet.
5. On first launch, PostgreSQL initializes from `backend/schema.sql`. If you change the schema after the database volume already exists, apply a migration manually; the init script only runs on a fresh volume.

The Compose profile sets `AGE_ASSURANCE_DEV_BYPASS=true` only for local development so a developer can exercise the upload workflow. This bypass is **not permitted in production** and is not age verification. The local Compose SMTP settings are blank; the server prints email verification URLs to its terminal in development.

To stop the stack, run `docker compose down`. This keeps the database and uploads. To remove local data too, run `docker compose down -v` (destructive; deletes the local database and uploaded files).

## Run without Docker

1. Install PostgreSQL, create a database and role, then apply the schema:

   ```bash
   psql "$DATABASE_URL" -f backend/schema.sql
   ```

2. Copy `.env.example` to `.env`, then set `DATABASE_URL`, `JWT_SECRET` (at least 32 random characters), `PUBLIC_BASE_URL`, and a writable `UPLOAD_DIR`.
3. Install and start:

   ```bash
   npm install
   npm test
   npm start
   ```

4. Open `http://localhost:3000`. During local development, email verification links are written to the server terminal if SMTP is not configured.

## Account setup and creator workflow

1. Create an account using an adult date of birth and the required confirmations.
2. Follow the email-verification link from the configured mailbox, or the local development server output.
3. For development only, set `AGE_ASSURANCE_DEV_BYPASS=true` and restart the server to exercise uploads without an external age-check integration. In production this switch prevents server startup.
4. The creator chooses a video, metadata, category and tags, and confirms authorization, adult status and documented informed consent. Accepted formats: MP4, WebM and MOV; the default upload cap is 2 GiB.
5. The video is stored outside the public static directory and remains `pending_review`. Only a moderator can publish it. Rejected/removed and pending videos are not discoverable or streamable through public endpoints.
6. Reports can be submitted from the video player or Safety Centre. Moderator actions and report handling are written to `moderation_audit_log`.

## Moderator setup

1. Register a normal account and verify its email.
2. On the trusted server, run:

   ```bash
   npm run promote-moderator -- moderator@example.com
   ```

   For a Compose database, run the SQL update inside the database container, or run the script in an environment where `DATABASE_URL` points to the Compose database. Example (change the email):

   ```bash
   docker compose exec db psql -U nightstream -d nightstream -c "UPDATE users SET role='moderator' WHERE email='moderator@example.com';"
   ```

3. Sign out and sign in again so the session contains the moderator role. Treat moderator access as privileged; enable MFA at the identity-provider layer or implement it before launch, and restrict access to this command/DB.

## Age-assurance integration contract

An approved external provider must perform the age check. This app only provides a server-to-server callback seam; it does **not** verify identity by itself.

`POST /api/age-assurance/webhook` expects an `x-age-assurance-secret` header that matches `AGE_ASSURANCE_WEBHOOK_SECRET`, and JSON such as:

```json
{
  "userId": "the-registered-user-uuid",
  "status": "verified",
  "provider": "your-provider-name",
  "providerReference": "non-sensitive-provider-reference"
}
```

The provider must authenticate callback delivery, sign or otherwise protect its callbacks, prevent replay, and map its verified subject to the correct account. Do not pass identity documents, face images, biometric templates, or sensitive evidence to this callback. Add provider-specific signature verification, event timestamps/idempotency and integration tests before production; the shared-secret seam is only a starter integration. Store the minimum audit evidence required by policy and law.

## API overview

- `GET /api/health` — database readiness.
- `GET /api/config` — brand, category and upload configuration.
- `POST /api/auth/register`, `GET /api/auth/verify-email`, `POST /api/auth/login`, `GET /api/me` — account lifecycle.
- `POST /api/age-assurance/webhook` — integration callback seam.
- `GET /api/videos`, `GET /api/videos/:id`, `GET /api/videos/:id/stream` — published-library discovery and range streaming.
- `POST /api/videos/upload`, `GET /api/me/videos`, `DELETE /api/me/videos/:id` — creator flow.
- `POST /api/reports` — report intake.
- `GET /api/moderation/videos`, `PATCH /api/moderation/videos/:id`, `GET /api/moderation/reports`, `PATCH /api/moderation/reports/:id` — moderator operations.

## Important production gaps to close

- Integrate and enforce legally appropriate age assurance on both content viewing and creator uploads, not just account entry. Add robust age-gate UX and jurisdiction-aware access rules.
- Replace local disk storage with private object storage, signed playback access, malware scanning, media transcoding, adaptive bitrate streaming, CDN delivery, storage quotas, and secure deletion. Local upload storage is for development only.
- Put video discovery and byte-range streaming behind server-side age-assurance enforcement before public launch. This starter's browsing endpoints are designed for local build/testing; use a deployment gateway/service policy and code-level identity/age checks before any real adult content can be served.
- Add content fingerprinting/repeat-abuse detection, performer identity/age and consent evidence workflow, urgent non-consensual-content handling, child-safety escalation and legally required notices, copyright takedown/counter-notice workflow, trusted-reporting path, moderator training, SLA and staffing.
- Use MFA for staff, secure session design, CSRF defense if moving tokens into cookies, email reset/change flows, account deletion/export, privacy/retention controls, audit log retention, backups and restore drills, observability, vulnerability/dependency scanning, disaster recovery and incident response.
- Have counsel review all applicable laws, payment/platform terms if monetization is added, data protection requirements, and local operating requirements. No monetization or earnings are implemented in this starter.

## Tests and checks

```bash
npm test
node --check backend/server.js
node --check backend/validators.js
node --check public/app.js
```

The built-in tests focus on validation helpers. They are not a substitute for end-to-end, penetration, load, age-assurance, moderation, or streaming tests.
