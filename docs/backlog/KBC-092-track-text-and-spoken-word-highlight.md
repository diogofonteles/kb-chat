---
id: KBC-092
title: "Texto da faixa e destaque da palavra falada na tela de preparo"
status: done
slice: phase-2-editing
outcome: quem prepara um áudio confere o que cada faixa diz sem sair dela, lendo junto a palavra que está tocando
depends_on: [KBC-045, KBC-066, KBC-072, KBC-090]
---

# KBC-092 — Texto da faixa e destaque da palavra falada na tela de preparo

## Story
Como quem prepara um áudio, quero ler o texto da faixa que escolhi e ver a palavra que está sendo dita enquanto ela toca, para conferir se a faixa começa e termina no lugar certo sem procurar o trecho na transcrição inteira.

## Scope
**In:** passo 2 (`/midia/{id}/preparar`): **Ver texto** em cada faixa, e **Ouvir** abre o texto dela; passo 3 (`/midia/{id}/faixas`): bloco **Texto da faixa** na linha selecionada, também enquanto a IA propõe; destaque da palavra falada durante a escuta, com o mesmo método e a mesma aparência do KBC-045; queda para o destaque do segmento sem tempos de palavra; estados sem transcrição, transcrição falha, faixa sem fala e erro ao carregar.
**Out:** corrigir palavras da transcrição (KBC-093; o desenho deixa a palavra localizável por posição no texto, sem elemento por palavra, para ele usar); clicar numa palavra para ouvir dali (fica livre para o KBC-093); destaque palavra a palavra na coluna **Transcrição** do passo 3; texto no passo 4 e na página da faixa publicada; rota ou contrato novo na API.

## Business rules
- BR-1: o texto da faixa é a fala transcrita entre o início e o fim dela. Uma palavra pertence à faixa em que ela começa (início ≥ início da faixa e < fim da faixa). Segmento sem tempos de palavra entra inteiro quando cruza o intervalo da faixa.
- BR-2: a palavra destacada é a última cujo início ≤ tempo atual, entre as palavras da faixa; no silêncio entre palavras fica a anterior (KBC-045 BR-1). Fora do intervalo da faixa (ex.: "Ouvir o início" toca 2 s antes), nenhuma palavra é destacada.
- BR-3: a aparência é a do KBC-045 BR-2: sublinhado grosso em cor de destaque **e** peso, nunca só cor (UP-20); sem transição com `prefers-reduced-motion`; `Highlight` do sistema em `forced-colors`.
- BR-4: segmento sem tempos de palavra, ou cujas palavras não casam com o texto, tem o segmento inteiro destacado enquanto toca (KBC-045 FR-4).
- BR-5: no passo 2, um texto aberto por vez: abrir outro fecha o anterior. Fechar o texto não para o áudio.
- BR-6: só a escuta da própria tela (`TrackAudition`) move o destaque; o mini-player e a posição da pessoa no player não contam.

## Functional requirements
- FR-1: no passo 2, cada faixa deve ter **Ver texto** / **Esconder texto** (`aria-expanded`, `aria-controls`); **Ouvir** deve abrir o texto da faixa que toca. (BR-5)
- FR-2: no passo 3, a linha selecionada deve mostrar **Texto da faixa** abaixo dos campos (ou sozinho, quando a edição está travada pela IA). O texto segue início e fim enquanto a pessoa arrasta ou ajusta ±0,5 s. (BR-1)
- FR-3: a transcrição deve ser lida uma vez por página (`GET /api/v1/media/{id}/transcript`, só quando o primeiro texto abre) e as palavras por páginas de 100 segmentos (`GET …/transcript/words`), só as dos segmentos que aparecem ou tocam (KBC-045 FR-1). Sem rota nova.
- FR-4: durante a escuta, o bloco deve rolar só por dentro para manter a palavra à vista; se a pessoa rolou o bloco nos últimos 5 s, ele não rola; com `prefers-reduced-motion`, a rolagem é instantânea.
- FR-5: o bloco deve dizer, em palavras, quando não há texto: transcrição ainda não feita, falhou, áudio sem transcrição, faixa sem fala, ou erro ao carregar com **Tentar de novo**.
- FR-6: uma transcrição nova (versão diferente) enquanto a tela está aberta deve trocar o texto e descartar as palavras antigas, sem destacar palavra errada.

