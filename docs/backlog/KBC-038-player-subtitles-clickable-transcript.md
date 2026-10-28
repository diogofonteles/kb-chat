---
id: KBC-038
title: "Player com legendas e transcrição clicável: trecho ativo destacado, clique para pular e link para um minuto exato"
status: ready
slice: phase-2-a
outcome: quem estuda ouve a palestra lendo junto e volta a um trecho com um clique
depends_on: [KBC-036, KBC-041]
---

# KBC-038 — Player com legendas e transcrição clicável

## Story
Como quem estuda, quero ouvir a palestra com legenda e com o texto ao lado, clicando numa frase para ouvir dali, para estudar sem procurar o minuto na barra.

## Scope
**In:** legendas WebVTT geradas das palavras (regras da ADR 0023); transcrição ao lado do player (embaixo no celular) com o trecho ativo destacado e rolagem que acompanha; clicar numa frase pula para ela; botão CC (ligar/desligar, lembrado); link "Copiar link deste minuto" (`?t=`); aviso de baixa confiança.
**Out:** velocidade e demais controles (KBC-041); editar a transcrição; faixas e capítulos (fase B); compilados (fase C).

## Business rules
- BR-1: o texto exibido é o da transcrição atual, já filtrada (ADR 0023).
- BR-2: uma transcrição de baixa confiança mostra o aviso acima do texto e na legenda não muda nada (decisão do dono).

## Functional requirements
- FR-1: `GET /api/v1/media/{id}/subtitles.vtt` deve devolver o WebVTT da transcrição atual (cue ≤ 6 s e ≤ 84 caracteres, quebra em silêncio ≥ 0,5 s ou fim de frase), com as mesmas regras de acesso do stream.
- FR-2: `GET /api/v1/media/{id}/transcript` deve devolver os segmentos com início e fim em ms, a confiança e a versão.
- FR-3: Durante a reprodução, a tela deve marcar o segmento ativo (`aria-current`, fundo e barra lateral) e mantê-lo visível, sem roubar o foco. Qualquer rolagem feita pela pessoa suspende o acompanhamento até ela clicar "Voltar ao trecho atual", tocar num segmento ou pular pelo player. O segmento ativo é achado por busca binária e o destaque é interpolado entre os eventos `timeupdate` (`requestAnimationFrame` só enquanto toca).
- FR-7: A lista de segmentos deve ser um único ponto de Tab, com ↑/↓, Home/End e Enter/Espaço (tabindex móvel).
- FR-8: "Buscar na transcrição" deve destacar as ocorrências (sem diferenciar acentos nem maiúsculas), mostrar "n de m", andar entre elas e oferecer "Tocar daqui"; com a busca aberta, o acompanhamento fica suspenso.
- FR-9: A coluna da transcrição pode ser recolhida, com a escolha lembrada; selecionar texto oferece "Copiar com o link do minuto".
- FR-4: Clicar ou pressionar Enter num segmento deve pular para o seu início e tocar.
- FR-5: Abrir `/midia/{id}?t=754` deve posicionar em 12:34; "Copiar link deste minuto" deve copiar o link do segundo atual.
- FR-6: O botão CC e o atalho C devem ligar e desligar a legenda; a escolha vale para todas as mídias da pessoa. Um `?t=` vence a posição salva do KBC-041.

## Non-functional requirements
- NFR-1: o destaque acompanha o áudio com atraso ≤ 250 ms.
- NFR-2: uma transcrição de 2 h (~20 mil palavras) abre e rola sem travar (INP ≤ 200 ms em notebook comum), com lista virtualizada se preciso.

## Acceptance criteria
- **AC-1** (FR-1): Given uma mídia transcrita, When a legenda é ligada, Then as legendas aparecem sincronizadas e nenhuma passa de 84 caracteres.
- **AC-2** (FR-3, FR-4): Given a transcrição aberta, When a pessoa clica numa frase do minuto 20, Then o áudio pula para ela e a frase fica destacada.
- **AC-3** (FR-3): Given a reprodução, When a pessoa rola o texto para cima, Then o acompanhamento para (o texto não volta sozinho, nem depois de 30 s) e aparece "Voltar ao trecho atual"; When ela clica nele, Then o trecho ativo volta à vista e o acompanhamento recomeça.
- **AC-8** (FR-7): Given o foco na transcrição, When a pessoa aperta ↓ duas vezes e Enter, Then o áudio toca do terceiro segmento, e um Tab sai da lista (não passa por cada segmento).
- **AC-9** (FR-8): Given uma transcrição com "Salomão" em 3 lugares, When a pessoa busca "salomao", Then vê "1 de 3", Enter vai à 2ª ocorrência e "Tocar daqui" toca dela; When busca "xyz", Then vê "Nenhum trecho com 'xyz'."
- **AC-10** (FR-9): Given o texto "o vegetal" selecionado no minuto 12:34, When a pessoa usa "Copiar com o link do minuto", Then a área de transferência tem o trecho entre aspas, o título e o link com `?t=754`; a transcrição recolhida continua recolhida ao abrir outra mídia.
- **AC-4** (FR-6): Given a legenda ligada, When a pessoa abre outra mídia, Then a legenda continua ligada; When aperta C, Then ela desliga e o CC mostra `aria-pressed="false"`.
- **AC-5** (FR-5): Given o link com `?t=754`, When aberto por quem tem acesso, Then começa em 12:34; por quem não tem, 404 com a mensagem de documento não encontrado.
- **AC-6** (BR-2): Given uma transcrição de baixa confiança, When aberta, Then aparece "Transcrição automática de baixa confiança: pode haver trechos errados." acima do texto.
- **AC-7** (acessibilidade): Given só o teclado, When navega pelos segmentos com Tab e Enter, Then pula e ouve; o segmento ativo é anunciado só quando a pessoa pede (sem anunciar a cada troca); 1440 px e 390 px sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | unitário (gerador de VTT) + E2E | Fixtures do piloto |
| AC-2, AC-3, AC-4, AC-5, AC-6, AC-7 | componente + E2E | Áudio curto de teste com transcrição falsa; a rolagem manual é feita por roda, toque e teclado |
| AC-8 | componente + E2E | Conta as paradas de Tab |
| AC-9 | unitário (normalização e busca) + E2E | |
| AC-10 | componente + E2E | Lê a área de transferência com permissão no Playwright |
| NFR-1 | E2E | Mede a diferença entre `currentTime` e o segmento destacado |
| NFR-2 | E2E com medição | Transcrição sintética de 2 h; INP pelo Performance API do Playwright |

## References
ADR: [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (legendas), [0022](../adr/0022-media-library-store-queue-and-streaming.md) (stream) · Plano da fase 2 v3 (A5) · Tela: `docs/design/screens.md` T15 (transcrição ao lado) · Benchmark: [`docs/research/2026-10-28-player-benchmark.md`](../research/2026-10-28-player-benchmark.md) · Player do piloto: `report/legendas.html` (fora do repositório)

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-036); no open questions
- [x] Fits one goal
