---
id: KBC-072
title: "Enviar um áudio numa jornada guiada de 4 passos: enviar e escolher o que fazer, acompanhar o processamento em detalhe com as faixas aparecendo, validar as faixas e aprovar"
status: ready
slice: phase-2-editing
outcome: quem envia uma palestra percorre os 4 passos sem procurar nada: escolhe as etapas em ≤ 30 s, acompanha a evolução (transcrição, vozes, faixas criadas), valida e aprova na mesma jornada, e pode sair e voltar no mesmo passo; no teste com usuários, as 4 tarefas do plano abaixo são concluídas sem ajuda
depends_on: [KBC-064, KBC-065, KBC-066, KBC-067]
---

# KBC-072 — Envio guiado: enviar, processar, validar faixas e aprovar

## Story
Como quem envia conteúdo, quero mandar um áudio dizendo já no envio se ele deve ser transcrito, se quero saber quem está falando e se ele deve ser dividido em faixas de pergunta e resposta, acompanhar em detalhe cada etapa e as faixas aparecendo com os nomes, validar as faixas e aprovar, tudo como passos de um mesmo envio, para editar uma palestra numa jornada só e poder parar e continuar depois.

## Scope
**In:**
- O envio vira o **fluxo guiado "Preparar áudio"** (T20), com o indicador de passos sempre visível ("Passo 2 de 4: Processar"):
  1. **Enviar e escolher** — o arquivo, título, acervo e autoria (T14) e a seção "O que fazer com este áudio" (opções explicadas em palavras simples, estimativa de tempo e custo, padrões sensatos, opções indisponíveis visíveis e desativadas com o motivo);
  2. **Processar** — o progresso detalhado de cada etapa (transcrição em %, vozes achadas, faixas propostas até agora) e a **lista crescente das faixas** já criadas, cada uma tocável antes de tudo terminar; falha parcial com "Tentar de novo" por etapa;
  3. **Validar faixas** — o passo do KBC-066 (barra sobre a onda e a transcrição, ouvir, arrastar início e fim, corrigir, desfazer), com as propostas do KBC-067 nele;
  4. **Aprovar** — "Aprovar faixas" aplica as faixas e, quando escolhido, as corta (KBC-068) e as classifica (KBC-069), com o progresso e o resumo final.
- **Pular o passo 3** só quando a pessoa escolheu "Não dividir agora": o indicador mostra "3 Validar faixas — não pedido" e o passo 4 vira "Concluir" (só aplica o que foi pedido, como os nomes das vozes). Com "Vou marcar as faixas eu mesmo" ou "Propor as faixas com IA", o passo 3 é obrigatório antes do 4.
- **Sair e continuar depois** em qualquer passo depois do envio do arquivo: o plano e o rascunho ficam no servidor; a página do áudio e a lista (T14) mostram "Preparação parada no passo 3 · Continuar", que volta ao mesmo passo.
- Um **plano de preparação** por mídia (etapas pedidas, o estado de cada uma e o passo atual) guardado na API; funciona depois de recarregar, em outro aparelho e no celular; anúncios educados ao leitor de tela.
- Pela página de um áudio já enviado, "Preparar áudio" abre o mesmo fluxo no passo 1 só com as etapas que faltam.

**Out:** vídeo (KBC-035); envio em lote (fase B); notificação fora do app (e-mail, push); o trabalho de cada etapa (KBC-036, KBC-064, KBC-065, KBC-067, KBC-068, KBC-069) e a interface do passo 3 (KBC-066), que este item orquestra.

