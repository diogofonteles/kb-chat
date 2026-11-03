---
id: KBC-067
title: "Propor com IA as faixas de pergunta e resposta, os títulos e quem fala, para uma pessoa revisar antes de aprovar"
status: ready
slice: phase-2-editing
outcome: editar uma palestra de 1 h em faixas cai de ≈ 15 minutos (à mão) para ≤ 5 minutos de revisão, com ≥ 80 % das faixas propostas aceitas sem mudar os limites, a ≤ US$ 0,05 por hora de áudio
depends_on: [KBC-063, KBC-066]
---

# KBC-067 — Propor faixas, títulos e falantes com IA

## Story
Como quem edita, quero que a IA leia a transcrição com as vozes e já proponha as faixas (cada pergunta com a sua resposta), um título para cada uma e quem está perguntando e respondendo, usando o que o sistema já sabe do acervo, para eu só revisar e aprovar.

## Scope
**In:** permissão nova `media-edit-ai` ("Propor faixas com IA"); botão "Propor faixas com IA" no fluxo "Preparar áudio" (T20, KBC-066) com a estimativa de custo antes de rodar (no envio, a mesma escolha vem pelo KBC-072); cada janela analisada grava as suas faixas no rascunho assim que termina, para a lista da T20 crescer durante a análise; a análise (abordagem, modelo e prompt escolhidos no KBC-063) lê os segmentos com tempos e vozes e devolve faixas (limites por segmento, tipo, título ≤ 80 caracteres, quem pergunta, quem responde, confiança e o motivo); sugestão de nomes das vozes pelo contexto, sem biometria: o autor do áudio, os autores e falantes do acervo (KBC-049, KBC-065), vocativos e apresentações na fala ("Mestre, …", "meu nome é …"), quem fala mais e responde; a proposta entra no rascunho marcada "Proposta pela IA" e nada é aprovado sem uma pessoa; gasto no livro da mídia (ADR 0022 §7) com teto por análise.
**Out:** reconhecer pela voz (KBC-071); classificar por assunto (KBC-069); rodar sozinho no envio; aprovar sem revisão.

## Business rules
- BR-1: a IA só propõe; nada é cortado, aplicado ou mostrado a quem ouve antes de a pessoa validar no passo 3 "Validar faixas" (ouvir, arrastar início e fim, corrigir) e apertar "Aprovar faixas" (KBC-066 BR-1). As faixas propostas aparecem na barra do passo 3 marcadas "Proposta pela IA" (borda tracejada e selo em texto) até a pessoa mexer nelas ou aprovar.
- BR-2: a análise só roda a pedido de quem tem `media-edit-ai` e `media-edit` no acervo, nunca sozinha.
- BR-3: cada análise mostra a estimativa antes e reserva o valor no livro mensal da mídia; se a reserva passar do teto mensal (padrão US$ 10, ADR 0022) ou do teto por análise (padrão US$ 0,25), a análise não roda e a tela diz por quê. Padrões aprovados pelo dono em 2026-11-03.
- BR-4: os títulos seguem o estilo pedido: pt-BR, a pergunta resumida em forma de tema ou pergunta curta, sem inventar nome que não está na fala nem no acervo.
- BR-5: um nome sugerido para uma voz vem sempre com o motivo ("é o autor do áudio e responde 9 de 10 perguntas", "é chamado de «Mestre» na faixa 3"); quem pergunta da plateia nunca recebe nome de pessoa pela IA (KBC-065 BR-3).
- BR-6: rodar de novo substitui só as faixas ainda marcadas "Proposta pela IA"; faixas que a pessoa criou ou mudou ficam.
- BR-7: a transcrição só sai para o provedor de IA escolhido pelo master (como a IA da aplicação, ADR 0016); o áudio nunca sai.

## Functional requirements
- FR-1: `POST /api/v1/media/{id}/edit/proposals` deve estimar (`dryRun`) e rodar a análise; a resposta da execução é um trabalho com status, consultado pela tela. (BR-2, BR-3)
- FR-2: A análise deve enviar os segmentos em janelas com sobreposição quando a gravação passar do contexto do modelo, validar a saída por esquema (zod), corrigir limites para começos e fins de segmentos, descartar faixas inválidas ou sobrepostas e pedir de novo uma vez a janela que falhou. (BR-4)
- FR-3: A proposta deve entrar no rascunho janela a janela (cada janela grava as suas faixas ao terminar, sem duplicar na emenda), com as faixas e as sugestões de nomes das vozes (cada uma com motivo e botão "Aceitar"), sem tocar nas faixas da pessoa. (BR-1, BR-5, BR-6)
- FR-4: A tela deve mostrar o custo real ao fim ("Custou US$ 0,02") e o saldo do mês da mídia para masters.
- FR-5: Falha do provedor (erro, tempo esgotado, saída inválida duas vezes) deve terminar o trabalho como "Não foi possível propor", estornar a reserva não gasta e manter o rascunho intacto.

