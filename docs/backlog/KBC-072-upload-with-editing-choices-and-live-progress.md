---
id: KBC-072
title: "Enviar um áudio escolhendo o que fazer com ele (transcrever, indicar quem fala, dividir em faixas), acompanhar cada etapa em detalhe e chegar à revisão"
status: ready
slice: phase-2-editing
outcome: quem envia uma palestra escolhe as etapas em ≤ 30 s no próprio envio, acompanha a evolução (transcrição, vozes, faixas criadas) sem sair da tela e chega à revisão sem procurar nada; no teste com usuários, as 3 tarefas do plano abaixo são concluídas sem ajuda
depends_on: [KBC-064, KBC-065, KBC-066, KBC-067]
---

# KBC-072 — Envio com as escolhas de edição e progresso detalhado até a revisão

## Story
Como quem envia conteúdo, quero dizer já no envio se o áudio deve ser transcrito, se devo saber quem está falando e se ele deve ser dividido em faixas de pergunta e resposta, ver em detalhe cada etapa andando e as faixas aparecendo com os nomes, e terminar direto na revisão, para editar uma palestra numa jornada só, sem procurar onde cada coisa fica.

## Scope
**In:** no painel "Enviar áudio" (T14), a seção nova "O que fazer com este áudio" com as opções explicadas em palavras simples, com estimativa de tempo e custo e padrões sensatos; opções indisponíveis visíveis, desativadas e com o motivo; um plano de preparação por mídia (etapas pedidas e o estado de cada uma) guardado na API; ao terminar o envio com alguma etapa de edição escolhida, a pessoa cai na tela "Editar em faixas" (T20, KBC-066) em **modo preparação**: cabeçalho com as etapas e o progresso detalhado de cada uma, a transcrição aparecendo, as vozes achadas e a **lista crescente das faixas** já criadas, cada uma abrível e tocável antes de tudo terminar; falha parcial com "Tentar de novo" por etapa; ao fim, a mesma tela vira a revisão (sem trocar de tela); funciona depois de recarregar, em outro aparelho e no celular; anúncios educados ao leitor de tela; pedir as mesmas etapas depois, pela página do áudio, abre a mesma tela.
**Out:** vídeo (KBC-035); envio em lote (fase B); notificação fora do app (e-mail, push); as etapas em si (KBC-036, KBC-064, KBC-065, KBC-067, KBC-069 fazem o trabalho; este item as orquestra e mostra).

## Business rules
- BR-1: as opções são: **Transcrever**; **Indicar quem está falando** (separar as vozes e sugerir os nomes pelo contexto; exige a transcrição); **Dividir em faixas de pergunta e resposta**, com 3 escolhas: "Não dividir agora", "Vou marcar as faixas eu mesmo" ou "Propor as faixas com IA" (exige as duas anteriores); e, dentro da proposta com IA, **Sugerir também os assuntos de cada faixa** (KBC-069).
- BR-2: padrões: "Transcrever" marcado; "Indicar quem está falando" marcado para quem tem `media-edit`; "Dividir em faixas" em "Não dividir agora"; nada que custe dinheiro vem pré-selecionado (design honesto); a última escolha da pessoa é lembrada como o padrão do próximo envio, salvo as opções pagas, que voltam desmarcadas.
- BR-3: uma opção sem permissão (`media-edit`, `media-edit-ai`, `media-classify`) ou com uma dependência desligada aparece desativada com o motivo em texto ao lado; desmarcar uma opção desmarca as que dependem dela, com o aviso dizendo quais.
- BR-4: cada opção mostra a estimativa pela duração do arquivo (lida no navegador antes do envio): tempo de máquina e custo ("grátis, no computador do transcritor" ou "≈ US$ 0,02, descontado do limite mensal da mídia"); a estimativa é refeita pela duração real quando a etapa começa, e a etapa paga só reserva o valor nessa hora (KBC-067 BR-3).
- BR-5: uma etapa que falha não apaga o que as outras já fizeram; as que dependem dela ficam "Esperando: <etapa> não terminou"; "Tentar de novo" refaz só a etapa que falhou e depois as que esperavam.
- BR-6: uma faixa aparece na lista assim que é criada (à mão ou por cada janela da proposta com IA, KBC-067 FR-2) e já pode ser aberta e tocada como trecho da gravação; ela só aparece para quem ouve depois de publicada (KBC-066 BR-4).
- BR-7: o progresso é estado do servidor: recarregar, fechar e voltar ou abrir em outro aparelho mostra o mesmo ponto; nada se perde se a página fechar durante as etapas (só o envio do arquivo precisa da página aberta).
- BR-8: anúncios ao leitor de tela: uma frase quando uma etapa começa, termina ou falha, e no máximo uma frase de faixas novas a cada 15 s ("3 faixas novas; 9 até agora"); nunca a cada atualização de porcentagem.