## Business rules
- BR-1: as opções do passo 1 são: **Transcrever**; **Indicar quem está falando** (separar as vozes e sugerir os nomes pelo contexto; exige a transcrição); **Dividir em faixas de pergunta e resposta**, com 3 escolhas: "Não dividir agora", "Vou marcar as faixas eu mesmo" ou "Propor as faixas com IA" (exige as duas anteriores); e, com faixas, **Sugerir os assuntos de cada faixa** (KBC-069).
- BR-2: padrões: "Transcrever" marcado; "Indicar quem está falando" marcado para quem tem `media-edit`; "Dividir em faixas" em "Não dividir agora"; nada que custe dinheiro vem pré-selecionado (design honesto); a última escolha é lembrada para o próximo envio, salvo as opções pagas, que voltam desmarcadas.
- BR-3: uma opção sem permissão (`media-edit`, `media-edit-ai`, `media-classify`) ou com uma dependência desligada aparece desativada com o motivo em texto; desmarcar uma opção desmarca as que dependem dela, com o aviso dizendo quais.
- BR-4: cada opção mostra a estimativa pela duração do arquivo (lida no navegador antes do envio): tempo de máquina e custo ("grátis, no computador do transcritor" ou "≈ US$ 0,02, descontado do limite mensal da mídia"); a estimativa é refeita pela duração real quando a etapa começa, e a etapa paga só reserva o valor nessa hora (KBC-067 BR-3).
- BR-5: os passos andam em ordem; o passo 3 só abre quando as faixas existem (todas as janelas da proposta terminaram, ou logo depois do processamento quando a pessoa vai marcar à mão); o passo 3 só é pulado quando a escolha foi "Não dividir agora"; o passo 4 só aplica depois de "Aprovar faixas" (KBC-066 BR-1).
- BR-6: uma etapa que falha não apaga o que as outras já fizeram; as que dependem dela ficam "Esperando: <etapa> não terminou"; "Tentar de novo" refaz só a etapa que falhou e depois as que esperavam; quem propôs com IA pode trocar para "Vou marcar as faixas eu mesmo" e seguir para o passo 3.
- BR-7: no passo 2, uma faixa aparece na lista assim que é criada (por cada janela da proposta com IA, KBC-067 FR-3) e já pode ser tocada como trecho da gravação; ela só aparece para quem ouve depois de aprovada no passo 4.
- BR-8: o passo atual, o plano e o rascunho são estado do servidor: recarregar, sair e voltar ou abrir em outro aparelho mostra o mesmo passo; só o envio do arquivo (passo 1) precisa da página aberta.
- BR-9: anúncios ao leitor de tela: uma frase quando muda o passo ou quando uma etapa começa, termina ou falha, e no máximo uma frase de faixas novas a cada 15 s ("3 faixas novas; 9 até agora"); nunca a cada atualização de porcentagem.

## Functional requirements
- FR-1: `POST /api/v1/media` (envio) deve aceitar `plan` (`transcribe`, `speakers`, `tracks: none|manual|ai`, `subjects`) e validar permissões e dependências; uma opção recusada devolve 422 com o motivo por opção. (BR-1, BR-3)
- FR-2: `GET /api/v1/media/{id}/preparation` deve devolver o passo atual (1 a 4, e se o 3 foi pulado), as etapas pedidas, o estado de cada uma (`waiting | queued | running | done | failed | blocked`), os detalhes (transcrição: % e "cortes 14 de 40"; vozes: número achado e as sugestões de nome; faixas: quantas propostas até agora; custo reservado e gasto) e as faixas do rascunho com título, início, fim, duração, quem pergunta, quem responde e status (`Proposta pela IA | Criada por você | Aprovada | Preparando arquivo`). (BR-5, BR-7, BR-8)
- FR-3: O sinal de vida do transcritor (ADR 0023) deve levar o progresso do trabalho (cortes feitos e total), campo novo e opcional no protocolo; um transcritor antigo sem o campo mostra "Transcrevendo…" sem porcentagem.
- FR-4: `POST /api/v1/media/{id}/preparation/steps/{step}/retry` deve refazer só a etapa que falhou e liberar as que esperavam; `PATCH …/preparation` troca "Propor com IA" por "Vou marcar eu mesmo". (BR-6)
- FR-5: O passo 2 deve atualizar a cada 3 s enquanto alguma etapa roda (sem pular a rolagem, sem roubar o foco), parar quando nada roda e retomar ao voltar à aba; ao terminar, oferecer "Validar faixas" (ou "Concluir" quando o passo 3 foi pulado) sem avançar sozinho.
- FR-6: "Sair e continuar depois" deve estar em todo passo depois do envio; a lista (T14) e a página do áudio mostram "Preparação parada no passo N · Continuar". (BR-8)
- FR-7: As estimativas do passo 1 devem usar a duração lida do arquivo e as médias medidas (tempo por hora de áudio do transcritor; custo por hora do KBC-067), e dizer "estimativa" sempre. (BR-4)
- FR-8: O passo 4 deve mostrar o progresso do que a aprovação dispara (aplicar, preparar arquivos 3 de 12, sugerir assuntos) e o resumo final com "Ver no player" e "Reabrir edição".

