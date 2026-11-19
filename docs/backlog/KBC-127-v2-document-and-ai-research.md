---
id: KBC-127
title: "Redesign v2: documento como página e Pesquisa com IA com a fonte aberta ao lado (460) ou em folha de leitura (85%)"
status: ready
slice: ui-v2-areas
outcome: quem pesquisa confere a fonte citada sem perder a resposta; mais respostas da IA levam à leitura do documento
depends_on: [KBC-125]
---

# KBC-127 — Documento e Pesquisa com IA v2

## Story
Como quem pesquisa com IA, quero clicar numa citação e ler o trecho ao lado da resposta, já destacado, para conferir sem perder o fio; como quem lê, quero o documento numa página com o que importa à mão.

## Scope
**In:** documento como página (cabeçalho com capa, "Perguntar à IA", ocorrências "1 de N" ‹ ›, texto com a marca, painel "Sobre este documento" com autoria, assuntos, Veja também e cópias), carregando e erro; Pesquisa com IA: pergunta em balão, passos recolhíveis, resposta com citações [n], fontes em tabela, rodapé de modelo e custo, respondendo (esqueleto e Parar), erro, interrompida, varredura incompleta com cobertura e "Continuar varredura", perfis; fonte aberta no painel direito de 460 (Fonte ‹ ›, Próximo trecho, Abrir documento, Copiar trecho, tela cheia) e, no celular, folha de leitura de 85% com abas Fonte 1…n; modais Novo/Editar acervo (capa, nome, autores, principal) e nome inválido.
**Out:** página do assunto com prateleiras (KBC-137); compartilhar trecho (KBC-136).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: clicar numa citação ou num cartão de fonte abre a fonte já posicionada no trecho citado, com o trecho destacado; a resposta continua visível à esquerda (desktop) ou por baixo da folha (celular).
- BR-5: a fonte aberta respeita o nível e o acesso de hoje; uma fonte que saiu do acesso mostra a máscara do KBC-110 em vez do texto.

## Functional requirements
- FR-1: o painel de fonte (460) deve abrir pela citação [n] ou pelo cartão de fonte, rolar até o trecho e destacá-lo; "Fonte ‹ ›" troca entre as fontes da resposta e "Próximo trecho" vai à próxima ocorrência citada. (BR-4)
- FR-2: no celular, a mesma ação deve abrir uma folha de 85% com abas por fonte; arrastar para baixo ou Esc fecha e devolve o foco à citação. (BR-3, BR-4)
- FR-3: o documento como página deve ter as ocorrências ‹ › e o painel "Sobre este documento", com os mesmos dados do painel da v1. (BR-1)
- FR-4: a varredura incompleta deve mostrar o cartão de cobertura (documentos analisados de N) e "Continuar varredura" como na v1 (KBC-030). (BR-1)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.
- NFR-4: abrir a fonte pela citação mostra o trecho em ≤ 500 ms com o documento já em cache, medido no E2E.

## Acceptance criteria
- AC-1 (FR-1, BR-4): Given uma resposta com [1] e [2], When a pessoa clica [2], Then o painel abre na fonte 2 com o trecho destacado e visível, e a citação [2] fica ativa.
- AC-2 (FR-1): Given a fonte 2 aberta, When a pessoa usa "Fonte ‹", Then vai para a fonte 1 no trecho dela.
- AC-3 (FR-2): Given 390 px, When toca [1], Then a folha de 85% abre na aba Fonte 1; When arrasta para baixo, Then volta à resposta com o foco em [1].
- AC-4 (BR-5, negativo): Given uma conversa antiga cuja fonte saiu do nível da pessoa, When ela clica a citação, Then vê a máscara "fonte fora do seu acesso" e não o texto.
- AC-5 (FR-3): Given um documento com 2 ocorrências, When a pessoa usa ›, Then vai para "2 de 2" e o trecho é destacado.
- AC-6 (FR-4): Given uma varredura parada em 10 de 22, When a resposta aparece, Then o cartão mostra "10 de 22" e "Continuar varredura" retoma sem repetir.
- AC-7 (estados): Given respondendo, erro, interrompida, documento carregando e com erro, e o modal de acervo com nome inválido, When cada um renderiza, Then bate com o frame (captura) e a ação do estado funciona.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-3, AC-5 | E2E | Resposta de fixture com 2 fontes |
| AC-4 | integração + E2E | Conta com nível baixo |
| AC-6 | E2E | Varredura simulada |
| AC-7 | E2E + captura | 1440 e 390 |
| NFR-4 | E2E com medição | |

## References
Figma: [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) (Pesquisa com IA com a fonte aberta, Documento), [v2 · Conversa](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=376-2) (`chat-document*`, `chat-research*`, `chat-collection*`) · Plano: `docs/design/redesign-v2.md` · Telas v1: T3, T4 · KBC-003, KBC-008, KBC-030, KBC-110

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