## Functional requirements
- FR-1: `POST /api/v1/media` (envio) deve aceitar `plan` (`transcribe`, `speakers`, `tracks: none|manual|ai`, `subjects`) e validar permissões e dependências; uma opção recusada devolve 422 com o motivo por opção. (BR-1, BR-3)
- FR-2: `GET /api/v1/media/{id}/preparation` deve devolver as etapas pedidas, o estado de cada uma (`waiting | queued | running | done | failed | blocked`), os detalhes (transcrição: % e "cortes 14 de 40"; vozes: número achado; faixas: quantas propostas até agora; custo reservado e gasto) e as faixas do rascunho com título, início, fim, duração, quem pergunta, quem responde e status (`Proposta pela IA | Criada por você | Publicada | Preparando`). (BR-6, BR-7)
- FR-3: O sinal de vida do transcritor (ADR 0023) deve levar o progresso do trabalho (cortes feitos e total), campo novo e opcional no protocolo; um transcritor antigo sem o campo mostra "Transcrevendo…" sem porcentagem.
- FR-4: `POST /api/v1/media/{id}/preparation/steps/{step}/retry` deve refazer só a etapa que falhou e liberar as que esperavam. (BR-5)
- FR-5: A tela deve atualizar o progresso a cada 3 s enquanto alguma etapa roda (sem pular a rolagem, sem roubar o foco), parar quando nada roda e retomar ao voltar à aba.
- FR-6: Pela página do áudio, "Preparar edição" deve abrir o mesmo painel de escolhas (só as etapas ainda não feitas) e depois a mesma tela T20 em modo preparação. (BR-1)
- FR-7: As estimativas da seção "O que fazer com este áudio" devem usar a duração lida do arquivo e as médias medidas (tempo por hora de áudio do transcritor; custo por hora do KBC-067), e dizer "estimativa" sempre. (BR-4)

## Non-functional requirements
- NFR-1: a escolha das opções acrescenta ≤ 30 s ao envio no teste com usuários (mediana observada, amostra pequena, só indicação).
- NFR-2: a resposta de `…/preparation` sai em ≤ 150 ms com 200 faixas no rascunho; a lista renderiza 200 faixas sem travar a rolagem (60 fps em 390 px, trace no E2E).
- NFR-3: o atraso entre uma faixa ser criada e aparecer na tela é ≤ 5 s (intervalo de atualização + resposta), medido no E2E.

## Screen spec

**T14 (envio) — seção "O que fazer com este áudio"** · Objetivo: escolher as etapas sem precisar entender a técnica · Contexto: desktop no escritório ou celular, a pessoa acabou de escolher o arquivo · Sucesso: escolhe em ≤ 30 s e sabe o que vai acontecer e quanto custa.

1. Depois de **Título**, **Acervo** e **Autoria** (T14), vem o grupo `fieldset` "O que fazer com este áudio" (MA-31), uma coluna (MA-17), revelado de uma vez (só 3 decisões, UP-15):
   - ☑ **Transcrever** — "Gera o texto com o tempo de cada palavra, para ler junto, buscar e criar legendas. Grátis. Leva cerca de 4 min para esta gravação de 1 h 02 quando o transcritor estiver ligado." Se o transcritor estiver desligado: "O transcritor está desligado desde 02/11 às 22:10; começa quando ele ligar." (aviso, não desativa; UP-02).
   - ☑ **Indicar quem está falando** — "Separa as vozes (Voz 1, Voz 2…) e sugere os nomes pelo que já sabemos do acervo, como o autor da gravação. Você confirma os nomes. Grátis. Cerca de 3 min." Desativado sem `media-edit`: "Você não tem permissão para editar gravações. Peça a um master em Pessoas e permissões."
   - **Dividir em faixas de pergunta e resposta** — três rádios (MA-19), nesta ordem: "Não dividir agora" (marcado) · "Vou marcar as faixas eu mesmo" ("Cada pergunta com a sua resposta vira uma faixa com título; você marca na transcrição.") · "Propor as faixas com IA" ("A IA lê a transcrição e propõe as faixas, os títulos e quem pergunta e responde; nada é publicado sem você. Estimativa: US$ 0,02, descontado do limite mensal da mídia (restam US$ 8,40).") com, abaixo, ☐ "Sugerir também os assuntos de cada faixa" (estimativa própria).
   - Uma frase de resumo antes do botão, que muda com as escolhas (UP-01): "Depois do envio: transcrever, indicar quem fala e propor faixas com IA (≈ 12 min, ≈ US$ 0,02)."