## Non-functional requirements
- NFR-1: o passo 1 (escolha das opções) acrescenta ≤ 30 s ao envio no teste com usuários (mediana observada, amostra pequena, só indicação).
- NFR-2: a resposta de `…/preparation` sai em ≤ 150 ms com 200 faixas no rascunho; a lista do passo 2 renderiza 200 faixas sem travar a rolagem (60 fps em 390 px, trace no E2E).
- NFR-3: o atraso entre uma faixa ser criada e aparecer no passo 2 é ≤ 5 s, medido no E2E.

## Screen spec — T20 "Preparar áudio" (passos 1 e 2; passos 3 e 4 no KBC-066)

**Objetivo:** levar um áudio do arquivo às faixas aprovadas sem a pessoa procurar nada · **Contexto:** desktop no escritório (principal) ou celular · **Sucesso:** a pessoa diz a qualquer momento em que passo está e o que falta, e pode parar e continuar.

**Indicador de passos** (lista ordenada no topo de todos os passos, UP-20; `aria-current="step"`): "1 Enviar e escolher · 2 Processar · 3 Validar faixas · 4 Aprovar", com ✓ e texto nos feitos, "não pedido" no 3 pulado; título da página "Passo 2 de 4: Processar — Palestra de 1998". Os passos feitos podem ser revistos (só leitura, exceto o 3 enquanto não aprovado); os futuros não são clicáveis e dizem por quê ("Disponível quando o processamento terminar"). **Sair e continuar depois** à direita (UP-04). No celular: "2/4 Processar" com o indicador completo ao tocar.

**Passo 1 — Enviar e escolher** (no lugar do painel de T14; MA-15 a MA-20): arquivo (arrastar e soltar ou "Escolher arquivo"), **Título**, **Acervo**, **Autoria**; depois o grupo `fieldset` "O que fazer com este áudio" (MA-31), uma coluna (MA-17), 3 decisões de uma vez (UP-15):
- ☑ **Transcrever** — "Gera o texto com o tempo de cada palavra, para ler junto, buscar e criar legendas. Grátis. Leva cerca de 4 min para esta gravação de 1 h 02 quando o transcritor estiver ligado." Transcritor desligado: "O transcritor está desligado desde 02/11 às 22:10; começa quando ele ligar." (aviso, não desativa; UP-02).
- ☑ **Indicar quem está falando** — "Separa as vozes (Voz 1, Voz 2…) e sugere os nomes pelo que já sabemos do acervo, como o autor da gravação. Você confirma os nomes. Grátis. Cerca de 3 min." Sem `media-edit`: desativado com "Você não tem permissão para editar gravações. Peça a um master em Pessoas e permissões."
- **Dividir em faixas de pergunta e resposta** — rádios (MA-19): "Não dividir agora" (marcado) · "Vou marcar as faixas eu mesmo" ("Cada pergunta com a sua resposta vira uma faixa com título. Você confere e aprova antes de aplicar.") · "Propor as faixas com IA" ("A IA propõe as faixas, os títulos e quem pergunta e responde. Você ouve, corrige e aprova antes de aplicar. Estimativa: US$ 0,02, descontado do limite mensal da mídia (restam US$ 8,40).") e, com faixas, ☐ "Sugerir os assuntos de cada faixa" (estimativa própria).
- Resumo antes do botão, que muda com as escolhas (UP-01): "Depois do envio: transcrever, indicar quem fala, propor faixas com IA (≈ 12 min, ≈ US$ 0,02) e você valida as faixas."
- **Enviar** é o único primário (UP-17); "Cancelar" mais fraco (MA-21). Só "Transcrever" (ou nada): o fluxo termina no envio e volta à lista, como hoje. Desmarcar "Transcrever" desmarca e desativa as dependentes com o aviso "Sem a transcrição não dá para indicar quem fala nem dividir em faixas." (UP-06).

