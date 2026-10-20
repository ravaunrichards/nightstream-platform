# NightStream safety and launch checklist

Use this as a release gate, not a statement that any item is already complete.

## Age assurance and minors
- [ ] Select a qualified age-assurance vendor appropriate to target jurisdictions.
- [ ] Verify server-side age status for content discovery, player metadata, video streams, accounts, and uploads; do not rely on JavaScript, cookies, or birth-date self-attestation.
- [ ] Implement provider signature verification, replay/idempotency protections, secure mapping and minimal audit records.
- [ ] Keep the development bypass disabled; the app is designed to refuse startup in production if it is enabled.
- [ ] Document child-safety escalation and legally required reporting/contact processes with counsel.

## Performer consent and rights
- [ ] Require accountable identity/age and informed-consent verification for every depicted performer, through a secure and privacy-preserving workflow.
- [ ] Verify uploader rights, releases, scope of distribution and revocation/withdrawal procedures.
- [ ] Create urgent escalation and removal workflows for suspected non-consensual content and underage-safety concerns.
- [ ] Implement copyright notices, counter-notice and repeat-infringer procedures as required by law.

## Platform operations
- [ ] Replace local disk with private object storage and signed access; configure transcode/streaming/CDN and malware scanning.
- [ ] Validate media content server-side; add upload concurrency/quota rules, safe deletion and retention controls.
- [ ] Staff and train moderators, set severity levels and response SLAs, and test audit logs.
- [ ] Add account recovery, MFA for moderators/admins, session revocation, API abuse controls, and security alerts.
- [ ] Complete a privacy notice, retention schedule, user terms, community rules, contact/escalation path and data-subject request flow.
- [ ] Set up backups, restore tests, metrics, logs, uptime monitoring, incident response and security/dependency scanning.
- [ ] Complete external security testing and legal review for each target region before public launch.

## Release sign-off
- [ ] Development and production environments have separate databases, secrets and storage.
- [ ] No default passwords, example secrets, development bypass, unverified provider callbacks, or public debug endpoints remain enabled.
- [ ] Age/consent/rights scenarios, takedowns, removed content, direct stream URLs and role authorization are tested end to end.
- [ ] Responsible owner, on-call process, incident escalation and shutdown capability are documented.
