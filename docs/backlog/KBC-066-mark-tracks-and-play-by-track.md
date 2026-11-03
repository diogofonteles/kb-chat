---
id: KBC-066
title: "Validar as faixas antes de aplicar: ouvir cada faixa, arrastar o início e o fim numa barra sobre a onda e a transcrição, corrigir, desfazer e só então \"Aprovar faixas\"; depois, ouvir por faixa no player"
status: ready
slice: phase-2-editing
outcome: nenhuma faixa é aplicada sem a pessoa validar; uma palestra de 1 h com 12 faixas é validada (ouvida nos limites e corrigida) em ≤ 10 minutos, e quem estuda vai direto à pergunta que interessa
depends_on: [KBC-065, KBC-041, KBC-044]
---

# KBC-066 — Validar as faixas (passo 3 do envio) e ouvir por faixa

## Story
Como quem envia e edita, quero ver as faixas (cada pergunta junto com a sua resposta) numa barra sobre a onda do áudio e a transcrição, ouvir cada uma e os segundos em volta de cada limite, arrastar o início e o fim quando estiverem errados, corrigir títulos e falantes, e só então aprovar, para que nada seja cortado ou mostrado a quem ouve sem eu conferir.

## Scope
**In:**
- O **fluxo guiado "Preparar áudio"** (T20) com o indicador de passos ("Passo 3 de 4: Validar faixas") e os passos 3 e 4; os passos 1 e 2 (escolhas no envio e processamento) entram no KBC-072, que pluga neste mesmo fluxo. Antes do KBC-072, a pessoa chega ao passo 3 pela página de um áudio já transcrito ("Dividir em faixas"), e o fluxo mostra os passos 1 e 2 como feitos.
- **Passo 3, "Validar faixas"** (para quem tem `media-edit`): a barra do tempo em duas faixas de zoom — a **visão geral** (a gravação toda, cada faixa como um bloco com número) e o **detalhe** (a faixa selecionada ± 30 s, com a onda do áudio, as palavras da transcrição embaixo e as alças de início e fim); a lista de faixas ao lado (título editável na linha, intervalo, duração, quem pergunta, quem responde, status); criar faixa (selecionar na transcrição ou "Nova faixa aqui" na barra), arrastar as alças, ajustes finos de ±0,5 s, dividir, juntar, apagar, renomear, tipo (`Pergunta e resposta` ou `Exposição`), quem pergunta e quem responde; ouvir a faixa inteira e "Ouvir o início" / "Ouvir o fim" (os segundos em volta do limite); desfazer e refazer; rascunho salvo no servidor a cada mudança.
- **Passo 4, "Aprovar faixas"**: o único botão que aplica; aqui as faixas aprovadas viram capítulos da gravação (o corte em arquivos próprios entra no KBC-068 e a classificação no KBC-069, ambos neste mesmo passo); depois, um resumo "12 faixas aplicadas".
- **Onda do áudio**: o worker da VM calcula os picos (10 por segundo) depois da conversão (`waveform`, ADR 0029) e a API serve `GET /api/v1/media/{id}/waveform`; mídias antigas recebem por um trabalho de reposição.
- **Para quem ouve**, permissão nova `media-tracks` ("Navegar por faixas"): lista "Faixas" ao lado da transcrição, marcas na barra do player, título da faixa atual no player e no mini-player, anterior/próxima faixa, link `?track=`.

**Out:** propor as faixas com IA (KBC-067, cujas propostas aparecem neste passo); os passos 1 e 2 (KBC-072); corte em arquivos e Biblioteca (KBC-068); assuntos (KBC-069); editar o texto da transcrição; vídeo.

