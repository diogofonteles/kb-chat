---
id: KBC-133
title: "Notificações no sino: áudio processado, faixas para validar, falhas e pedidos de acesso"
status: ready
slice: ui-v2-features
outcome: quem envia áudio ou administra pessoas fica sabendo do que precisa dele sem abrir cada tela; menos áudios parados esperando validação
depends_on: [KBC-125]
---

# KBC-133 — Notificações

## Story
Quando um áudio que enviei termina de processar, ou alguém pede acesso, quero ver isso no sino da barra superior, para agir na hora sem ficar conferindo a Fila e Pessoas.

## Scope
**In:** sino na barra superior com o ponto verde de não lidas; painel (popover no desktop, tela no celular) com a lista do mais novo para o mais antigo, cada uma com ícone, texto, quando e a ação que leva ao lugar certo; marcar como lida ao abrir o item e "Marcar todas como lidas"; eventos: áudio processado (transcrição pronta), faixas para validar, processamento que falhou, pedido de acesso novo (masters com a permissão de pessoas); entrega em tempo real enquanto o app está aberto.
**Out:** e-mail e push do sistema; notificação de autor seguido (vem no KBC-135); preferências por tipo (Release 2).

## Business rules
- BR-1: cada notificação é de uma pessoa: o processamento notifica quem enviou a mídia; pedido de acesso notifica os masters que podem aprovar.
- BR-2: uma notificação só é mostrada se a pessoa ainda pode ver o alvo agora (acesso e nível de hoje, KBC-110); senão some da lista.
- BR-3: notificações ficam 30 dias; depois são apagadas.
- BR-4: o mesmo evento não gera duas notificações (ex.: reprocessar não duplica "pronta" se a anterior não foi lida; atualiza o horário).

## Functional requirements
- FR-1: a API deve guardar notificações por pessoa e expor `GET /api/v1/notifications` (paginado, com contagem de não lidas) e `POST /api/v1/notifications/read` (uma, várias ou todas), com schemas no `@kb-chat/contracts`. (BR-1, BR-3)
- FR-2: os eventos de mídia (pronta, faixas para validar, falha) e de acesso (pedido novo) devem criar a notificação no mesmo ponto em que hoje mudam de estado. (BR-1, BR-4)
- FR-3: o web deve receber notificações novas sem recarregar (pelo canal de eventos já usado pelo app, ou por consulta a cada 60 s se não houver) e acender o ponto do sino. (BR-2)
- FR-4: abrir uma notificação deve marcá-la como lida e navegar ao alvo (mídia, faixas, fila, Pessoas). (BR-2)

## Non-functional requirements
- NFR-1: uma notificação aparece em ≤ 5 s depois do evento com o app aberto.
- NFR-2: `GET /api/v1/notifications` responde em p95 ≤ 100 ms com 1.000 notificações da pessoa.
- NFR-3: axe sem violação séria no painel; o sino anuncia "N notificações não lidas".

## Acceptance criteria
- AC-1 (FR-2, FR-3, BR-1): Given Ana enviou um áudio, When a transcrição fica pronta, Then em até 5 s o sino de Ana acende e o painel mostra "Transcrição pronta: <título>"; o Dono, que não enviou, não recebe.
- AC-2 (FR-4): Given a notificação de faixas para validar, When Ana a abre, Then vai à tela de faixas da mídia e a notificação fica lida.
- AC-3 (BR-1): Given um pedido de acesso novo, When chega, Then os masters com a permissão de pessoas recebem; um membro não.
- AC-4 (BR-2, negativo): Given uma notificação de uma mídia cujo acesso Ana perdeu, When ela abre o sino, Then a notificação não aparece.
- AC-5 (BR-4): Given "Transcrição pronta" não lida, When a mídia é transcrita de novo, Then continua uma só notificação, com o horário novo.
- AC-6 (BR-3): Given uma notificação de 31 dias, When a limpeza roda, Then ela some.
- AC-7 (FR-1): Given 3 não lidas, When Ana usa "Marcar todas como lidas", Then o ponto apaga e a contagem vira 0 em outro navegador da mesma conta.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-7 | E2E | Transcritor stub |
| AC-3 | integração (API) | Papéis |
| AC-4 | integração | Níveis (KBC-103) |
| AC-5, AC-6 | unitário + integração | Relógio falso |
| NFR-2 | integração com medição | 1.000 notificações |

## References
Figma: barra superior em [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) (sino com o ponto) · Plano: `docs/design/redesign-v2.md` · `docs/product/spotify-funcionalidades-desejaveis.md` (Notificações) · KBC-090 (fila), KBC-014 (pedidos)

## Decisões assumidas (o dono pode mudar)
- Só no app (sem e-mail nem push), 30 dias de guarda, sem preferências por tipo nesta versão.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
