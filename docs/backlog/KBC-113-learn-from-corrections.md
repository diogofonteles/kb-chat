---
id: KBC-113
title: "Aprender com as correções: cada palavra corrigida vira regra com o seu contexto e os nomes entram na lista de termos"
status: in-progress
slice: phase-2-editing
outcome: as próximas transcrições erram menos as palavras que as pessoas já corrigiram; meta ≥ 30 % menos correções por hora de áudio transcrita nos 30 dias depois da entrega (contagem do log de correções por versão nova), com ≤ 5 % das trocas do aprendizado desfeitas
depends_on: [KBC-093, KBC-040]
---

# KBC-113 — Aprender com as correções

**Decisão do dono de 2026-11-09 (conversa), que substitui a de 2026-11-07 (D24, KBC-093 BR-16, ADR 0034 emenda 9):** "precisamos que ao fazer a correção de uma palavra nessa tela [passo 3 Validar faixas, Texto da faixa, Correções (34)], cada palavra corrigida seja registrada e aprendida, conforme o seu contexto também, para que numa próxima transcrição sejam cometidos menos erros". Opção escolhida pelo dono: **"Automático com contexto"**: cada correção vira uma regra com as palavras vizinhas (ex.: "com a Manta" → "com Atlântida"); nas próximas transcrições a regra é aplicada sozinha quando o contexto bate, marcada "corrigida pelo aprendizado" e com desfazer; nomes e termos corrigidos entram sozinhos na lista de termos do transcritor (os mais corrigidos primeiro, dentro do limite de 224 tokens, KBC-040); um master vê e desliga qualquer regra ou termo aprendido. As "sugestões que o master aceita" deixam de existir.

## Story
Como quem prepara os áudios do acervo, quero que cada palavra que eu corrijo seja aprendida com o seu contexto, para que a próxima transcrição já saia com ela certa e eu corrija menos; como master, quero ver e desligar o que foi aprendido, para que um erro de uma pessoa não se espalhe.

## Scope
**In:** regras aprendidas das correções do KBC-093 (uma e "Corrigir todas"), com o contexto de uma palavra de cada lado; aplicação automática na **versão nova** de uma transcrição (primeira transcrição ou "Transcrever de novo", pelo Mac ou pelo Groq), depois da reaplicação das correções (KBC-093 BR-9) e antes do corte das faixas; marca "corrigida pelo aprendizado" no texto da faixa e na transcrição completa (passos 2 e 3) e no histórico **Correções**, com **Desfazer**; termos aprendidos acrescentados à lista do transcritor dentro do limite; bloco **Aprendido das correções** na T21 (Configurações → Termos da transcrição) com regras e termos, contagem, exemplos e liga/desliga.
**Out:** mudar texto já transcrito (só uma transcrição nova recebe as regras); regras por acervo (decisão: globais, como a lista de termos); aprender de palavras apagadas ou de mudança só de pontuação; mudar o transcritor do Mac ou o pedido ao Groq; editar o texto de uma regra (o master desliga; quem prepara corrige de novo); a página do player e a da faixa publicada.

