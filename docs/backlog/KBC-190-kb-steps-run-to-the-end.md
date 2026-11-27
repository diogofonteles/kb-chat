---
id: KBC-190
title: "Um passo do kb que demora termina; só o que travou é interrompido"
status: in-review
slice: complete-answers
outcome: uma publicação no acervo que precisa de um passo longo (um `kb link` de mais de 30 min) termina na primeira tentativa, em vez de recomeçar do zero até esgotar as tentativas
depends_on: [KBC-188]
---

# KBC-190 — Um passo do kb que demora termina

## Story
Como dono, quero que o Mac termine uma publicação que precisa de um passo longo do kb, para que as gravações cheguem ao acervo sem eu ter de rodar nada à mão.

## Contexto
Em 26/11, quatro publicações do hermetismo com as mesmas 6 gravações falharam porque cada passo do kb tinha um teto fixo de 30 min. Uma falhou no `qmd embed`, com 2.302 documentos sem vetores. As outras três falharam no `kb link`, que refazia os 3.123 documentos a uns 1,2 s cada, mais de uma hora. O `kb link` não guarda progresso no meio, então cada tentativa recomeçava do zero e as 4 tentativas das gravações se esgotaram.

## Business rules
- BR-1: um passo do kb, do kb-map ou de conversão que está trabalhando nunca é interrompido por durar muito. Trabalhando quer dizer que algum processo dele usou o processador ou que ele começou um processo novo.
- BR-2: um passo que fica 20 min sem trabalhar travou. Ele é encerrado com tudo o que começou, e o job falha com o motivo (`stalled`), gastando a tentativa como qualquer falha.
- BR-3: os downloads (gravações por link, listas) mantêm o limite de tempo que já têm. A vigia vale para eles também.
- BR-4: o passo termina com o job e com o transcritor. Um desligamento ou um lease perdido encerra o passo e tudo o que ele começou; o job não é dado como falho (o lease o devolve). Quando o launchd encerra o transcritor, o passo, no mesmo grupo de processos, acaba junto e nunca escreve no cofre depois que a trava se foi.
- BR-5: o que o passo disse antes de ser encerrado (onde estava, o que já gastou) vai junto com o motivo, e o gasto é registrado.

## Acceptance criteria
- AC-1: dado um passo que usa o processador por mais tempo do que a vigia espera, quando ele roda, então termina com o resultado dele.
- AC-2: dado um passo parado (sem processador e sem processos novos), quando passa o tempo da vigia, então ele e tudo o que começou são encerrados, e o job falha com `stalled`.
- AC-3: dado um passo cujo processo principal espera enquanto os filhos trabalham, um depois do outro (o `kb link` com os `qmd query`), quando ele roda, então não é encerrado.
- AC-4: o `qmd embed`, os passos do kb (`classify`, `link`, `index`), a conversão e o mapa do kb-map, e o `kb ingest file` dentro do kb-map não têm mais teto fixo.
- AC-5: dado um passo em andamento, quando o job para (desligamento, lease perdido) ou o launchd encerra o transcritor, então o passo e tudo o que ele começou acabam, e nada é escrito depois.
- AC-6: dado um processo que deixou o passo e segura a saída dele, quando o passo termina ou é encerrado, então o transcritor não espera por esse processo.

## References
`tools/transcriber/src/transcriber/kb_publish.py` (`KbCli._run`, `STEP_TIMEOUT_S`), `doc_ingest.py` (`run_whole`, `MAP_TIMEOUT_S`, `CONVERT_TIMEOUT_S`); `work/KBC-188/evidence-production.md`.