## Business rules
- BR-1: **nada é aplicado sem validação**: proposta da IA ou faixa feita à mão ficam no rascunho, invisíveis para quem ouve e sem corte, até a pessoa apertar "Aprovar faixas"; não existe aplicação automática.
- BR-2: uma faixa é um intervalo `[início, fim)` em ms; ao soltar uma alça, o tempo encaixa no limite de palavra ou no meio de um silêncio (mapa do KBC-044) mais próximo dentro de 300 ms; o ajuste fino de ±0,5 s não encaixa. Sem palavras naquele trecho (música, aplauso), vale o tempo solto.
- BR-3: **faixas vizinhas nunca se sobrepõem**: uma alça para no limite da vizinha (as duas podem se encostar, o fim de uma igual ao início da outra); nenhuma ação (arrastar, ajuste fino, juntar, criar) produz sobreposição. Pode haver trechos fora de faixas.
- BR-4: **duração mínima de 5 s**: uma alça para quando a faixa chegaria a menos de 5 s; dividir só é oferecido onde as duas partes ficam com ≥ 5 s.
- BR-5: título de 1 a 120 caracteres; título vazio impede aprovar, nunca salvar o rascunho.
- BR-6: o rascunho é guardado no servidor a cada mudança (até 1 s depois); sair, recarregar, fechar ou abrir em outro aparelho volta ao mesmo passo e ao mesmo rascunho. Desfazer e refazer valem para a sessão aberta (até 100 passos); depois de recarregar, o histórico recomeça e a tela diz isso.
- BR-7: uma faixa do tipo `Pergunta e resposta` vai do começo da pergunta ao fim da resposta; pergunta de continuação da mesma pessoa sobre o mesmo assunto fica na mesma faixa (decisão assumida; é a orientação dada à pessoa no vazio do passo 3 e à IA no KBC-067, onde é testada).
- BR-8: editar e aprovar exigem `media-edit` no acervo; ver faixas aprovadas exige `media-tracks` e acesso ao áudio.
- BR-9: reabrir uma edição aprovada volta ao passo 3 com as faixas aprovadas como ponto de partida; a nova aprovação substitui a anterior (as regras de manter as faixas estão no KBC-068).
- BR-10: se a transcrição muda de versão, as faixas aprovadas mantêm os tempos e o passo 3 mostra "Revise os limites: a transcrição mudou".

