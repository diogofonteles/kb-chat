---
id: KBC-112
title: "A análise de faixas pela IA nunca gasta mais do que o valor aceito: para no valor e diz quanto falta"
status: ready
slice: phase-2-editing
outcome: o gasto real de uma análise de faixas pela IA nunca passa do valor que a pessoa aceitou na tela (hoje o QA mediu até 2x quando uma janela é perguntada de novo); meta 0 corridas com gasto acima do aceito no livro da mídia
depends_on: [KBC-067, KBC-072, KBC-097]
---

# KBC-112 — A análise de faixas pela IA nunca gasta mais do que o valor aceito

Origem: BUG-2 do QA do KBC-097 (gasto acima do valor mostrado quando uma janela é perguntada de novo), deixado para o dono no PR do KBC-097 (`work/archive/kb-chat-097/qa.md`, rodadas 1 a 3, e `pr.md`, "Em aberto (decisão do dono)", no checkout principal). Decisão do dono em 2026-11-07 (conversa): aprovada a opção recomendada, **limitar a corrida ao valor aceito**: a corrida para antes de gastar acima dele e diz isso; uma janela perguntada de novo conta para o limite.

## Story
Como quem prepara um áudio, quero que a análise da IA nunca gaste mais do que o valor que aceitei, para confiar no número que a tela me mostra antes de pagar.

## Contexto (o que existe hoje)
- A estimativa conta uma passada por janela. Uma resposta ilegível faz a janela ser perguntada mais uma vez (`window-runner.ts`, `ATTEMPTS = 2`), e um stream que quebra depois de começar também é cobrado. O gasto real pode passar do valor mostrado (o QA mediu até 2x).
- `acceptedUsd` (KBC-097) só é conferido na partida (`proposal-service.ts`, 409 `estimate-rose`); depois dela, só o teto por análise (`MEDIA_AI_RUN_CAP_USD`, padrão US$ 0,25, somado sobre as tentativas da análise, KBC-072 BR-6) e o teto mensal da mídia (US$ 10) limitam.
- No envio guiado (KBC-072), a escolha "Propor com IA" leva o valor estimado pela duração; a corrida parte se a estimativa real não passar de 1,25x esse valor (`ESTIMATE_TOLERANCE`).
- A tela mostra o valor com até 3 casas (`Intl.NumberFormat`, arredondamento comum): US$ 0,0234 aparece como "US$ 0,023".
- A análise usa a conta OpenRouter da casa ligada por um master (`mediaLlm`, ADR 0016, ADR 0029 §7) e lança no livro da mídia; não há hoje análise de faixas paga pela IA própria de uma pessoa.

## Scope
**In:** o limite da corrida (partida pelo botão, "Tentar de novo"/continuar, recomeço e a corrida do envio guiado); a parada antes da chamada que passaria do limite; o estado "parou no valor aceito" com o que ficou pronto e quanto custa continuar; o arredondamento da tela para cima; o texto da estimativa; o livro da mídia nunca fecha uma corrida acima do aceito.
**Out:** incluir a repetição na estimativa (opção não escolhida); mudar o teto por análise ou o mensal; sugestões de assunto (KBC-069) e outras chamadas de IA da mídia (item próprio se tiverem o mesmo padrão); a pesquisa com IA (KBC-008, que tem as próprias regras de custo).