2. **Enviar** continua sendo o botão primário único (UP-17); "Cancelar" mais fraco (MA-21).
3. Desmarcar "Transcrever" desmarca e desativa as que dependem, com o aviso inline "Sem a transcrição não dá para indicar quem fala nem dividir em faixas." (UP-06, MA-24).
4. Com só "Transcrever" (ou nada), o envio termina como hoje (volta à lista, T14). Com qualquer etapa de edição, ao terminar o envio a pessoa vai para T20 em modo preparação, com o foco no título da tela (UP-01).

**T20 (Editar em faixas) — modo preparação e revisão** · Objetivo: ver a evolução e começar a revisar o que já está pronto · Sucesso: a pessoa diz a qualquer momento em que etapa está, quantas faixas já existem e abre uma delas.

- **Cabeçalho de etapas** (lista ordenada, não só barra; UP-20): "1. Envio ✓ · 2. Conversão ✓ · 3. Transcrição — 35 % (cortes 14 de 40) · 4. Vozes — esperando a transcrição · 5. Faixas com IA — esperando as vozes". Cada etapa com ícone **e** texto de estado; a atual com a barra de progresso (`role="progressbar"` com `aria-valuetext="Transcrição: 35 por cento"`) e o tempo estimado restante ("cerca de 3 min"). Para as pagas, "Reservado US$ 0,02 · gasto US$ 0,01" (UP-02).
- **Painel de detalhes**, abaixo do cabeçalho: "Vozes achadas: 3 (Voz 1 — 41 min, Voz 2 — 6 min, Voz 3 — 4 min)" com as sugestões de nome assim que existem ("Voz 1 parece ser ✦ Mestre Gabriel — é o autor da gravação e responde 9 de 10 perguntas" · **Aceitar**); "Faixas: 7 até agora".
- **Lista de faixas** (a principal da tela, UP-16: é o que a pessoa veio ver), crescendo no fim, em ordem de tempo: cada linha com o número, o **título** (editável na própria linha: clicar ou Enter abre o campo, Enter salva, Esc desfaz), o intervalo "12:04–15:47", a duração "3 min 43 s", "Pergunta: Pergunta da plateia · Resposta: ✦ Mestre Gabriel" e o status em texto ("Proposta pela IA", "Criada por você", "Preparando", "Publicada"); ações na linha: ▶ **Ouvir** (toca o trecho no player da tela; o mini-player assume ao sair, KBC-041), **Abrir** (rola a transcrição até a faixa) e ⋯ (dividir, juntar, apagar com **Desfazer** por 10 s, MA-14/UP-07). Faixas novas entram com um realce suave por 2 s (sem animação com `prefers-reduced-motion`) e **não** puxam a rolagem: se a pessoa não está no fim da lista, aparece "3 faixas novas ↓".
- **Transcrição** ao lado (desktop) ou na aba "Transcrição" (celular), preenchendo-se quando a transcrição termina; antes disso, "A transcrição aparece aqui quando terminar."
- **Celular (390 px)**: o cabeçalho de etapas vira um resumo de uma linha ("Etapa 3 de 5: Transcrição — 35 %") que expande ao tocar; abas "Faixas" (padrão) e "Transcrição"; alvos ≥ 48 px (MA-01); ações da linha num menu ⋯ além de ▶ (MA-09).
- **Fim**: quando tudo termina, o cabeçalho diz "Pronto para revisar: 12 faixas, 3 vozes" e aparece o botão primário **Publicar faixas** (KBC-066); antes disso, **Publicar faixas** fica visível e desativado com o motivo "Espere a proposta terminar ou publique só as faixas que você criou" (o botão "Publicar as que estão prontas" fica como secundário).

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Vazio (nenhuma etapa de edição pedida) | Página do áudio como hoje, com "Preparar edição" para quem tem `media-edit` | Preparar edição |
| Escolhendo (T14) | A seção "O que fazer com este áudio" com padrões, estimativas e motivos dos desativados | Enviar / Cancelar |
| Na fila | Etapa "Na fila: 2 trabalhos antes deste" ou "Aguardando o transcritor · desligado desde …" | — (pode sair; o progresso fica salvo) |
| Rodando, por etapa | Etapa atual com % e detalhes; as seguintes "esperando …"; faixas aparecendo | Ouvir, abrir e renomear faixas já criadas |
| Falha parcial | A etapa "Falhou: o provedor de IA não respondeu" (UP-11, MA-25), as anteriores ✓ e as faixas já criadas mantidas; dependentes "Esperando: Faixas com IA não terminou" | **Tentar de novo** na etapa; "Marcar as faixas eu mesmo" como saída |
| Teto atingido | "O limite mensal da mídia foi atingido (US$ 10). As faixas com IA não rodaram." | "Marcar as faixas eu mesmo" |
| Pronto → revisão | "Pronto para revisar: 12 faixas, 3 vozes" | Publicar faixas |
| Sem permissão | Quem não tem `media-edit` não vê T20 (rota direta: 403 explicado, "Você não tem permissão para editar esta gravação") | — |
| Conteúdo extremo | 2 h, 200 faixas: lista virtualizada; títulos de 120 caracteres em 2 linhas; 10 vozes | — |
| Sem rede | "Sem conexão: o trabalho continua no servidor; atualizo quando a rede voltar." | — |

