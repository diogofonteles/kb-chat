# 0011 — Access requests, sign-up without Google and one-time codes by email or SMS

- Status: accepted (2026-10-25), implemented by KBC-014
- Amends: [0008](0008-google-login-and-permissions.md) (who gets in, the public routes, the principal)
- Drivers: the owner's request (2026-10-25), Q-security (no session before approval, no account enumeration), zero running cost

## Context

ADR 0008 lets in only the owner and people a master invited by email, and only with a Google account. The owner now wants (1) nobody to get in without approval, with a way to invite or to approve a request, and (2) a sign-up without Google (email, first and last name, mobile) followed by a code by email or SMS at each sign-in, on free services.

## Decision

**Access requests** (module `access-requests`, `KB_CHAT_STATE_DIR/access-requests.json`, 0600, atomic)
- A request is `{ id, email, firstName, lastName, phone, source: 'form' | 'google', sub, picture, status: 'pending' | 'refused', createdAt, refusedAt, refusedBy }`. Only masters list, approve and refuse (`{ master: true }`).
- Approving removes the request and adds a person with the invite defaults (KBC-010 BR-3); a Google request binds its `sub` at once. Refusing keeps the request as `refused`: the same email (or `sub`) may ask again 24 h after `refusedAt`, and the new request replaces it.
- Masters get an email on every new request; the requester gets one on approval. A failed email is logged and never fails the request.

**Sign-up without Google:** `POST /api/v1/access-requests/signup` (public) takes the email, names and an E.164 mobile (normalized by `@kb-chat/contracts`, default country +55) and always answers `202 {}`. When the email can be used it stores a pending sign-up code (purpose `signup`, carrying the form) and emails it; an email that already has access, a pending request or a cooldown gets an informative email instead of a code. `POST .../signup/verify` with the right code creates the pending request.

**Google without an invite:** `POST /api/v1/auth/google` still answers `403 NOT_INVITED`, now with `details: { ticket, request }`. The ticket is `base64url(payload).base64url(HMAC-SHA256)` over `{ jti, sub, email, name, picture, exp }`, signed with a random 32-byte key made at boot (kept in memory), valid 15 min and single-use (spent `jti`s are remembered until they expire). `POST /api/v1/access-requests/google { ticket, phone? }` (public) creates the request. The ID token itself is never accepted twice (ADR 0008); a restart only means clicking the Google button again. `request` tells the person whether their own request is pending or refused (with `retryAt`), which is not enumeration: the identity is theirs.

**One-time codes** (`auth` module, `KB_CHAT_STATE_DIR/codes.json`, 0600, atomic)
- 6 random digits (`crypto.randomInt`), valid 10 minutes, single use, at most 5 attempts, one live code per identifier and purpose (a new one replaces it).
- Stored only as `scrypt(code, salt)` with a random 16-byte salt per code (N = 2^14): a copy of the file does not give the codes back within their lifetime. Compared with `timingSafeEqual`.
- Send limits, in memory (one API process, ND-22): 1 per minute and 5 per hour per identifier; 5 per minute and 20 per hour per client address (`request.ip`, correct behind the proxy once `TRUST_PROXY` is set, ADR 0010). Verifying is also capped per address by `@fastify/rate-limit`.
- `POST /api/v1/auth/code { identifier, channel }` (public) always answers `202 {}`; when the identifier is a person's email (or phone, for SMS) a sign-in code goes out. `POST /api/v1/auth/code/verify { identifier, code }` opens the same session as Google (cookie, CSRF and revocation of ADR 0008) or answers `400 INVALID_CODE`.
- No enumeration by timing either: the reply is sent before the code is hashed and delivered, in every case.
- Any person in "Pessoas e permissões" may sign in with a code (the code proves the mailbox, as Google does); SMS only for a person with a phone.

**Principal:** a person may now have no Google `sub`. The stored person gains an optional `principal`, fixed at a form approval (the person id) and at the first code sign-in (`sub ?? id`); it wins over `sub` afterwards. A code person who later signs in with Google under the same verified email is matched by the existing invite rule (`sub` still null), so linking Google keeps their history, settings and keys. The owner keeps `owner`.

