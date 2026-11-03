---
id: KBC-068
title: "Faixas como itens próprios da Biblioteca: cortadas sem recodificar, com a própria transcrição, e ao lado da gravação completa"
status: ready
slice: phase-2-editing
outcome: cada pergunta e resposta pode ser favoritada, posta numa playlist, baixada e achada na busca como um item próprio, sem perder a gravação completa
depends_on: [KBC-066, KBC-051]
---

# KBC-068 — Faixas como itens próprios da Biblioteca

## Story
Como quem estuda, quero que cada faixa de pergunta e resposta seja um item que eu possa favoritar, pôr numa playlist, baixar e achar na busca, para montar meu estudo por pergunta e não pela palestra inteira.

## Scope
**In:** ao aprovar uma edição (KBC-066), cada faixa vira um item de mídia derivado (ADR 0029): uma linha em `media` com a gravação de origem, o início e o fim, o título da faixa, o acervo e a autoria herdados, o respondente como autor quando for um autor do acervo; o arquivo da faixa cortado da versão AAC pelo worker da VM com cópia de fluxo (`-c copy`, sem recodificar); a transcrição da faixa recortada da transcrição atual da origem, com os tempos deslocados (sem transcrever de novo); índice da busca (ADR 0024) com a faixa; na Biblioteca (KBC-051), as faixas aparecem para quem tem `media-tracks`, agrupadas sob a gravação ("Gravação completa · 12 faixas"); favoritar, playlist, fila e download (KBC-052 a KBC-056) funcionam com a faixa como com qualquer item; reaprovar uma edição atualiza as faixas mantendo o identificador das que continuam.
**Out:** vídeo (fica para quando o KBC-035 estiver feito: cortar vídeo pede recodificar ou cortar em quadro-chave); apagar a gravação completa (decisão em aberto abaixo); compilados de várias gravações (fase C).

## Business rules
- BR-1: a gravação completa continua existindo e tocável ao lado das faixas (decisão do dono, 2026-11-03).
- BR-2: uma faixa herda o acervo e as permissões da origem; mover a origem de acervo (KBC-050) move as faixas.
- BR-3: a faixa é cortada sem recodificar; o começo e o fim reais podem diferir do pedido em até um quadro AAC (≈ 23 ms), e o tempo gravado é o real.
- BR-4: a transcrição da faixa é sempre derivada da transcrição atual da origem; uma transcrição nova da origem atualiza as faixas.
- BR-5: reaprovar mantém o identificador de uma faixa quando ela se sobrepõe ≥ 70 % à faixa anterior; quem ouvia mantém a posição (limitada à nova duração), os favoritos e as playlists. Uma faixa que sai da edição é arquivada: some da Biblioteca, mas favoritos e playlists mostram "Faixa removida da edição".
- BR-6: na busca, uma ocorrência dentro de uma faixa aprovada aponta para a faixa (com o título dela) e não repete a gravação completa no mesmo trecho.

## Functional requirements
- FR-1: "Aprovar faixas" (passo 4 do envio guiado, KBC-066 e KBC-072) deve criar trabalhos `cut`; nada é cortado antes dessa aprovação. Deve criar (um por faixa nova ou mudada) e mostrar "Preparando faixas: 3 de 12" a quem edita; as faixas aparecem para quem ouve só quando todas estão prontas. (BR-3)
- FR-2: O worker da VM deve cortar com `ffmpeg -ss <início> -to <fim> -c copy` a partir da versão AAC, com `+faststart`, e devolver a duração real; a API grava os tempos reais. (BR-3)
- FR-3: A API deve derivar a transcrição da faixa (segmentos e palavras dentro do intervalo, tempos menos o início), as legendas e os falantes, e indexá-la no FTS5 na mesma transação. (BR-4, BR-6)
- FR-4: `GET /api/v1/media/{id}` de uma faixa deve trazer `parent` (id, título, início e fim na origem); a página da faixa mostra "Parte de: <gravação> · faixa 3 de 12" com link "Ouvir no contexto" que abre a origem no começo da faixa. (BR-1)
- FR-5: A Biblioteca deve agrupar as faixas sob a gravação para quem tem `media-tracks` e mostrar só a gravação para quem não tem.
- FR-6: Reaprovar deve casar faixas antigas e novas pela sobreposição e aplicar BR-5 numa transação. (BR-5)