**Passo 2 — Processar:**
- **Etapas** (lista, não só barra): "Envio ✓ · Conversão ✓ · Transcrição — 35 % (cortes 14 de 40), cerca de 3 min · Vozes — esperando a transcrição · Faixas com IA — esperando as vozes"; a etapa atual com `role="progressbar"` e `aria-valuetext="Transcrição: 35 por cento"`; nas pagas, "Reservado US$ 0,02 · gasto US$ 0,01" (UP-02).
- **Detalhes:** "Vozes achadas: 3 (Voz 1 — 41 min, Voz 2 — 6 min, Voz 3 — 4 min)" com as sugestões ("Voz 1 parece ser ✦ Mestre Gabriel — é o autor da gravação e responde 9 de 10 perguntas" · **Aceitar**); "Faixas: 7 até agora".
- **Faixas aparecendo** (o principal deste passo, UP-16), em ordem de tempo: número, título, "12:04–15:47", "3 min 43 s", "Pergunta: Pergunta da plateia · Resposta: ✦ Mestre Gabriel", status em texto; ▶ **Ouvir** em cada linha. Faixas novas entram com realce suave por 2 s (sem animação com `prefers-reduced-motion`) e não puxam a rolagem: fora do fim da lista, aparece "3 faixas novas ↓". Corrigir limites fica para o passo 3 (a linha diz "Você ajusta no próximo passo").
- **Fim do passo:** "Processamento concluído: 12 faixas propostas, 3 vozes." com o primário **Validar faixas** (ou **Concluir** com o passo 3 pulado).

| Estado | Mostra | Ação |
|---|---|---|
| Passo 1, escolhendo | Opções com padrões, estimativas e motivos dos desativados | Enviar, Cancelar |
| Passo 1, enviando | "Enviando… 128 de 312 MB · 41 %" (T14) | Cancelar envio |
| Passo 2, na fila | "Na fila: 2 trabalhos antes deste" ou "Aguardando o transcritor · desligado desde …" | Sair e continuar depois |
| Passo 2, rodando | Etapa atual com %, as seguintes "esperando …", faixas aparecendo | Ouvir faixas |
| Passo 2, falha parcial | "Falhou: o provedor de IA não respondeu" (UP-11, MA-25); anteriores ✓; faixas já criadas mantidas; dependentes "Esperando: Faixas com IA não terminou" | **Tentar de novo**; "Marcar as faixas eu mesmo" |
| Passo 2, teto atingido | "O limite mensal da mídia foi atingido (US$ 10). As faixas com IA não rodaram." | "Marcar as faixas eu mesmo" |
| Passo 2, concluído | "Processamento concluído: 12 faixas propostas, 3 vozes." | Validar faixas / Concluir |
| Passos 3 e 4 | Ver KBC-066 | — |
| Parado (saiu) | Na lista e na página do áudio: "Preparação parada no passo 3 · Continuar" | Continuar |
| Sem permissão | Sem `media-upload`, não há "Enviar áudio"; sem `media-edit`, a rota de um passo de edição mostra 403 explicado | — |
| Sem rede | "Sem conexão: o trabalho continua no servidor; atualizo quando a rede voltar." | — |
| Extremo | 2 h, 200 faixas: lista virtualizada; títulos de 120 caracteres em 2 linhas; 10 vozes | — |