## Non-functional requirements
- NFR-1: a palavra destacada difere da falada em ≤ 120 ms (medido no E2E com tempos conhecidos, como no KBC-045).
- NFR-2: no máximo 1 escrita no DOM por troca de palavra; nenhum elemento por palavra (texto pintado pela CSS Custom Highlight API).
- NFR-3: numa faixa de 60 min (~600 segmentos), abrir o texto mostra as primeiras linhas em ≤ 300 ms depois da transcrição carregada, e o destaque não passa de 2 ms por quadro (trace do Playwright).
- NFR-4: WCAG 2.2 AA: contraste ≥ 4,5:1 nos três temas, foco visível, alvos ≥ 44×44 px no celular, axe sem violações sérias.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given o passo 2 com a faixa 2 de 0:30 a 1:10, When a pessoa usa **Ver texto** nela, Then aparece só a fala de 0:30 a 1:10, e a palavra que começa em 1:10 fica de fora.
- **AC-2** (FR-1, BR-2): Given o passo 2, When a pessoa usa **Ouvir** na faixa 2, Then o texto dela abre e, entre o início de "está" e o de "em", "está" está destacada.
- **AC-3** (BR-5): Given o texto da faixa 1 aberto, When a pessoa abre o da faixa 3, Then só o da faixa 3 fica aberto; When fecha o texto enquanto toca, Then o áudio continua.
- **AC-4** (FR-2, BR-2): Given o passo 3 com a faixa 4 selecionada, When a pessoa usa **▶ Ouvir**, Then o bloco **Texto da faixa** mostra a fala dela com a palavra falada destacada.
- **AC-5** (BR-2): Given o passo 3, When a pessoa usa **Ouvir o início**, Then nos 2 s antes do início nenhuma palavra é destacada, e a primeira palavra da faixa é destacada quando começa.
- **AC-6** (FR-2): Given a faixa selecionada, When a pessoa move o início 0,5 s para depois de uma palavra, Then essa palavra sai do texto sem recarregar a página.
- **AC-7** (FR-2): Given a IA propondo faixas (edição travada), When a pessoa seleciona uma faixa, Then o texto dela aparece, só para leitura.
- **AC-8** (BR-4): Given um segmento sem tempos de palavra dentro da faixa, When ele toca, Then o segmento inteiro é destacado, sem erro no console.
- **AC-9** (FR-5): Given a transcrição aguardando o transcritor ou transcrevendo, When a pessoa abre o texto, Then lê "O texto aparece quando a transcrição terminar."; Given a transcrição falhou, Then lê "A transcrição falhou: não há texto para mostrar."; Given um áudio preparado sem transcrição, Then lê "Este áudio não foi transcrito."
- **AC-10** (FR-5): Given uma faixa sobre um trecho sem fala transcrita, Then o bloco diz "Nenhuma fala transcrita neste trecho."
- **AC-11** (FR-5): Given a leitura da transcrição falhando, Then o bloco diz "Não consegui carregar o texto." com **Tentar de novo**, e o resto da tela segue utilizável.
- **AC-12** (FR-6): Given o texto aberto, When chega uma transcrição nova, Then o texto troca para a nova e nenhuma palavra da antiga fica destacada.
- **AC-13** (FR-4, NFR-3): Given uma faixa de 60 min tocando, When a palavra passa do fim do bloco, Then o bloco rola por dentro e a página não; When a pessoa rolou o bloco há menos de 5 s, Then ele não rola.
- **AC-14** (NFR-4): Given 390 px de largura, When o texto de uma faixa longa com uma palavra muito longa está aberto, Then não há rolagem lateral e o bloco cabe na tela (altura máxima, rolagem própria).
- **AC-15** (NFR-4): Given só o teclado, When a pessoa abre e fecha o texto e navega pela lista, Then **Ver texto** é uma parada de Tab, as palavras não são, e o foco não pula quando o destaque muda; o leitor de tela anuncia "Esconder texto da faixa 2, expandido" (o nome do botão é "Ver texto da faixa N" / "Esconder texto da faixa N", com `aria-expanded`) e não anuncia cada palavra. _Nota de 2026-11-06: alinhado à decisão registrada na implementação — o nome acessível contém o rótulo visível ("Ver texto" / "Esconder texto", WCAG 2.5.3), e o `aria-expanded` diz o estado; o texto antigo pedia "Texto da faixa 2, expandido"._
- **AC-16** (BR-3): Given os três temas e `prefers-reduced-motion`, When uma palavra está destacada, Then o contraste passa 4,5:1, o destaque tem sublinhado e peso, e não há transição.
- **AC-17** (NFR-1, NFR-2): Given tempos conhecidos, When a faixa toca, Then a palavra destacada difere da falada em ≤ 120 ms e há no máximo 1 escrita no DOM por troca.
- **AC-18** (pedido do dono no cartão do quadro): Given o texto de uma faixa aberto, When a pessoa escolhe **Ver transcrição completa**, Then vê a transcrição inteira do áudio com o trecho da faixa marcado e a palavra falada destacada; When escolhe **Ver só a faixa**, Then volta ao texto da faixa, sem parar o áudio.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-5, AC-6, AC-8 | unitário | recorte e busca da palavra (`track-text.spec.ts`) |
| AC-1 a AC-12 | componente | `track-text.spec.ts` (bloco), `preparation-tracks.spec.ts`, `track-row-list.spec.ts` |
| AC-2, AC-4, AC-9, AC-13 a AC-17 | E2E | `e2e/specs/media-track-text.spec.ts`, transcrição semeada com tempos conhecidos (`transcript-helpers.ts`), 1440 e 390 px, axe |
| NFR-1, NFR-3 | E2E com medição | como em `media-word-highlight.spec.ts` |

## References
Telas: T20 em `docs/design/screens.md` (Preparar áudio) · Reuso: KBC-045 (`libs/player-core/src/spoken-words.ts`, `transcript/transcript-words.ts`, `transcript/search-highlights.ts`) · ADR: [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) §5 (texto montado das palavras), [0025](../adr/0025-own-media-player-for-audio-and-video.md) · Pedido do dono: 2026-11-05 (cartão do quadro, "owner feedback").

## Open questions
Resolvidas em 2026-11-07 (dono, conversa). As perguntas de `work/KBC-092/spec.md` ficaram assim:
1. Passo 2 e passo 3: **os dois** (padrão aprovado).
2. Palavra na borda da faixa pertence à faixa em que começa (padrão aprovado, igual ao KBC-068 BR-6).
3. Clique na palavra: continua fora deste item e reservado ao KBC-093. O dono pediu que, lá, o clique (ou Enter) numa palavra leve o áudio ao começo dela, mantendo tocando ou pausado, **e** abra a correção dessa palavra ao mesmo tempo (KBC-093, decisão de 2026-11-07).
4. Palavra a palavra na coluna Transcrição do passo 3: **fora** (padrão aprovado).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-090 merges first); no blocking questions
- [x] Fits one goal
