---
id: KBC-132
title: "Redesign v2: Configurações de administração e mídia — Pessoas em tabela, modais com abas, IA da aplicação, Auditoria, Transcritores, Termos, Groq e Perfis de voz"
status: ready
slice: ui-v2-areas
outcome: o master administra pessoas, IA e transcrição com menos rolagem e menos erro (confirmações claras, ações destrutivas separadas)
depends_on: [KBC-131]
---

# KBC-132 — Configurações v2 (administração e mídia)

## Story
Como master, quero ver as pessoas numa tabela, aprovar pedidos em cartões e editar cada pessoa num modal com abas, para administrar sem rolar uma lista infinita dentro de um modal.

## Scope
**In:** Pessoas e permissões (convite em barra com perfil e "Configurar agora", perfis de convite recolhíveis, solicitações pendentes em cartões com Aprovar e Recusar, IA para várias pessoas, tabela de pessoas com seleção e ⋯); recusar pedido e revogar em modal de confirmação; editor de pessoa, convite configurado e perfil de convite em modal largo com abas (Acessos · IA e limites · Preferências iniciais), incluindo master e ceder a assinatura; Ver como em modal com motivo obrigatório; Auditoria do Ver como em tabela com filtro; IA da aplicação (conta, modelos gratuitos, reserva, para quem, Codex, chave de gestão, não conectada); Transcritores (parear, recém-pareado com comando e token, tabela, revogar, faixas que já existem); Termos (medidor, adicionar, termos em chips com ✕, versões, aprendido, acima do limite); Groq (conexão, cartões de quando usar, gasto e teto, inválidos); Perfis de voz (vazio, aviso, consentimento em modal largo); versões em folha no celular.
**Out:** regras de pessoas, níveis, IA e transcrição (iguais à v1).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: ações destrutivas (Revogar acesso, Remover master, Revogar transcritor, Recusar pedido, Remover chave) ficam separadas à esquerda do rodapé ou pedem confirmação em modal; nunca ficam ao lado da ação principal com o mesmo peso.
- BR-5: mudanças no editor de pessoa continuam salvando ao mudar, como na v1 (sem botão Salvar novo).

## Functional requirements
- FR-1: a tabela de pessoas deve mostrar pessoa (com Master e Dono em pill), acervos e IA, gasto de hoje e situação, com seleção para a IA em lote. (BR-1)
- FR-2: o editor de pessoa deve abrir em modal com as abas Acessos e IA e limites; no celular, em folha alta. (BR-3, BR-5)
- FR-3: os termos devem aparecer em chips removíveis e o medidor deve ficar vermelho e bloquear "Salvar lista" acima do limite do transcritor. (BR-1)
- FR-4: recusar pedido e revogar transcritor devem pedir confirmação em modal (folha baixa no celular), com o texto da v1. (BR-4)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.
- NFR-4: a tabela de pessoas com 500 pessoas abre em ≤ 1 s e filtra sem travar (INP ≤ 200 ms), na linha do KBC-109.

## Acceptance criteria
- AC-1 (FR-1): Given 12 pessoas de fixture, When Pessoas abre, Then a tabela mostra as 12 com pills, situação e último acesso, como no frame (captura).
- AC-2 (FR-4, BR-4): Given o pedido de Bruno Lima, When o master toca Recusar, Then um modal pergunta "Recusar a solicitação de Bruno Lima?" com "A pessoa só poderá pedir de novo em 24 horas."; Cancelar não muda nada.
- AC-3 (FR-2, BR-5): Given o editor de Ana Souza na aba Acessos, When o master desmarca Hermetismo, Then a mudança salva sozinha e a tabela atualiza ao fechar.
- AC-4 (editor master): Given o editor do Dono, When abre, Then o aviso "Masters veem todos os acervos…" aparece, as caixas ficam desabilitadas e só há "Remover master" no rodapé.
- AC-5 (ceder): Given o convite com "Assinatura do Claude (sua)", When o master não confirma o aviso, Then "Convidar" fica desabilitado com "Confirme ou cancele a cessão…".
- AC-6 (FR-3): Given 72 termos acima do limite, When a tela abre, Then o medidor fica vermelho, "Salvar lista" desabilitado e "Descartar mudanças" disponível.
- AC-7 (Ver como): Given o modal Ver como com motivo "ok", When o master confirma, Then aparece "Escreva o motivo (pelo menos 3 letras)." e nada começa.
- AC-8 (estados): Given IA da aplicação não conectada, transcritor recém-pareado, Groq com horas e teto inválidos e o consentimento de perfil de voz, When renderizam, Then batem com os frames e as validações da v1 aparecem.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-8 | E2E + captura | Fixtures de pessoas e mídia |
| AC-2, AC-3, AC-4, AC-5, AC-7 | E2E | Conta master e o Dono |
| AC-6 | componente + E2E | 72 termos semeados |
| NFR-4 | E2E com medição | 500 pessoas semeadas |

## References
Figma: [v2 · Configurações](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=380-2) (`settings-people*`, `settings-invite*`, `settings-act-as*`, `settings-audit`, `settings-house*`, `settings-transcribers*`, `settings-terms*`, `settings-groq*`, `settings-voice-profile*`) · Plano: `docs/design/redesign-v2.md` · Telas v1: T9, T12, T20 (Perfis de voz), T21, T24 · KBC-010, KBC-022, KBC-028, KBC-040, KBC-071, KBC-109

## Decisões assumidas (o dono pode mudar)
- Termos em chips em vez de campos (editar = remover e adicionar). Abas no editor de pessoa.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