## Business rules
- BR-1: **fonte.** Uma regra nasce das correções **em vigor** do KBC-093 feitas por pessoas (tipo "correct", não desfeitas; uma reaplicada conta pela original enquanto a reaplicação está em vigor). Não viram regra: texto novo vazio (palavra apagada), correção que só muda pontuação (o texto sem a pontuação das pontas e sem diferença de maiúsculas é igual ao de antes e só a pontuação mudou), e as trocas do próprio aprendizado.
- BR-2: **forma da regra.** `antes` (1 a 5 palavras, sem diferença de maiúsculas e sem a pontuação das pontas), `depois` (o texto digitado, sem a pontuação das pontas), e o **contexto**: a palavra não vazia mais próxima antes e depois do trecho, **no mesmo trecho** da transcrição (no começo ou no fim do trecho, o lado fica "início"/"fim"). Ex.: "com a Manta foi" com "a Manta" → "Atlântida" dá a regra "a manta" → "Atlântida" com contexto "com … foi".
- BR-3: **quando aplica.** Numa transcrição nova, uma sequência de palavras de um mesmo trecho cujo texto (sem maiúsculas e sem a pontuação das pontas) é o `antes` de uma regra ligada recebe o `depois` quando **pelo menos um lado** do contexto guardado bate com o vizinho dela (sem maiúsculas e sem pontuação). Uma correção igual (mesmo `antes` → mesmo `depois`) feita em **3 ou mais contextos diferentes** vira também a regra **em qualquer contexto**, que aplica sem olhar os vizinhos.
- BR-4: **escolha.** Mais de uma regra para o mesmo lugar: a de contexto ganha da "em qualquer contexto"; entre regras do mesmo tipo com `depois` diferentes (**conflito**), ganha a com mais correções; empate não aplica nenhuma e as duas aparecem "em conflito". As trocas não se sobrepõem: da esquerda para a direita, o trecho mais longo primeiro.
- BR-5: **como troca.** Igual a "Corrigir todas" (KBC-093 BR-1, BR-11): os tempos e o número de palavras não mudam, a primeira palavra recebe o texto e as outras ficam vazias, a pontuação das pontas da ocorrência fica ("a Manta," → "Atlântida,"). Maiúscula: quando a ocorrência começa com maiúscula e o `depois` com minúscula, a primeira letra vira maiúscula ("Concerteza" → "Com certeza"). Uma ocorrência que já diz o `depois` exatamente não é tocada.
- BR-6: **nunca no que já foi transcrito.** As regras só se aplicam ao gravar uma versão nova de uma transcrição, na mesma transação, depois das correções reaplicadas (as palavras que uma correção reaplicada escreveu não são tocadas) e antes das faixas serem cortadas. Uma versão já gravada nunca muda por causa de uma regra nova, ligada ou desligada.
- BR-7: **marca e desfazer.** Cada troca do aprendizado entra no histórico **Correções** da gravação como uma linha de autor "Aprendizado das correções", agrupada por regra ("Aprendizado: a Manta → Atlântida · 4 ocorrências"), e a palavra fica marcada no texto. Quem tem `media-correct` e vê a gravação desfaz uma troca ou o grupo dela (não é de uma pessoa, BR-5 do KBC-093 não a restringe a um autor); desfazer segue o KBC-093 BR-7 (só se a palavra ainda diz o que a regra pôs).
- BR-8: **erro de uma pessoa não se espalha.** Cada troca desfeita conta **contra** a regra; uma regra **se desliga sozinha** quando as trocas desfeitas chegam ao número de correções que a sustentam ("Desligada: desfeita 2 vezes"), a menos que um master a tenha ligado. Desfazer a correção da pessoa tira o apoio dela: com 0 correções em vigor, a regra some (e o termo também, BR-9).
- BR-9: **termos aprendidos.** Um termo aprendido é o `depois` de uma correção em vigor (BR-1) com 1 a 3 palavras, válido como termo (KBC-040: sem vírgula, sem `<|>`, até 100 caracteres) e que tem uma letra maiúscula (um nome) **ou** 2 ou mais correções; não é termo o que já está na lista dos masters (sem diferença de maiúsculas). Os termos aprendidos ligados entram na lista do transcritor **depois** dos termos dos masters, os mais corrigidos primeiro (empate: o mais recente), enquanto couberem no que sobra dos 224 tokens; o resto fica "fora por falta de espaço".
- BR-10: **versão da lista.** Quando os termos aprendidos que cabem mudam, a próxima vez que o transcritor pede a lista (ou um trabalho vai ao Groq) nasce uma versão nova da lista, de autor "Aprendizado das correções", com os termos dos masters iguais e os aprendidos novos. A transcrição guarda a versão com que foi feita (KBC-040 FR-4). Salvar a lista na T21 só dá conflito quando os termos **dos masters** mudaram desde que a tela abriu; uma versão do aprendizado no meio não dá conflito. O limite de 224 da T21 vale para os termos dos masters.
- BR-11: **controle do master.** Só masters veem o bloco **Aprendido das correções** e ligam ou desligam uma regra ou um termo aprendido; a mudança grava na hora, com quem e quando, e vale para a próxima transcrição (BR-6). Desligar não muda nada já transcrito. Um master pode ligar de novo uma regra que se desligou sozinha (BR-8).
- BR-12: **escopo global.** Regras e termos aprendidos valem para todas as gravações de todos os acervos, como a lista de termos (KBC-040). Os exemplos dizem de que gravação veio cada correção.