## Non-functional requirements
- NFR-1: preparar 12 faixas de uma gravação de 1 h termina em ≤ 60 s no worker da VM (1 CPU), medido no teste de integração com ffmpeg real.
- NFR-2: o espaço extra é ≤ 1,05 × o tamanho da origem (sem recodificar), medido no mesmo teste.
- NFR-3: nenhum corte começa ou termina mais de 50 ms longe do pedido, medido com `ffprobe` no teste.

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-3): Given uma edição com 12 faixas, When quem edita aprova, Then em seguida existem 12 itens de mídia que tocam do começo ao fim certos, com a transcrição e a legenda de cada trecho, e o autor de cada faixa é quem responde quando ele é um autor do acervo (senão, o autor da gravação).
- **AC-2** (BR-1, FR-4): Given as faixas aprovadas, When quem ouve abre a faixa 3, Then vê "Parte de: <gravação> · faixa 3 de 12" e "Ouvir no contexto" abre a gravação completa no começo da faixa.
- **AC-3** (FR-5): Given quem tem `media-tracks`, When abre a Biblioteca, Then vê a gravação com "12 faixas" e as faixas dentro; Given quem não tem, Then vê só a gravação.
- **AC-4** (BR-5): Given uma faixa favoritada e numa playlist, ouvida até 2:10, When a edição é reaprovada com o fim dessa faixa 20 s antes, Then o favorito, a playlist e a posição continuam.
- **AC-5** (BR-5, negativo): Given uma faixa que sai da edição, When reaprovada, Then some da Biblioteca e a playlist mostra "Faixa removida da edição".
- **AC-6** (BR-6): Given uma palavra dita dentro da faixa 3, When alguém busca por ela, Then o resultado é a faixa 3 no minuto certo dela, e a gravação completa não aparece de novo para o mesmo trecho.
- **AC-7** (BR-2): Given a origem movida para outro acervo, When alguém sem acesso ao novo acervo procura a faixa, Then recebe 404.
- **AC-8** (BR-4): Given a origem transcrita de novo, When a nova versão fica atual, Then a transcrição das faixas é atualizada.
- **AC-9** (NFR-3, limites): Given faixas de 5 s e uma no último segundo da gravação, When cortadas, Then a duração real difere ≤ 50 ms do pedido e nenhuma falha.
- **AC-10** (offline, KBC-056): Given uma faixa baixada, When a rede cai, Then ela toca com legenda como qualquer item baixado.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-9 | integração com ffmpeg real (áudio gerado no setup) | `ffprobe` nas durações |
| AC-2, AC-3, AC-10 | E2E (Google Chrome e WebKit) | |
| AC-4, AC-5, AC-8 | integração | |
| AC-6, AC-7 | integração da busca | duas contas |
| NFR-1, NFR-2 | integração | worker com CPU limitada |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0022 (worker e versões), 0024 (busca), 0026 (offline) · KBC-051 a KBC-056 · Telas T15, T16

## Decisão do dono (2026-11-03)
- **As faixas substituem a gravação original ou ficam ao lado dela?** — aprovado o padrão recomendado: ficam ao lado (a gravação completa continua, agrupada com as faixas), porque cortar é reversível só enquanto a origem existe e os originais não são guardados (decisão de 2026-10-28); um "Ocultar a gravação completa da Biblioteca" por gravação pode vir depois, sem apagar o arquivo.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions (ADR 0029 aceita)
- [x] Fits one goal