## Non-functional requirements
- NFR-1: custo ≤ US$ 0,05 por hora de áudio no modelo padrão, medido no livro da mídia nas 2 gravações de teste do KBC-063.
- NFR-2: ≥ 80 % das faixas propostas aceitas sem mudar os limites no gabarito do KBC-063 (limite certo = até 1 segmento de diferença).
- NFR-3: a análise de 1 h de áudio termina em ≤ 2 minutos.

## Acceptance criteria
- **AC-1** (FR-1, FR-3, BR-1): Given uma palestra com vozes separadas e o provedor stub, When quem edita clica "Propor faixas com IA" e confirma a estimativa, Then o rascunho ganha as faixas marcadas "Proposta pela IA", a tela mostra o custo real ("Custou US$ …", FR-4) e nada aparece para quem ouve.
- **AC-11** (BR-1, validação): Given 12 faixas propostas, When a pessoa arrasta o fim da faixa 2 e aprova no passo 3, Then só nesse momento as faixas passam a existir para quem ouve, a faixa 2 com o fim corrigido, e as não tocadas deixam de ser "Proposta pela IA".
- **AC-2** (BR-5, FR-3): Given o áudio do autor "Mestre Gabriel" e uma voz que responde 9 de 10 perguntas, When a proposta chega, Then a voz tem a sugestão "Mestre Gabriel" com o motivo, e as vozes da plateia ficam "Pergunta da plateia".
- **AC-3** (BR-3, limite): Given o mês da mídia com US$ 9,99 gastos e uma estimativa de US$ 0,02, When quem edita pede, Then a análise não roda e a tela diz "O teto mensal da mídia foi atingido".
- **AC-4** (BR-6): Given 3 faixas criadas pela pessoa e 9 propostas, When a análise roda de novo, Then as 3 da pessoa ficam iguais e só as 9 são trocadas.
- **AC-5** (FR-2, negativo): Given o stub devolvendo uma faixa que se sobrepõe a outra e uma com JSON inválido, When a análise roda, Then a sobreposta é descartada, a janela inválida é pedida de novo uma vez e o resultado é válido.
- **AC-6** (FR-5): Given o provedor fora do ar, When a análise roda, Then termina com "Não foi possível propor", a reserva é estornada e o rascunho fica como estava.
- **AC-7** (BR-2, permissão): Given quem tem `media-edit` sem `media-edit-ai`, When abre a edição, Then não vê o botão e a rota responde 403.
- **AC-8** (FR-2, limite): Given uma gravação de 2 h maior que o contexto do modelo, When analisada, Then as janelas se juntam sem faixa duplicada na emenda.
- **AC-9** (BR-4): Given a resposta do stub com um título de 140 caracteres e um nome de pessoa que não está na fala nem no acervo, When validada, Then o título é recusado e a faixa fica sem título para a pessoa escrever, e o nome não é sugerido.
- **AC-10** (BR-7): Given a análise, When as chamadas são inspecionadas no teste, Then só texto da transcrição sai; nenhum byte de áudio.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-4, AC-11 | integração com LLM stub + E2E | fixtures de segmentos e vozes |
| AC-3, AC-6 | integração | livro da mídia |
| AC-5, AC-8, AC-9 | unitário (validador e emenda de janelas, fast-check) | |
| AC-7 | integração | |
| AC-10 | integração | interceptar o cliente do provedor |
| NFR-1, NFR-2, NFR-3 | manual na validação local com o provedor real | gabarito do KBC-063 |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0016 (IA da aplicação), 0022 §7 (livro mensal da mídia) · Pesquisa: KBC-063 (abordagem, modelo, prompt e custo) · Tela T20 (a revisão das propostas é o passo 3 do fluxo, especificado no KBC-066)

## Decisão do dono (2026-11-03)
- **Teto e fonte da IA para propor faixas e títulos** — aprovado o padrão recomendado: usar o provedor da IA da aplicação escolhido pelo master (modelo barato e pago, não gratuito, porque o gratuito errou cobertura no KBC-030), com o gasto no livro mensal da mídia (US$ 10, o mesmo do Groq), teto de US$ 0,25 por análise e estimativa mostrada antes; se o KBC-063 mostrar um modelo local no Mac com qualidade parecida, ele vira o padrão (custo zero) e a API fica de reserva.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