**Acessibilidade e toque (MA-29):** `fieldset`/`legend` nas opções; desativados com `aria-disabled` + motivo em `aria-describedby`, ainda focáveis para o motivo ser lido (UP-20, MA-23); indicador de passos como lista ordenada; uma região `aria-live="polite"` com as regras da BR-9; o foco só muda quando a pessoa avança de passo (vai para o título do passo); alvos ≥ 48 px no celular (MA-01); nada só por cor; nenhuma ação só por gesto (UP-09). **Conteúdo:** "passo", "faixa", "transcrição", "vozes", "quem está falando", "validar", "aprovar", "limite mensal da mídia" iguais em todas as telas (DS-18); nada de "diarização", "embedding", "LLM" (UP-03); erros com o problema e a saída (UP-11), tom sério para dinheiro (DS-19).

## Acceptance criteria
- **AC-1** (FR-1, BR-1, BR-2): Given quem tem `media-upload` e `media-edit` sem `media-edit-ai`, When escolhe um arquivo de 1 h no passo 1, Then vê "Transcrever" e "Indicar quem está falando" marcados, "Não dividir agora" marcado e "Propor as faixas com IA" desativado com o motivo da permissão.
- **AC-2** (BR-3): Given "Transcrever" desmarcado, When a pessoa olha as demais opções, Then elas ficam desmarcadas e desativadas com o aviso.
- **AC-3** (BR-4, FR-7): Given um arquivo de 1 h 02, When a pessoa escolhe "Propor as faixas com IA", Then a estimativa de custo e o saldo do mês aparecem e o resumo antes de **Enviar** inclui o valor.
- **AC-4** (BR-2, honesto): Given a pessoa usou "Propor as faixas com IA" no último envio, When abre um envio novo, Then essa opção vem desmarcada e as grátis vêm como ela deixou.
- **AC-5** (passos visíveis): Given o envio terminado com as 3 etapas e faixas com IA, When o passo 2 abre, Then o indicador diz "Passo 2 de 4: Processar", com o passo 1 ✓ e os passos 3 e 4 não clicáveis com o motivo.
- **AC-6** (FR-2, FR-3, FR-5): Given o passo 2, When as etapas rodam, Then a transcrição mostra % e "cortes n de m" subindo, depois "Vozes achadas: 3" e depois "Faixas: n até agora".
- **AC-7** (BR-7, NFR-3): Given a proposta com IA rodando em janelas (stub), When a primeira janela termina, Then em ≤ 5 s as faixas dela aparecem com título, intervalo, duração, quem pergunta e responde e "Proposta pela IA", e ▶ **Ouvir** toca o trecho certo enquanto as outras janelas continuam.
- **AC-8** (BR-5, FR-5): Given o processamento concluído, When a pessoa vê o passo 2, Then **Validar faixas** aparece e o fluxo não avança sozinho; When ela aciona, Then o indicador diz "Passo 3 de 4: Validar faixas".
- **AC-9** (BR-5, pular): Given a escolha "Não dividir agora", When o processamento termina, Then o indicador mostra "3 Validar faixas — não pedido" e **Concluir** leva ao fim; Given "Vou marcar as faixas eu mesmo", Then não há como ir ao passo 4 sem passar pelo 3.
- **AC-10** (BR-8, FR-6): Given a pessoa no passo 3 com mudanças no rascunho, When aciona "Sair e continuar depois" (ou recarrega, ou abre no celular), Then a lista mostra "Preparação parada no passo 3 · Continuar" e Continuar volta ao passo 3 com as mesmas faixas.
- **AC-11** (BR-6, FR-4): Given a transcrição e as vozes feitas e a proposta com IA falhando, When a pessoa vê o passo 2, Then as etapas anteriores têm ✓, as faixas já criadas continuam, **Tentar de novo** refaz só a proposta e "Marcar as faixas eu mesmo" leva ao passo 3.
- **AC-12** (BR-9, acessibilidade): Given um leitor de tela e 12 faixas chegando em 40 s, When o passo 2 roda, Then são anunciadas no máximo 4 frases de faixas novas e uma por mudança de etapa, nenhuma por porcentagem, e o foco não muda.
- **AC-13** (FR-1, negativo): Given uma chamada direta com `tracks: ai` por quem não tem `media-edit-ai`, When enviada, Then a API responde 422 com o motivo daquela opção e o envio não é criado.
- **AC-14** (FR-8): Given faixas validadas e a escolha de sugerir assuntos, When a pessoa aprova no passo 4, Then o passo mostra a aplicação, "Preparando arquivos n de 12" e "Sugerindo assuntos", e termina no resumo com "Ver no player".
- **AC-15** (só transcrição): Given só "Transcrever" escolhido, When o envio termina, Then a pessoa volta à lista como hoje, sem os passos 2 a 4.
- **AC-16** (outro ponto de entrada): Given um áudio já transcrito sem faixas, When quem edita aciona "Preparar áudio" na página dele, Then o passo 1 oferece só as etapas que faltam e o resto do fluxo é o mesmo.
- **AC-17** (layout): passos 1 e 2 em 1440 px e 390 px nos três temas, cada estado da tabela capturado e conferido, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-15 | componente + E2E | contas com e sem `media-edit-ai`; duração lida de um áudio gerado por ffmpeg |
| AC-5 a AC-9, AC-14 | E2E com transcritor falso e LLM stub em janelas | relógio controlado |
| AC-10, AC-11, AC-13, AC-16 | integração + E2E | recarga no meio; dois aparelhos (dois contextos do navegador) |
| AC-12 | unitário do anunciador (fake timers) + E2E com a árvore de acessibilidade | conta as frases da região `aria-live` |
| AC-17 | E2E | axe, capturas por estado |
| NFR-1 | teste com usuários (abaixo) | |

