# 0017 — AI keys sealed at rest with a server master key

- Status: accepted (2026-10-26)
- Amends: [0007](0007-ai-providers-and-local-settings.md) (keys were plain text in owner-only files)
- Drivers: KBC-022 (production with invited people's keys and the house key on one VM), Q-security, ADR 0010 (encrypted backups, automatic rollback)

## Context

ADR 0007 kept each principal's provider keys in plain text in `settings/<principal>.json` (0600), acceptable for one local user. With KBC-022 the VM holds every invited person's own keys, the house OpenRouter key, an optional OpenRouter management key and keys provisioned per person. A copy of the state folder (a backup, a support bundle, a mistaken `scp`) must not hand those keys out.

## Decision

- **Cipher.** AES-256-GCM, a random 12-byte IV per value, the 16-byte tag; stored as `enc:v1:<iv>.<tag>.<ciphertext>` (base64url). The **associated data** is the value's place: `settings:<principal>:<provider>`, `house:connection`, `house:management`, `house:person:<id>`; a sealed value copied to another place does not open.
- **Master key.** 32 random bytes in base64 in `KB_CHAT_SECRETS_KEY`, generated once on the VM with `openssl rand -base64 32` written straight to `deploy/.env` (never echoed; runbook step 5). Production (`NODE_ENV=production` or a non-loopback `HOST`) refuses to start without a valid one; `deploy.sh` and the compose file refuse too. In development, without the variable, the API creates `<KB_CHAT_STATE_DIR>/secrets.key` (0600) once.
- **Where.** `SealedSettingsStore` wraps the settings store: seals on write, opens on read. A plain value (a file from before) is accepted once and the file is rewritten sealed at once. A value that does not open (another master key, another place) is dropped with a warning naming only the provider; the person sees no saved key and connects again. The house service seals its own keys the same way.
- **Never out.** Keys never reach a response (only `last4`), a log line or an argv; the state backup (ADR 0010) never contains the master key, which lives only in `.env`.

## Options considered

1. **AES-GCM with a master key in the environment (chosen).** No new dependency, unattended restarts and rollbacks keep working.
2. **A passphrase typed at boot.** Breaks automatic restarts and ADR 0010's rollback.
3. **A cloud KMS (OCI Vault).** Stronger custody, but a paid service beyond the Always Free allowance for this use and a network dependency at every start.
4. **Plain text, 0600 (ADR 0007).** Any copy of the state folder leaks every key.

## Consequences

- Good: a copy of the state folder alone gives no key; the encrypted backup is now doubly protected.
- Bad: losing `KB_CHAT_SECRETS_KEY` makes every saved key unreadable: people and the master connect again. The runbook asks the owner to keep a copy in a password manager.
- Bad (rollback): the first start of this release seals every plain key. Rolling back past it (ADR 0010's `rollback.sh`) runs an API that reads the sealed text as the key: own keys and the house key fail with "chave não aceita" until people reconnect, or until the pre-deploy state backup is restored. The runbook's rollback step says so.
- Rotation: `enc:v1` has no key id. Rotating the master key means re-entering the keys (people reconnect) or a one-off re-seal script that opens with the old key and seals with the new one, run with both keys; written when first needed (`enc:v2` would then carry a key id).
- Revisit when: the app holds more than a handful of people's keys, a backup leaves the owner's tenancy, or OCI offers a free KMS tier fit for this.
- Compliance: tests read the settings and house files, the log and every response for the plain key; a value sealed for one place does not open in another; production refuses without the key.