## Functional requirements
- FR-1: `GET/PUT /api/v1/media/{id}/edit` deve ler e salvar o rascunho (faixas com início e fim em ms, título, tipo, quem pergunta, quem responde, origem `manual | ai`, passo atual do fluxo) com `If-Match`; o servidor recusa (422) sobreposição ou faixa < 5 s com a faixa apontada. (BR-3, BR-4, BR-6)
- FR-2: `POST /api/v1/media/{id}/edit/approve` deve validar e aplicar; `GET /api/v1/media/{id}/tracks` devolve só faixas aprovadas, para quem tem `media-tracks`. (BR-1, BR-5, BR-8)
- FR-3: A barra deve mostrar a visão geral e o detalhe; arrastar uma alça (mouse, caneta ou dedo) move o limite com uma etiqueta do tempo ("12:04,2") e, ao soltar, encaixa pela BR-2; a alça para nos limites da BR-3 e da BR-4 e diz por quê ("Encostou na faixa 4", "Mínimo de 5 s").
- FR-4: Cada alça deve ser focável (`role="slider"`, `aria-valuetext` como "Início da faixa 3: 12 minutos e 4,2 segundos"): `←/→` vai ao limite de palavra anterior/seguinte; `Shift+←/→` anda 5 s (e encaixa); `Alt+←/→` faz o ajuste fino de 0,5 s; `Home/End` vai ao menor e ao maior tempo permitido; o tempo novo é lido ao mudar. Botões "−0,5 s" e "+0,5 s" ao lado da alça selecionada (sempre visíveis no celular). (BR-2, BR-3, BR-4)
- FR-5: Ouvir: ▶ toca a faixa; "Ouvir o início" toca de 2 s antes a 3 s depois do início; "Ouvir o fim" toca de 3 s antes a 2 s depois do fim; atalhos `Espaço` (faixa), `I` (início), `F` (fim) com o foco na faixa ou na alça; o cursor de reprodução aparece na barra e na transcrição.
- FR-6: Dividir no cursor ou na palavra escolhida, juntar com a vizinha (o título fica o da primeira, editável), apagar (com "Desfazer"), renomear na linha (Enter salva, Esc volta), trocar o tipo e os falantes. (BR-4)
- FR-7: Desfazer e refazer (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` e botões) para toda mudança do passo 3. (BR-6)
- FR-8: "Aprovar faixas" (passo 4) com erros deve listar cada faixa com problema (título vazio, curta, sobreposta, se vier de um rascunho antigo) e levar o foco à primeira; sem erros, aplica e mostra o resumo "12 faixas aplicadas" com "Ver no player". (BR-1, BR-5)
- FR-9: O player deve mostrar as marcas das faixas aprovadas, o título da atual, "Faixa anterior"/"Próxima faixa" (`Shift+←`/`Shift+→` no player) e abrir `?track=<n>` no começo da faixa.
- FR-10: Dois editores no mesmo rascunho: o segundo a salvar recebe 412 e a tela diz "Outra pessoa mudou esta edição; recarregue para ver", mantendo a mudança dele copiável.

## Non-functional requirements
- NFR-1: o passo 3 abre em ≤ 1,5 s com 2 h de áudio, 200 faixas e a onda; arrastar uma alça acompanha o dedo ou o mouse a ≥ 50 fps em 390 px num celular médio (trace no E2E com CPU 4× mais lenta).
- NFR-2: a onda de 2 h pesa ≤ 150 kB comprimida e sai do worker em ≤ 20 s por hora de áudio.
- NFR-3: salvar o rascunho responde em ≤ 300 ms com 200 faixas.

## Screen spec — T20 "Preparar áudio", passos 3 e 4

**Objetivo:** conferir e corrigir as faixas antes de aplicar · **Contexto:** desktop no escritório (principal) e celular · **Sucesso:** a pessoa ouve os limites duvidosos, corrige arrastando ou com o teclado e aprova sem ajuda.

- **Indicador de passos** no topo (lista ordenada, UP-20): "1 Enviar ✓ · 2 Processar ✓ · **3 Validar faixas** · 4 Aprovar"; o atual com `aria-current="step"` e o texto "Passo 3 de 4: Validar faixas". "Sair e continuar depois" sempre visível (UP-04): o rascunho fica e a página do áudio mostra "Preparação parada no passo 3 · Continuar".
- **Hierarquia (UP-16):** 1) a barra (visão geral + detalhe), 2) a lista de faixas, 3) a transcrição. Ação primária única: **Aprovar faixas** (UP-17), no rodapé fixo, com o resumo "12 faixas · 2 com aviso".
- **Barra, visão geral:** blocos numerados na largura toda; blocos "Proposta pela IA" com borda tracejada e o selo em texto, "Criada por você" com borda cheia (não só cor, UP-20); clicar seleciona e leva o detalhe até ela.
- **Barra, detalhe:** a onda; as palavras da transcrição sob a onda; a faixa selecionada destacada, com as **alças** de início e fim (área de toque ≥ 48 × 48 px mesmo com a linha fina, MA-01/MA-06), a etiqueta de tempo durante o arraste e um marcador nos pontos de encaixe; a vizinha aparece apagada para mostrar onde a alça vai parar. Zoom com `+`/`−` e botões; no celular, pinça e também os botões (UP-09).
- **Por faixa (no detalhe e na linha da lista):** ▶ Ouvir · Ouvir o início · Ouvir o fim · −0,5 s/+0,5 s na alça selecionada · ⋯ (Dividir aqui, Juntar com a próxima, Apagar). Apagar não pede confirmação; mostra "Faixa 5 apagada · Desfazer" por 10 s (UP-07, MA-14).
- **Celular (390 px):** passo como "3/4 Validar faixas"; a visão geral fica fixa sob o indicador; o detalhe ocupa a largura com as alças grandes; a lista vira uma folha que sobe ("12 faixas"); a transcrição numa aba; os ajustes finos sempre visíveis porque arrastar com o dedo é impreciso.
- **Passo 4:** ao aprovar, "Aplicando as faixas…" e depois o resumo: "12 faixas aplicadas. Quem ouve já vê as faixas no player." com **Ver no player** e **Reabrir edição**. Com KBC-068 e KBC-069, este mesmo passo mostra "Preparando arquivos 3 de 12" e "Sugerindo assuntos".

| Estado | Mostra | Ação |
|---|---|---|
| Vazio (nenhuma faixa ainda) | "Nenhuma faixa ainda. Selecione a pergunta e a resposta na transcrição ou use Nova faixa aqui." | Nova faixa |
| Carregando | Esqueleto da barra e de 5 linhas na altura real | — |
| Com proposta da IA | Blocos tracejados "Proposta pela IA"; aviso "Confira as faixas propostas. Nada é aplicado antes de você aprovar." | Validar, Aprovar |
| Editando | Alça ativa com o tempo; "Rascunho salvo" discreto depois de cada mudança | Desfazer, Refazer |
| Limite atingido | A alça para; "Encostou na faixa 4" ou "Mínimo de 5 s" ao lado, em texto | — |
| Erros ao aprovar | Lista de problemas no topo, faixas marcadas com ícone e texto, foco na primeira | Corrigir |
| Conflito | "Outra pessoa mudou esta edição; recarregue para ver." | Recarregar |
| Sem rede | "Sem conexão: suas mudanças serão salvas quando a rede voltar." (fila local até voltar) | — |
| Transcrição mudou | "Revise os limites: a transcrição mudou." | — |
| Aprovado | Passo 4 com o resumo | Ver no player, Reabrir edição |
| Sem permissão | 403 explicado: "Você não tem permissão para editar esta gravação." | — |
| Extremo | 2 h, 200 faixas, faixas de 5 s (as alças ficam lado a lado e continuam alcançáveis pelo teclado e pelos ajustes finos) | — |

**Acessibilidade (MA-29):** a barra tem alternativa completa por teclado (FR-4); a lista de faixas é um único ponto de Tab com ↑/↓; mudanças de rascunho anunciadas só como "Rascunho salvo" em `aria-live="polite"`, no máximo uma vez a cada 10 s; tempos lidos por extenso; nada só por cor; `prefers-reduced-motion` respeitado. **Conteúdo:** "faixa", "início", "fim", "aprovar" iguais em todas as telas (DS-18); nada de "diarização", "segmento" ou "ms" na tela (UP-03).

## Acceptance criteria
- **AC-1** (BR-1): Given uma proposta da IA ou faixas feitas à mão no rascunho, When quem só ouve abre o áudio e a API de faixas é consultada, Then não há nenhuma faixa nem nenhum arquivo cortado até alguém aprovar.
- **AC-2** (FR-3, BR-2): Given a faixa 3 com início em 12:05,0 e a palavra "Mestre" começando em 12:04,2, When a pessoa arrasta a alça e solta em 12:04,4, Then o início encaixa em 12:04,2 e o rascunho é salvo.
- **AC-3** (FR-4, BR-2): Given o foco na alça de fim da faixa 3, When a pessoa aperta `Alt+→` duas vezes, Then o fim anda 1,0 s sem encaixe e o leitor de tela lê o tempo novo; When aperta `→`, Then vai ao próximo limite de palavra.
- **AC-4** (BR-3, adjacentes): Given a faixa 3 terminando em 15:47,0 e a faixa 4 começando em 15:47,0, When a pessoa arrasta o fim da faixa 3 para 16:10 (ou aperta `Shift+→`), Then o fim para em 15:47,0, aparece "Encostou na faixa 4" e nada se sobrepõe.
- **AC-5** (BR-4, limite): Given uma faixa de 6 s, When a pessoa arrasta o início para encurtá-la para 3 s, Then a alça para com 5 s e aparece "Mínimo de 5 s"; Given uma faixa de 9 s, Then "Dividir aqui" não é oferecido.
- **AC-6** (FR-1, BR-3, BR-4, negativo): Given um `PUT …/edit` direto com duas faixas sobrepostas ou uma de 4 s, When enviado, Then a API responde 422 apontando a faixa.
- **AC-7** (FR-5): Given a faixa 3, When a pessoa aciona "Ouvir o início", Then o áudio toca de 2 s antes a 3 s depois do início e para; "Ouvir o fim" toca de 3 s antes a 2 s depois do fim.
- **AC-8** (BR-6, rascunho): Given mudanças feitas no passo 3, When a pessoa recarrega a página ou abre no celular, Then volta ao "Passo 3 de 4" com as mesmas faixas e limites, e a tela diz que o histórico de desfazer recomeçou.
- **AC-9** (FR-7): Given a faixa 5 apagada e o início da 2 movido, When a pessoa aperta `Ctrl+Z` duas vezes, Then o início volta e a faixa 5 volta com o mesmo título; `Ctrl+Shift+Z` refaz.
- **AC-10** (FR-6): Given uma faixa com duas perguntas, When a pessoa divide na palavra escolhida, Then ficam duas faixas encostadas, cada uma com ≥ 5 s; When junta duas vizinhas, Then fica uma com o título da primeira.
- **AC-11** (FR-8, BR-5): Given uma faixa sem título, When a pessoa aprova, Then a aprovação é recusada, a faixa é apontada e o foco vai para o título dela.
- **AC-12** (FR-2, FR-9): Given 12 faixas validadas, When a pessoa aprova, Then o passo 4 mostra "12 faixas aplicadas" e quem ouve com `media-tracks` vê as marcas, o título da faixa atual e "Próxima faixa" pula para o começo da seguinte; `?track=3` abre na faixa 3.
- **AC-13** (BR-8, permissão): Given quem tem `media` sem `media-tracks`, When abre o áudio, Then o player é o de antes; e sem `media-edit`, `PUT …/edit` e `…/approve` respondem 403.
- **AC-14** (toque): Given o celular (390 px), When a pessoa arrasta a alça com o dedo e depois usa "+0,5 s", Then o limite muda nos dois casos e a alça tem área de toque ≥ 48 × 48 px.
- **AC-15** (FR-10): Given dois editores, When o segundo salva depois do primeiro, Then recebe a mensagem de conflito e a mudança dele continua copiável.
- **AC-16** (BR-9, BR-10): Given faixas aprovadas, When quem edita aciona "Reabrir edição", Then volta ao passo 3 com as faixas aprovadas como rascunho e quem ouve continua com as antigas até a nova aprovação; Given também uma transcrição refeita, Then vê "Revise os limites: a transcrição mudou" e quem ouve continua com as mesmas faixas.
- **AC-17** (BR-6, sair e continuar): Given a pessoa no passo 3, When aciona "Sair e continuar depois", Then a página do áudio mostra "Preparação parada no passo 3 · Continuar" e Continuar volta ao passo 3.
- **AC-18** (acessibilidade): o passo 3 inteiro funciona só com teclado (criar, mover alças, ouvir, dividir, juntar, apagar, desfazer, aprovar), sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-2 a AC-5, AC-10 | unitário (motor de alças: encaixe, limites, vizinhas, mínimo; fast-check em sequências de ações garantindo "nunca sobrepõe, nunca < 5 s") + E2E | |
| AC-1, AC-6, AC-11, AC-13, AC-15 | integração | duas e três contas |
| AC-7, AC-12 | E2E no Google Chrome e no WebKit com áudio real gerado por ffmpeg | asserções sobre `currentTime` |
| AC-8, AC-9, AC-16, AC-17 | integração + E2E | recarga no meio |
| AC-14 | E2E com toque emulado em 390 px + conferência num celular real antes da produção | |
| AC-18 | E2E | axe |
| NFR-1, NFR-2 | E2E com trace; integração do worker | fixture de 2 h |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0025 (player em camadas), 0022 (worker) · KBC-044 (mapa de silêncios), KBC-065 (falantes), KBC-067 (propostas que aparecem aqui), KBC-072 (passos 1 e 2 do mesmo fluxo), KBC-068 e KBC-069 (o que o passo 4 também faz) · Telas T15 e T20 · Benchmark: KBC-063 · Pedidos do dono (2026-11-03): "é interessante termos uma validação do usuario antes de implementar propriamente a divisao das faixas … ele ter uma barra onde ele pode arrastar o inicio e o fim da faixa"; "isso seria um passo do input de audios"

## Decisões assumidas (o dono pode mudar)
- Trechos que não são pergunta e resposta viram faixas do tipo `Exposição`, para a gravação toda ficar navegável.
- Aprovar não pede confirmação extra: a validação é o próprio passo 3, e a aprovação pode ser reaberta.
- O encaixe é de 300 ms e o ajuste fino de 0,5 s.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (spec de tela neste item)
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal (grande; se a spec mostrar que não cabe, separar a onda e o zoom num item à parte)