## Functional requirements
- FR-1: Ao gravar a versão nova de uma transcrição (`completeTranscribe`, pelo Mac ou pelo Groq), na mesma transação e depois da reaplicação do KBC-093 FR-8, o sistema deve aplicar as regras ligadas (BR-3 a BR-6) e gravar cada troca no log de correções com o id da regra, um grupo por regra e por versão, autor "Aprendizado das correções", subindo a revisão uma vez; o índice de busca, as legendas e as faixas seguem como numa correção. (BR-3 a BR-7)
- FR-2: `GET /api/v1/media/learning` (só masters) deve devolver as regras (antes, depois, contexto ou "em qualquer contexto", correções, gravações, trocas feitas, trocas desfeitas, estado `on`/`off`/`auto-off`/`conflict`, quem desligou, até 3 exemplos com gravação, tempo e "antes → depois") e os termos aprendidos (termo, correções, estado `in-list`/`no-room`/`off`) com o uso de tokens dos masters e dos aprendidos. (BR-1 a BR-4, BR-8, BR-9, BR-11)
- FR-3: `PUT /api/v1/media/learning/rules/{id}` e `PUT /api/v1/media/learning/terms/{id}` com `{ enabled: true | false | null }` (só masters; `null` volta ao automático) devem gravar o liga/desliga na tabela nova `learning_switches` e responder com o aprendizado atualizado. (BR-11)
- FR-4: `GET /api/v1/media-worker/terms` e a fila do Groq devem usar a lista com os termos aprendidos (BR-9, BR-10); `GET /api/v1/media/terms` (T21) deve devolver só os termos dos masters e o uso deles.
- FR-5: `GET …/transcript/words` deve dizer, para os trechos pedidos, quais palavras foram trocadas pelo aprendizado (`learned: [{ position, count, correctionId, before }]`); cada linha do histórico deve dizer `learned: true` quando é do aprendizado. (BR-7)
- FR-6: No Texto da faixa e na transcrição completa (passos 2 e 3), as palavras do aprendizado devem ter uma marca discreta (sublinhado pontilhado pela CSS Custom Highlight API, `learned-word`, sem um elemento por palavra); o painel **Corrigir palavra** aberto numa delas deve dizer "Corrigida pelo aprendizado · era «a Manta»" com **Desfazer**; o histórico mostra o grupo "Aprendizado: a Manta → Atlântida · 4 ocorrências" com **Desfazer o grupo**. (BR-7)
- FR-7: A T21 deve mostrar o bloco **Aprendido das correções** depois da lista e antes de **Versões da lista**: "Regras" (uma linha por regra: "a Manta → Atlântida", "depois de «com»" ou "em qualquer contexto", "3 correções em 2 gravações · aplicada 5 vezes, desfeita 1", estado, até 3 exemplos com **Ouvir** e link à gravação no tempo, e o interruptor **Ligada**) e "Termos" (termo, correções, "Na lista do transcritor" / "Fora por falta de espaço" / "Desligado", interruptor), com o uso "Termos aprendidos: 18 de 44 tokens livres". (BR-8, BR-9, BR-11)