### Acessibilidade e toque
WCAG 2.2 AA (MA-29). Seção de escolhas em `fieldset`/`legend`, rádios e caixas nativos, desativados com `aria-disabled` + motivo ligado por `aria-describedby` e ainda focáveis, para o motivo ser lido (UP-20, MA-23). Etapas como lista ordenada com o estado em texto; `aria-live="polite"` numa região só, com as regras de BR-8; foco nunca muda sozinho durante a preparação; título inline com rótulo "Título da faixa 3"; tudo por teclado (Tab até a lista, ↑/↓ entre faixas, Enter renomeia, Espaço ouve); nada só por cor, contraste AA nos três temas; nenhuma ação só por gesto (UP-09).

### Conteúdo
Termos iguais em todas as telas (DS-18): "faixa", "transcrição", "vozes", "quem está falando", "limite mensal da mídia"; nada de "diarização", "embedding", "LLM" na tela (UP-03). Erros dizem o problema e a saída (UP-11, MA-25), tom sério para dinheiro (DS-19).

## Acceptance criteria
- **AC-1** (FR-1, BR-1, BR-2): Given quem tem `media-upload` e `media-edit` sem `media-edit-ai`, When escolhe um arquivo de 1 h, Then vê "Transcrever" e "Indicar quem está falando" marcados, "Não dividir agora" marcado e "Propor as faixas com IA" desativado com o motivo da permissão.
- **AC-2** (BR-3): Given "Transcrever" desmarcado, When a pessoa olha as demais opções, Then elas ficam desmarcadas e desativadas com "Sem a transcrição não dá para indicar quem fala nem dividir em faixas."
- **AC-3** (BR-4, FR-7): Given um arquivo de 1 h 02, When a pessoa escolhe "Propor as faixas com IA", Then a estimativa de custo e o saldo do mês aparecem e o resumo antes de **Enviar** inclui o valor.
- **AC-4** (BR-2, honesto): Given a pessoa usou "Propor as faixas com IA" no último envio, When abre um envio novo, Then essa opção vem desmarcada e as grátis vêm como ela deixou.
- **AC-5** (FR-2, FR-3, FR-5): Given o envio terminado com as 3 etapas, When a tela T20 abre, Then o cabeçalho mostra a transcrição com % e "cortes n de m" subindo, depois "Vozes achadas: 3" e depois "Faixas: n até agora".
- **AC-6** (BR-6, NFR-3): Given a proposta com IA rodando em janelas (stub), When a primeira janela termina, Then em ≤ 5 s as faixas dela aparecem na lista com título, intervalo, duração, quem pergunta e responde e "Proposta pela IA", e ▶ **Ouvir** toca o trecho certo enquanto as outras janelas continuam.
- **AC-7** (BR-7): Given a preparação na etapa 4, When a pessoa recarrega a página ou abre no celular, Then vê a mesma etapa, os mesmos detalhes e as mesmas faixas.
- **AC-8** (BR-5, FR-4): Given a transcrição e as vozes feitas e a proposta com IA falhando, When a pessoa vê a tela, Then as etapas 1 a 4 têm ✓, as faixas já criadas continuam e **Tentar de novo** refaz só a proposta.
- **AC-9** (BR-8, acessibilidade): Given um leitor de tela e 12 faixas chegando em 40 s, When a preparação roda, Then são anunciadas no máximo 4 frases de faixas novas e uma por mudança de etapa, nenhuma por porcentagem, e o foco não muda.
- **AC-10** (FR-1, negativo): Given uma chamada direta com `tracks: ai` por quem não tem `media-edit-ai`, When enviada, Then a API responde 422 com o motivo daquela opção e o envio não é criado.
- **AC-11** (FR-6): Given um áudio já transcrito sem edição, When quem edita usa "Preparar edição", Then o painel oferece só as etapas que faltam e leva à mesma tela T20.
- **AC-12** (título inline, MA-14): Given uma faixa proposta, When a pessoa renomeia na linha e depois apaga a faixa, Then o título novo fica salvo e "Desfazer" por 10 s devolve a faixa com esse título.
- **AC-13** (rolagem): Given a pessoa lendo a faixa 2 no topo da lista, When chegam faixas novas, Then a lista não rola sozinha e aparece "3 faixas novas ↓".
- **AC-14** (celular e layout): telas T14 e T20 em 1440 px e 390 px nos três temas, cada estado da tabela capturado e conferido, sem violações sérias do axe.
- **AC-15** (só transcrição): Given só "Transcrever" escolhido, When o envio termina, Then a pessoa volta à lista como hoje (T14), sem T20.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-15 | componente + E2E | contas com e sem `media-edit-ai`; duração lida de um áudio gerado por ffmpeg |
| AC-5, AC-6, AC-7 | E2E com transcritor falso e LLM stub em janelas | relógio controlado; recarga no meio |
| AC-8, AC-10, AC-11 | integração + E2E | |
| AC-9 | unitário do anunciador (fake timers) + E2E com a árvore de acessibilidade | conta as frases da região `aria-live` |
| AC-12, AC-13 | E2E | |
| AC-14 | E2E | axe, capturas por estado |
| NFR-1 | teste com usuários (abaixo) | |