## Business rules
- BR-1: cada corrida de propostas tem um **limite** igual ao valor aceito por quem a iniciou (`acceptedUsd`, comparado exato, sem tolerância). A soma do que a corrida gasta (toda chamada ao modelo, incluindo a pergunta de novo de uma janela e o stream cobrado que quebrou) nunca passa do limite.
- BR-2: antes de cada chamada, se o gasto da corrida mais o teto da chamada (`callCeiling`, o pior caso de entrada e saída) passaria do limite, a chamada não é feita: a corrida para com a falha `accepted-limit`. As janelas já prontas ficam gravadas como numa corrida que falhou (KBC-097): nada se perde e a retomada pergunta só as que faltam.
- BR-3: uma janela perguntada de novo conta para o limite como qualquer chamada; se a segunda pergunta não cabe, a corrida para em `accepted-limit` (não em `invalid-output`) e a janela fica por fazer.
- BR-4: "Tentar de novo" e continuar são corridas novas com o seu próprio valor aceito (o que a tela mostrou para as janelas que faltam). O que tentativas anteriores gastaram não consome o valor aceito da nova; o teto por análise (KBC-072 BR-6) continua somado sobre todas as tentativas, e vale o que for menor: `acceptedUsd` ou o que resta do teto por análise.
- BR-5: um recomeço (`restarts`, KBC-097) paga de novo as janelas feitas; o valor aceito cobre a corrida inteira, e a tela já diz isso antes (texto do KBC-097).
- BR-6: no envio guiado (KBC-072), o valor aceito é o máximo que a pessoa viu: a estimativa pela duração vezes a tolerância (1,25). A tela do envio mostra esse máximo ("no máximo US$ 0,030"), e esse é o limite da corrida. Se a estimativa real passa dele, a preparação para em `estimate-rose` como hoje.
- BR-7: arredondamento: o limite é o número exato aceito; a tela mostra estimativas e máximos **arredondados para cima** na casa mostrada (3 casas), para o valor mostrado nunca ficar abaixo do limite (US$ 0,0234 → "US$ 0,024"). Gasto já feito continua com o arredondamento comum.
- BR-8: o limite vale para qualquer conta que pague a análise. Hoje é só a conta da casa (livro da mídia); se um item futuro deixar a IA própria de uma pessoa pagar a análise, o mesmo limite vale e o gasto vai para o livro dessa conta, nunca para os dois.
- BR-9: o livro da mídia reserva o valor aceito e fecha a corrida com o gasto real, que é sempre ≤ o aceito; a diferença volta (como o reembolso de hoje).
- BR-10: sem `acceptedUsd` no pedido (cliente antigo), o limite é a estimativa calculada no servidor na partida; o servidor nunca roda sem limite.

## Functional requirements
- FR-1: `WindowRunner` deve receber o limite da corrida (`limitUsd = min(acceptedUsd, runCap − carried)`) e, antes de cada chamada, recusar a que poderia passar dele com `ProposalStop('accepted-limit')`. (BR-1 a BR-4)
- FR-2: `proposalFailureSchema` (`libs/contracts`, `track-proposals.ts`) e as falhas da preparação (`media-preparation.ts`) devem ganhar `accepted-limit` (aditivo). (BR-2)
- FR-3: o estado da corrida que parou no limite deve trazer `spentUsd`, `windowsDone`, `windowsTotal` e a estimativa de continuar; a tela de faixas (T20, passo 3) deve dizer "A análise parou no valor aceito (US$ 0,024): 7 de 9 janelas prontas. Continuar custa cerca de US$ 0,006." com **Tentar de novo** (que pede um novo aceite, KBC-097). (BR-2, BR-4)
- FR-4: o texto da estimativa deve dizer o limite: "Custa até US$ 0,024. Se a IA precisar perguntar de novo alguma parte, a análise para nesse valor e você decide se continua." (BR-1, BR-7)
- FR-5: o envio guiado deve mostrar o máximo ("Estimativa: cerca de US$ 0,024, no máximo US$ 0,030, descontado do limite mensal da mídia") e enviar o máximo como valor aceito da corrida. (BR-6, BR-7)
- FR-6: o servidor deve calcular o limite na partida quando o pedido não traz `acceptedUsd`. (BR-10)
- FR-7: a reserva e o fechamento no livro da mídia devem usar o limite; um fechamento acima do limite é um erro de programação registrado no log, e o lançamento é limitado ao aceito. (BR-9)

## Non-functional requirements
- NFR-1: nenhuma corrida fecha no livro com gasto acima do aceito: teste de propriedade com 200 corridas sintéticas (respostas ilegíveis, streams quebrados, preços com até 6 casas).
- NFR-2: a conferência antes da chamada não acrescenta chamada de rede nem leitura de banco (custo de CPU desprezível, sem mudança no p95 da janela).

