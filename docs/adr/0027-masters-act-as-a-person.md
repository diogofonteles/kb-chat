# 0027 — Masters act as a person, audited

- Status: accepted (2026-11-03), to be implemented by KBC-060
- Amends: [0008](0008-google-login-and-permissions.md) ("nobody sees another person's content")
- Drivers: the owner's requirement (2026-11-03): a master must be able to use the app as any other person, to see what they see, fix their settings and reproduce the bugs they report; Q-security, Q-privacy (LGPD transparency)

## Context

ADR 0008 keeps every person's content (history, settings, bookmarks, positions) private: a master grants collections and features but never sees another person's content. Support needs the opposite in a controlled way: when a person reports "the player does not show my bookmarks" or "my AI does not answer", the master has to see that person's screen with that person's data and permissions, and sometimes change a setting for them. Asking for screenshots, or for the person's Google account, is slow and unsafe.

## Decision

**Act as a person ("Ver como"), a layer on the master's own session, never a second login.**

- A new grant, **"Ver como outra pessoa"**, held by the owner and given by the owner to a master, one by one; it is not one of the features a master holds by being a master (the owner's rule: every capability is granted per person).
- The master starts it from "Pessoas e permissões" with a reason (free text, required, kept in the audit). The session gets an `actingAs` principal; the master's own session stays the one in the cookie. Every request then runs with the person's principal, collections, features and data, and with the person's role (a member's view never has master powers).
- **Limits:** the owner and masters cannot be acted as (no escalation and no hiding behind another master); it lasts at most 30 minutes, ends on "Voltar para a minha conta", on sign-out, and when either side loses access; one person at a time.
- **What stays the person's alone:** signing in or out for them, their Google account or e-mail, their own AI keys (they cannot be seen, replaced or removed; the masked state is shown), subscriptions they connected, deleting their account, and spending their money (AI calls with their own key are refused with a clear message; the app's AI under the house plan follows the person's plan and counts against it as usual).
- **Always visible:** a fixed banner on every page, "Você está vendo como <nome> · termina em 29:41 · Voltar para a minha conta", announced to screen readers, in a color that no other banner uses.
- **Audited:** start, end and every write while acting are recorded with the real actor (the master), the effective principal, the reason, the route and the time, in an append-only audit file in the state directory, written before the request runs (a streamed answer included); reads are not recorded one by one. Masters with the grant see the audit in "Pessoas e permissões"; it is kept 12 months.
- **Transparent to the person:** "Configurações → Acessos à sua conta" lists every time someone acted as them (who, when, how long, the reason); the privacy policy says that masters may act as a person to help them, and how it is recorded.

## Options considered

1. **Act-as layer on the master's session, audited (chosen).** One login, revocable, every effect attributable to the master, and visible to the person.
2. **Read-only "view as".** Safer, but the owner asked to fix settings for the person; a read-only mode can come back as a narrower grant if needed.
3. **Signing in with the person's account or a magic link.** Leaks credentials or bypasses the person's Google sign-in; no attribution.
4. **Screenshots and logs only.** No access risk, but slow and often not enough to reproduce a bug.

## Consequences

- Every route keeps reading "the principal" as today; the guard resolves it from `actingAs` when present, so permission checks stay in one place. Routes that must stay the person's alone carry `config.access.notWhileActing: true` and answer 403 `NOT_WHILE_ACTING`.
- Content written while acting (a note, a setting) belongs to the person and is marked in the audit; the person sees it in "Acessos à sua conta".
- The audit file is personal data: it is covered by the data policy (deletion of a person's data keeps the audit lines needed for accountability for 12 months, with the reason).
