---
id: KBC-047
title: "Grupos de pessoas: dar permissões e acervos a um grupo, e quem entra no grupo herda tudo"
status: draft
slice: backlog
outcome: o master libera uma funcionalidade nova (por exemplo, "Ouvir mídia") para um grupo inteiro numa ação só, e cada pessoa que entra no grupo já recebe o que o grupo tem
depends_on: [KBC-028]
---

# KBC-047 — Grupos de pessoas com permissões

## Story
Como master, quero criar grupos (por exemplo, "Estudantes do núcleo") com permissões e acervos, para liberar uma funcionalidade nova a todos de uma vez e não repetir a escolha pessoa por pessoa.

## Scope
**In:** criar, renomear e apagar grupos; permissões e acervos do grupo; pôr e tirar pessoas; a pessoa tem a soma do que é dela e do que vem dos grupos; "Pessoas e permissões" mostra de onde vem cada permissão.
**Out:** grupos dentro de grupos; grupos geridos por quem não é master.

## Business rules
- BR-1: regra do dono (2026-10-28): toda funcionalidade é liberada por pessoa ou por grupo; nenhuma liga para todos sozinha.

## Open questions
- Os perfis de convite (KBC-028) já cobrem o uso pretendido, aplicados em lote, ou o dono quer grupos vivos (mudar o grupo muda os membros)? — owner: dono
- Tirar uma pessoa do grupo tira o que veio só do grupo, mesmo que ela use agora? — owner: dono
- Um grupo pode ter acervo padrão e IA (como os perfis)? — owner: dono

## Definition of ready
- [ ] Story, scope and outcome stated
- [ ] Every BR and FR covered by at least one AC; negative and edge cases present
- [ ] NFRs measurable or explicitly none
- [ ] Test level chosen for every AC
- [ ] UI and architecture references linked
- [ ] Dependencies done or scheduled; no open questions
- [ ] Fits one goal