## Non-functional requirements
- NFR-1: aplicar as regras numa versão nova de 2 h (≈ 20.000 palavras) com 1.000 regras leva p95 ≤ 300 ms dentro da transação (integração com dados sintéticos).
- NFR-2: `GET /api/v1/media/learning` com 10.000 correções em 500 gravações responde em p95 ≤ 400 ms (integração com medição).
- NFR-3: nenhuma troca do aprendizado sem rastro: toda palavra mudada pelas regras tem a sua linha no log, com o id da regra, e a transação inteira falha junto (teste com falha injetada).
- NFR-4: WCAG 2.2 AA: interruptores com nome que inclui a regra ("Regra a Manta → Atlântida ligada"), resultado anunciado por região viva educada, alvos ≥ 44×44 px no celular, 390 px sem rolagem lateral, a marca do aprendizado não só por cor (pontilhado), axe sem violações sérias.

## Acceptance criteria
- **AC-1** (BR-1, BR-2, FR-2): Given a correção "a Manta" → "Atlântida" (Incluir a próxima, 2 palavras) em "com a Manta foi" numa gravação, When um master abre Termos da transcrição, Then vê a regra "a Manta → Atlântida · depois de «com» ou antes de «foi» · 1 correção em 1 gravação", ligada, com o exemplo da gravação e do tempo.
- **AC-2** (BR-3, BR-6, FR-1): Given essa regra, When uma gravação nova é transcrita com "e com a Manta veio" num trecho e "na a Manta" noutro (vizinhos diferentes), Then a primeira vira "e com Atlântida veio", marcada como do aprendizado, e a segunda fica como veio.
- **AC-3** (BR-6, negativo): Given a regra criada depois de uma gravação já transcrita com "com a Manta", Then o texto dela não muda; When ela é transcrita de novo, Then a versão nova recebe "Atlântida".
- **AC-4** (BR-3, geral): Given "Tiuako" → "Tiuaco" corrigido em 3 contextos diferentes, When uma gravação nova diz "Tiuako" com vizinhos nunca vistos, Then vira "Tiuaco"; Given só 2 contextos, Then fica "Tiuako" ali.
- **AC-5** (BR-4, conflito): Given "a Manta" → "Atlântida" (2 correções) e "a Manta" → "Amanta" (1) no mesmo contexto, Then aplica "Atlântida"; Given 1 e 1, Then nenhuma aplica e as duas aparecem "em conflito" na T21.
- **AC-6** (BR-5, pontuação e maiúsculas): Given a regra "concerteza" → "com certeza", When a gravação nova tem "Concerteza," no começo de uma frase com o contexto, Then vira "Com certeza,", com os tempos das palavras intactos.
- **AC-7** (BR-1, negativo): Given só correções que apagam uma palavra e uma que só pôs vírgula ("Mariri" → "Mariri,"), Then nenhuma regra nasce e o bloco diz "Nada aprendido das correções por enquanto."
- **AC-8** (BR-7, desfazer a troca): Given a troca do AC-2, When quem tem `media-correct` (um membro, não o autor) usa Desfazer no painel ou no histórico, Then o texto volta a "a Manta", a busca acha "Manta" de novo e o histórico guarda as duas linhas.
- **AC-9** (BR-8, uma correção errada): Given uma regra de 1 correção e a troca dela desfeita uma vez, Then a regra aparece "Desligada: desfeita 1 vez" e a próxima transcrição não a aplica; When um master a liga, Then volta a aplicar.
- **AC-10** (BR-8, desfazer a correção da pessoa): Given a regra do AC-1 e a correção original desfeita, Then a regra e o termo "Atlântida" somem da T21 e a próxima transcrição não troca nada; as trocas já feitas noutras gravações ficam (BR-6) e podem ser desfeitas.
- **AC-11** (BR-9, BR-10, FR-4): Given "Tiuaco" corrigido e a lista dos masters com 180 de 224 tokens, When o transcritor pede a lista, Then recebe os termos dos masters e depois "Tiuaco", numa versão nova de autor "Aprendizado das correções"; When pede de novo sem nada novo, Then a versão é a mesma.
- **AC-12** (BR-9, limite): Given a lista dos masters com 222 de 224 tokens, Then os termos aprendidos que não cabem ficam "Fora por falta de espaço" e a lista do transcritor não passa de 224 tokens; os mais corrigidos entram primeiro.
- **AC-13** (BR-9, negativo): Given a correção "concerteza" → "com certeza" (minúsculas, 1 correção), Then não vira termo; Given 2 correções, Then vira; Given "Tiuaco" já na lista dos masters, Then não aparece como termo aprendido.
- **AC-14** (BR-10, conflito da T21): Given a T21 aberta na versão 5 e o aprendizado criando a versão 6, When o master salva a lista, Then grava a versão 7 com os termos dele e os aprendidos, sem conflito; Given outro master salvou termos dele no meio, Then aparece Recarregar (KBC-040).
- **AC-15** (BR-11, FR-3): Given um master, When desliga a regra "a Manta → Atlântida", Then a mudança grava na hora com "Desligada por Diogo", a próxima transcrição não a aplica e nenhum texto já feito muda; When desliga o termo "Tiuaco", Then a próxima lista do transcritor não o tem.
- **AC-16** (BR-11, permissão): Given um membro (mesmo com `media-correct`), Then a API responde 403 a `GET …/learning` e aos `PUT`, e o bloco não existe para ele.
- **AC-17** (FR-6, marca): Given uma faixa com trocas do aprendizado, When quem prepara abre o passo 3, Then as palavras trocadas têm sublinhado pontilhado, e o painel aberto numa delas diz "Corrigida pelo aprendizado · era «a Manta»" com Desfazer.
- **AC-18** (NFR-3): Given uma falha injetada ao gravar uma troca do aprendizado, Then a versão nova não é gravada (a tentativa falha como hoje) e nada muda.
- **AC-19** (NFR-4): Given só o teclado e 390 px, Then Tab chega a cada interruptor do bloco, o leitor de tela ouve "Regra a Manta → Atlântida, ligada" e "Regra desligada", e a tela não rola para o lado; axe sem violações sérias.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-2, AC-4 a AC-6 | unitário | `learning-rules.test.ts`: derivar regras (contexto, geral, conflito, auto-desligar) e aplicar numa lista de palavras |
| AC-1 a AC-11, AC-15, AC-16, AC-18 | integração API | `media-learning.integration.test.ts`: correções pelo serviço do KBC-093, transcrição nova pelo worker falso, histórico, undo por membro, falha injetada |
| AC-11 a AC-14 | integração API | lista do transcritor, limite, versões, conflito da T21 (`media-terms.integration.test.ts` estendido) |
| AC-12 | unitário | escolha dos termos aprendidos pelos tokens |
| NFR-1, NFR-2 | integração com medição | 20.000 palavras com 1.000 regras; 10.000 correções em 500 gravações |
| AC-15, AC-17, AC-19 | componente (web) + E2E | `learning-panel.spec.ts`, `track-text-corrections.spec.ts`; `e2e/specs/media-learning.spec.ts` em 1440 e 390 px, axe |

## References
Tela: T21 e T20 em `docs/design/screens.md` (emenda de 2026-11-09) · ADR: [0037](../adr/0037-learning-from-transcript-corrections.md) (substitui a emenda 9 da [0034](../adr/0034-transcript-word-corrections.md)), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) §3-4 · Itens: KBC-093 (BR-1, BR-7, BR-9, BR-11, BR-16 substituída), KBC-040 (BR-1, BR-2, FR-1, FR-4).

## Open questions
Nenhuma. Premissas do goal, gravadas como decisões (o dono pode mudar): regras globais; contexto de uma palavra de cada lado, basta um lado bater; "em qualquer contexto" a partir de 3 contextos; empate não aplica; regra desliga sozinha quando as trocas desfeitas chegam às correções; termo aprendido = nome (maiúscula) ou 2+ correções; membro com `media-correct` desfaz troca do aprendizado.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] Tela e ADR ligadas
- [x] Dependências no `develop` (KBC-093, KBC-040)
- [x] Cabe num goal