**Delivery**
- Ports `EmailSenderPort` and `SmsSenderPort` (`send(message)`); the messages are pt-BR text built in one place (`auth/messages.ts`).
- Email: Resend's HTTP API (`POST https://api.resend.com/emails`, 8 s timeout), the provider of the owner's other app, free tier 3 000 emails a month and 100 a day. Env: `RESEND_API_KEY` (secret) and `KB_CHAT_EMAIL_FROM` (a sender on a domain verified in Resend, e.g. `kb-chat <nao-responda@example.com>`). Without a key, a log adapter writes each message (code included) to the API log, for development only.
- The API refuses to start with `NODE_ENV=production` and no `RESEND_API_KEY` or `KB_CHAT_EMAIL_FROM`, or with the SMS log adapter.
- SMS: `KB_CHAT_SMS` = `off` (default) or `log` (development: the message goes to the API log). `GET /api/v1/auth/config` lists the code channels (`email`, plus `sms` when on); the web hides SMS otherwise. **SMS ships off in production: the owner must pick a provider** (below).
- The E2E server uses an in-memory outbox and reads it under `/api/e2e/outbox`, like its test identity (main never imports it).

**Fitness:** the route-coverage test lists the new public routes (sign-up, its verify, the Google request, code and code verify) and the master-only request routes.

## SMS research (2026-10-25, Firecrawl search)

No provider sends SMS to Brazilian numbers for free in production:

| Option | Free part | Why it does not fit |
|---|---|---|
| Firebase Phone Auth / Identity Platform | 10 SMS/day not billed, on the Blaze plan with a billing account | Billed per SMS beyond that (about US$ 0.05 in Brazil); runs in the browser with reCAPTCHA and Firebase's own session, not as a server send ([firebase.google.com/pricing](https://firebase.google.com/pricing), [blog.logto.io/firebase-authentication-pricing](https://blog.logto.io/firebase-authentication-pricing)) |
| Twilio trial | 100 SMS, 40 Verify checks | Sends only to up to 5 verified numbers ([twilio.com/docs/usage/trials](https://www.twilio.com/docs/usage/trials)) |
| Brazilian providers (Zenvia, Comtele, SMS Dev) | Test credits | Paid per message after the test ([comtele.com.br/sms-via-api](https://comtele.com.br/sms-via-api/), [zenvia.com/devs](https://zenvia.com/devs/)) |
| TextBelt | 1 SMS/day with the public key | A test, not a service ([textbelt.com](https://textbelt.com/)) |
| textbee.dev | 300 SMS/month through the owner's own Android phone and SIM | Needs a phone always on and the SIM's plan ([textbee.dev/blog/free-sms-gateway](https://textbee.dev/blog/free-sms-gateway)) |
| WhatsApp Cloud API (authentication template) | Platform access is free | About US$ 0.0068 per code in Brazil ([authgear.com/post/whatsapp-api-pricing](https://www.authgear.com/post/whatsapp-api-pricing/)) |
| Telegram Gateway | Free to the developer's own account | US$ 0.01 per delivered code ([core.telegram.org/gateway](https://core.telegram.org/gateway)) |

The owner picks one; the cheapest real options are WhatsApp authentication templates and Telegram Gateway (not SMS, and the person needs the app), then a Brazilian SMS provider. Adding it is one adapter of `SmsSenderPort` and an env value of `KB_CHAT_SMS`.

## Options considered

1. **Own one-time codes over Resend, SMS behind a port (chosen).** Free for email, no new runtime dependency, same sessions as Google.
2. **Firebase Authentication for email links and phone.** Another identity system next to ours, with Firebase sessions to map; phone is still paid.
3. **Magic links instead of codes.** Mail scanners may open the link and spend it; a code also works on another device.
4. **Reuse the Google ID token to create the request.** Would break ADR 0008's single-use credential rule; the signed ticket keeps it.

## Consequences

- Five new public routes, each rate-limited, all answering the same for every account state.
- New env vars: `RESEND_API_KEY` (secret), `KB_CHAT_EMAIL_FROM`, `KB_CHAT_SMS`, and `NODE_ENV=production` in the container (already set by the API image of ADR 0010). `deploy/compose.yml` and `deploy/scripts/deploy.sh` refuse to start without the first two; the owner creates the Resend account and verifies the sending domain (runbook, step 4b).
- Send limits and spent tickets live in memory: a restart resets them (the code's own attempt limit and lifetime stay on disk).
- `codes.json` keeps at most one live code per identifier and purpose; expired ones are dropped on each write.