## Acceptance criteria
- **AC-1** (BR-1, BR-3, FR-1): Given uma análise de 3 janelas com valor aceito igual à estimativa e o modelo falso que responde ilegível na primeira pergunta da janela 2, When a corrida roda, Then a segunda pergunta da janela 2 só é feita se couber no limite; o gasto total fechado no livro é ≤ o aceito.
- **AC-2** (BR-2, BR-3, FR-3): Given o mesmo cenário em que a pergunta de novo não cabe, Then a corrida para em `accepted-limit`, as faixas da janela 1 ficam no rascunho, a janela 2 e a 3 ficam por fazer e a tela diz "A análise parou no valor aceito (US$ …): 1 de 3 janelas prontas. Continuar custa cerca de US$ …".
- **AC-3** (BR-4, retry): Given a corrida do AC-2, When a pessoa usa Tentar de novo e aceita o novo valor, Then só as janelas 2 e 3 são perguntadas, o limite da nova corrida é o novo valor aceito, e a soma das duas corridas não passa do teto por análise.
- **AC-4** (BR-4, borda): Given um teto por análise com sobra menor que o valor aceito na retomada, Then o limite efetivo é a sobra, e a corrida para em `run-cap` (não em `accepted-limit`) quando chega nela.
- **AC-5** (BR-5, recomeço): Given uma retomada com `restarts`, When a pessoa aceita, Then as janelas feitas são perguntadas de novo e o gasto total da corrida é ≤ o aceito.
- **AC-6** (BR-6, FR-5, envio guiado): Given o envio com "Propor com IA", estimativa pela duração US$ 0,020 e máximo mostrado US$ 0,025, When a estimativa real dá US$ 0,024 e há uma janela perguntada de novo, Then a corrida parte e o gasto fechado é ≤ US$ 0,025.
- **AC-7** (BR-6, negativo): Given a estimativa real acima do máximo mostrado no envio, Then a preparação para em `estimate-rose` e nada é gasto (comportamento do KBC-097 mantido).
- **AC-8** (BR-7, FR-4): Given uma estimativa de US$ 0,0234, Then a tela mostra "Custa até US$ 0,024."; Given o gasto feito de US$ 0,0234, Then o histórico mostra "US$ 0,023" (arredondamento comum).
- **AC-9** (BR-1, borda de arredondamento): Given um valor aceito de US$ 0,0234 e chamadas que somariam exatamente US$ 0,0234, Then a última chamada é feita; Given uma que somaria US$ 0,02340001, Then não é feita.
- **AC-10** (BR-10, FR-6): Given um pedido sem `acceptedUsd`, Then a corrida tem como limite a estimativa do servidor e para nela como no AC-2.
- **AC-11** (BR-8, BR-9, FR-7): Given a conta da casa, When a corrida para no limite, Then o livro da mídia fecha com o gasto real (≤ aceito) e devolve a diferença da reserva; nenhum lançamento vai para outra conta.
- **AC-12** (reinício da API): Given uma corrida em andamento e a API parando (`stop`), When a API volta, Then a corrida aparece como interrompida com as janelas prontas mantidas, o livro fechou com o gasto real ≤ aceito e Tentar de novo pede um novo aceite (nada continua sozinho sem aceite).
- **AC-13** (concorrência): Given dois cliques em Tentar de novo ao mesmo tempo, Then só uma corrida parte (regra do KBC-097) e o limite é o da que partiu.
- **AC-14** (acessibilidade): Given a parada no limite, Then a mensagem é anunciada numa região viva educada, o foco fica em Tentar de novo, e no celular (390 px) a mensagem e o botão ficam fora da barra fixa, sem rolagem lateral.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-4, AC-5, AC-9 | unitário | `window-runner.test.ts` com modelo falso (ilegível, stream quebrado, preço com 6 casas) |
| AC-1 a AC-5, AC-10, AC-11, AC-12, AC-13 | integração API | `track-proposals-service.integration.test.ts`, livro da mídia real em SQLite |
| AC-6, AC-7 | integração API | `media-preparation.integration.test.ts` |
| AC-8 | componente (web) | `track-proposals.spec.ts`, `preparation-options.spec.ts` (arredondar para cima) |
| AC-2, AC-3, AC-14 | E2E | `e2e/specs/media-tracks-proposals.spec.ts` estendido, 1440 e 390 px, axe |
| NFR-1 | propriedade | 200 corridas sintéticas, gasto fechado ≤ aceito |

## References
Telas: T20 (passo 3, propostas da IA; passo 1, estimativa do envio) em `docs/design/screens.md` · ADR: [0016](../adr/0016-house-ai-plan-and-access-policy.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md) §7 (livro da mídia), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) §7 · Código: `apps/api/src/modules/track-proposals/window-runner.ts` (`ask`, `call`), `proposal-service.ts` (`start`, `reserve`, `closeSpend`), `apps/api/src/modules/preparation/preparation-service.ts` (`ESTIMATE_TOLERANCE`) · Itens: KBC-067 BR-3, KBC-072 BR-6, KBC-097 (`acceptedUsd`, `estimate-rose`, `restarts`).

## Open questions
Nenhuma. Resolvida em 2026-11-07 (dono, conversa): limitar a corrida ao valor aceito, contando a janela perguntada de novo. Premissas do planejamento (o dono pode mudar): no envio guiado, o valor aceito é o máximo com a tolerância de 1,25, mostrado na tela (BR-6); a tela arredonda estimativas para cima (BR-7).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas (retry, recomeço, reinício, reperguntas, conta que paga, arredondamento)
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] Tela, ADR e código ligados
- [x] Dependências feitas (KBC-067, KBC-072, KBC-097 no `develop`)
- [x] Cabe num goal