## Teste com usuários (plano, para o dono rodar)
Decisão que informa: as escolhas no envio e o modo preparação são entendidos sem ajuda (UP-25). Qualitativo, moderado, remoto ou presencial, com pensar em voz alta (UT-01, UT-08); 3 pessoas (o dono como piloto e 2 colegas de estudo, `docs/product/context.md` ## Research; abaixo das 5 recomendadas, então só indica problemas, sem números, UT-02, UT-05); protótipo navegável de T14 e T20 com conteúdo real (UP-27), pilotado antes (UT-07). Tarefas sem os rótulos da tela (UT-06): (1) "Você gravou uma palestra com perguntas do público; mande para o acervo de modo que dê para achar cada pergunta depois"; (2) "Enquanto prepara, descubra quantas perguntas já foram achadas e ouça uma"; (3) "A preparação parou numa etapa; faça continuar". SEQ depois de cada tarefa, com "por quê" (UT-16, UT-11). Consentimento de gravação de tela e voz, granular e revogável, dados pseudonimizados, guarda de 90 dias, LGPD.

## References
Telas: `docs/design/screens.md` T14, T15; T20 nasce no KBC-066 e ganha aqui o modo preparação · ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0022 (fila), 0023 (protocolo do transcritor) · KBC-064, KBC-065, KBC-066, KBC-067, KBC-069 · Benchmark de produtos: KBC-063 · Pedidos do dono (2026-11-03): "o usuario deve adicionar um audio, indicar se quer que seja feita a divisao em faixas, transcrição e indicação de quem esta falando"; "o progresso desta edição deve ser mostrado em detalhes para que o usuario consiga ver bem a evolução, quais faixas ele já criou (com os nomes e etc)"

## Decisões assumidas (o dono pode mudar)
- Nada pago vem marcado nem é lembrado como padrão; a pessoa marca a cada envio.
- A preparação e a revisão são a mesma tela (T20), para a jornada não se partir.
- Atualização por consulta a cada 3 s (como a lista da T14, a cada 5 s), sem conexão aberta permanente.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (spec de tela neste item)
- [x] Dependencies scheduled
- [x] Fits one goal
