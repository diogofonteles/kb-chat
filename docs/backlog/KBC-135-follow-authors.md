---
id: KBC-135
title: "Seguir autor: \"Seguir\" em \"Sobre a autora\" e na página do autor, novidades na home e no sino"
status: ready
slice: ui-v2-features
outcome: quem estuda um autor fica sabendo das gravações novas dele sem procurar
depends_on: [KBC-059, KBC-133, KBC-129]
---

# KBC-135 — Seguir autor

## Story
Como quem estuda a Irmã Helena Prado, quero seguir a autora e ser avisado quando sair uma gravação nova dela nos meus acervos, para não perder nada.

## Scope
**In:** botão **Seguir / Seguindo** no painel "Sobre a autora" (Tocando agora, KBC-129) e na página do autor (KBC-059); lista "Autores que você segue" em Configurações › Preferências com deixar de seguir; notificação (KBC-133) quando uma mídia nova do autor fica disponível para a pessoa; prateleira "Novidades de quem você segue" na home da Conversa quando houver.
**Out:** seguir autores de documentos de texto; e-mail; contagem pública de seguidores.

## Business rules
- BR-1: seguir é da conta e é privado: ninguém vê quem segue quem.
- BR-2: a novidade só vale para mídias que a pessoa pode ver hoje (acervo, permissão `media-library`, nível); uma mídia restrita não gera notificação.
- BR-3: "nova" = a mídia ficou disponível (transcrição pronta ou publicada) depois que a pessoa passou a seguir; uma mídia gera no máximo uma notificação por pessoa.
- BR-4: só quem tem `media-library` vê o botão Seguir.

## Functional requirements
- FR-1: a API deve guardar quem a pessoa segue (`PUT/DELETE /api/v1/authors/:id/follow`, `GET /api/v1/me/following`). (BR-1, BR-4)
- FR-2: quando uma mídia fica disponível, a API deve criar a notificação "Nova gravação de <autor>: <título>" para quem segue e pode ver. (BR-2, BR-3)
- FR-3: a home deve mostrar a prateleira "Novidades de quem você segue" com até 10 mídias dos últimos 30 dias, só no acervo com áudio. (BR-2)

## Non-functional requirements
- NFR-1: criar as notificações de uma mídia nova para 500 seguidores leva ≤ 1 s (uma escrita em lote).
- NFR-2: axe sem violação séria; o botão anuncia "Seguir <autor>" e o estado (aria-pressed).

## Acceptance criteria
- AC-1 (FR-1): Given o painel Sobre a autora, When a pessoa toca Seguir, Then o botão vira "Seguindo" e a autora aparece em "Autores que você segue" em outro navegador.
- AC-2 (FR-2, BR-3): Given Ana segue a Irmã Helena, When uma gravação nova dela fica pronta, Then Ana recebe "Nova gravação de Irmã Helena Prado: <título>"; uma gravação antiga não gera notificação.
- AC-3 (BR-2, negativo): Given a gravação nova acima do nível de Ana, When fica pronta, Then Ana não recebe nada e a prateleira não mostra a gravação.
- AC-4 (BR-4, negativo): Given uma pessoa sem `media-library`, When abre a página do autor, Then não há botão Seguir.
- AC-5 (FR-3): Given 2 gravações novas de autores seguidos, When a home abre no acervo com áudio, Then a prateleira mostra as 2; no acervo só de textos, a prateleira não aparece.
- AC-6 (deixar de seguir): Given Ana deixa de seguir, When sai uma gravação nova, Then não recebe nada.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-5 | E2E | |
| AC-2, AC-3, AC-6 | integração (API) | Níveis e relógio |
| AC-4 | E2E | Conta sem a permissão |
| NFR-1 | integração com medição | 500 seguidores |

## References
Figma: "Sobre a autora" com Seguir em [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) (Player) · Plano: `docs/design/redesign-v2.md` · KBC-059 (página do autor), KBC-133 (notificações)

## Decisões assumidas (o dono pode mudar)
- O KBC-059 deixou "seguir" fora ("sem feed de novidades num acervo fechado"); a v2 desenhou o botão. Este item traz seguir só para autores de mídia, privado, com aviso no sino. Se o dono mantiver a decisão do KBC-059, este item é descartado e o botão sai do painel.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