## Teste com usuários (plano, para o dono rodar)
Decisão que informa: a jornada de 4 passos é entendida sem ajuda, inclusive validar as faixas arrastando os limites (UP-25). Qualitativo, moderado, com pensar em voz alta (UT-01, UT-08); 3 pessoas (o dono como piloto e 2 colegas de estudo, `docs/product/context.md` ## Research; abaixo das 5 recomendadas, então só indica problemas, sem números, UT-02, UT-05); protótipo navegável com conteúdo real (UP-27), pilotado antes (UT-07). Tarefas sem os rótulos da tela (UT-06): (1) "Você gravou uma palestra com perguntas do público; mande para o acervo de modo que dê para achar cada pergunta depois"; (2) "Enquanto prepara, descubra quantas perguntas já foram achadas e ouça uma"; (3) "Uma das perguntas começa tarde demais; deixe ela começar no ponto certo"; (4) "Pare agora e continue mais tarde de onde parou". SEQ depois de cada tarefa, com "por quê" (UT-16, UT-11). Consentimento de gravação de tela e voz, granular e revogável, dados pseudonimizados, guarda de 90 dias, LGPD.

## References
Telas: `docs/design/screens.md` T14 (o passo 1 substitui o painel de envio), T15; T20 "Preparar áudio" (passos 3 e 4 no KBC-066) · ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0022, 0023 · KBC-064, KBC-065, KBC-066, KBC-067, KBC-068, KBC-069 · Benchmark de produtos: KBC-063 · Pedidos do dono (2026-11-03): "o usuario deve adicionar um audio, indicar se quer que seja feita a divisao em faixas, transcrição e indicação de quem esta falando"; "o progresso desta edição deve ser mostrado em detalhes para que o usuario consiga ver bem a evolução, quais faixas ele já criou (com os nomes e etc)"; "isso seria um passo do input de audios"

## Decisões assumidas (o dono pode mudar)
- Nada pago vem marcado nem é lembrado como padrão; a pessoa marca a cada envio.
- O fluxo não avança sozinho entre os passos 2 e 3; a pessoa aciona "Validar faixas".
- Atualização por consulta a cada 3 s, sem conexão aberta permanente.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (spec de tela neste item e no KBC-066)
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
