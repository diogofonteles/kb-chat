---
id: KBC-078
title: "Privacidade do áudio por acervo: o áudio só sai da nossa infraestrutura (VM e computadores pareados) quando o acervo permite, etapa por etapa, com registro de quem marcou e aviso no envio"
status: draft
slice: phase-3-server-processing
outcome: nenhum áudio de um acervo sai para provedor ou GPU alugada sem a marcação do acervo (0 envios indevidos nos testes e no relatório), e quem envia sabe para onde o áudio pode ir antes de enviar
depends_on: [KBC-037, KBC-048]
---

# KBC-078 — Privacidade do áudio por acervo

## Story
Como master responsável por um acervo, quero decidir se o áudio desse acervo pode ser processado fora da nossa infraestrutura, e em quais etapas, para poder usar a nuvem quando o Mac do dono não está disponível sem expor gravações que não podem sair.

## Scope
**In:** campo "O áudio pode sair da nossa infraestrutura?" na edição do acervo (KBC-048), com `Não` (padrão), `Só para transcrever` e `Para transcrever e separar vozes`; lista de provedores permitidos e "GPU alugada" (sim/não) por acervo; sub-acervo herda do pai; registro de quem marcou, quando, a base legal declarada e o texto mostrado; aviso no passo 1 do envio (KBC-072) dizendo onde o áudio pode ser processado; a regra aplicada pelo despachante (KBC-079) e, até ele existir, no modo do Groq do KBC-037; relatório "Privacidade do áudio" com as marcações e os envios para fora por acervo; frase nova na política de privacidade (T11) com provedores e países.
**Out:** escolher a ordem dos locais (KBC-079); os adaptadores dos provedores (KBC-080, KBC-085); perfis de voz, que nunca saem (BR-3); anonimizar ou cortar o áudio antes de enviar.

## Business rules
- BR-1: todo acervo começa com `Não`; nenhum áudio dele vai a provedor na nuvem nem a GPU alugada. Exceção: nenhuma, nem para masters.
- BR-2: só quem tem `media-processing-settings` (masters por padrão) muda a marcação; a mudança exige declarar a base legal (lista: "a instituição detém os direitos e há interesse legítimo", "consentimento dos falantes", "outro: texto") e confirmar o texto mostrado.
- BR-3: impressões de voz (perfis do KBC-071 e reconhecimento) nunca saem da nossa infraestrutura, qualquer que seja a marcação (ADR 0031 §3).
- BR-4: "nossa infraestrutura" é a VM e os computadores pareados por pessoas autorizadas no acervo (KBC-084); enviar a esses não depende desta marcação.
- BR-5: um sub-acervo usa a marcação do acervo pai; não pode ser mais permissivo que o pai.
- BR-6: desmarcar (voltar a `Não`) vale para os trabalhos ainda não enviados: os que esperam são devolvidos para os locais permitidos; um pedido já em andamento num provedor termina e é registrado.
- BR-7: o pedido ao provedor leva só os cortes de áudio (FLAC 16 kHz mono) e, na transcrição, a lista de termos; nunca título, autor, acervo nem nome de pessoa (ADR 0031 §4).

## Functional requirements
- FR-1: `PATCH /api/v1/topics/{slug}/audio-privacy` deve gravar `audioMayLeave` (`no | transcription | transcription-and-voices`), `providers` (lista de ids), `rentedGpu` (bool), `legalBasis` e `noticeVersion`, com quem e quando; sem `media-processing-settings`, 403; sub-acervo mais permissivo que o pai, 422. (BR-2, BR-5)
- FR-2: Antes de entregar um trabalho a um provedor ou à GPU alugada, o sistema deve conferir a marcação efetiva do acervo do áudio e a etapa; se não permitir, o trabalho não sai e a mídia mostra "Este acervo não permite enviar áudio para fora". (BR-1, BR-3)
- FR-3: O passo 1 do envio deve mostrar, para o acervo escolhido, "O áudio fica na nossa infraestrutura" ou "Este acervo permite transcrever com <provedores> (fora do Brasil)". (BR-1)
- FR-4: O relatório "Privacidade do áudio" (masters) deve listar, por acervo, a marcação atual, o histórico de mudanças e quantos áudios e horas foram para cada provedor no mês.
- FR-5: Cada envio a provedor deve gravar um registro (mídia, etapa, provedor, segundos, quando) sem o conteúdo. (BR-7)
- FR-6: Ao voltar para `Não`, o sistema deve devolver aos locais permitidos os trabalhos que esperavam um provedor. (BR-6)

## Non-functional requirements
- NFR-1: 0 pedidos a provedor de acervo com `Não` em 1.000 trabalhos sintéticos com marcações aleatórias (teste de propriedade com fast-check sobre o despachante).
- NFR-2: a conferência da marcação acrescenta ≤ 5 ms por trabalho despachado (p95, medido no teste de integração).

## Acceptance criteria
- **AC-1** (BR-1, FR-2): Given um acervo com `Não` e o Groq ligado, When o Mac fica parado 48 h, Then nenhum pedido vai ao Groq e a mídia mostra "Este acervo não permite enviar áudio para fora".
- **AC-2** (FR-1, FR-2): Given um acervo marcado `Só para transcrever` com o Groq permitido, When um trabalho `transcribe` passa do tempo de reserva, Then ele vai ao Groq e o registro do FR-5 é gravado.
- **AC-3** (BR-3, negativo): Given um acervo `Para transcrever e separar vozes`, When um trabalho `voice-embedding` é despachado, Then ele só vai para o servidor ou um computador pareado, nunca a provedor ou GPU alugada.
- **AC-4** (BR-2, permissão): Given uma pessoa com `media-upload` mas sem `media-processing-settings`, When tenta mudar a marcação, Then recebe 403 e a tela não mostra o controle.
- **AC-5** (BR-5, limite): Given o pai com `Só para transcrever`, When um master marca o sub-acervo com `Para transcrever e separar vozes`, Then 422 "Um sub-acervo não pode permitir mais que o acervo pai".
- **AC-6** (BR-6): Given 3 trabalhos esperando o Groq, When o acervo volta a `Não`, Then os 3 voltam para "Aguardando o transcritor" e nenhum sai.
- **AC-7** (BR-7): Given um envio ao provedor falso, When o teste inspeciona o pedido, Then ele contém só áudio e termos; nenhum título, autor, acervo ou nome.
- **AC-8** (FR-3): Given o passo 1 do envio, When a pessoa escolhe um acervo `Não` e depois um `Só para transcrever`, Then o aviso muda entre os dois textos; leitor de tela anuncia a mudança uma vez.
- **AC-9** (FR-4): Given 2 áudios enviados ao Groq no mês, When o master abre o relatório, Then vê o acervo, a marcação, o histórico e "2 áudios, 1,4 h no Groq".
- **AC-10**: tela da marcação e aviso do envio em 1440 px e 390 px nos três temas, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-6 | integração | provedor falso; relógio falso |
| AC-3 | unitário (despachante) + integração | NFR-1 com fast-check |
| AC-4, AC-5 | integração + E2E | duas contas |
| AC-7 | integração | servidor falso grava o corpo do pedido |
| AC-8, AC-10 | E2E | axe; 1440 e 390 px |
| AC-9 | integração | |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§2 a §4), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) (§3), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (§7) · Itens: KBC-037, KBC-048, KBC-072, KBC-079 · Tela: edição do acervo (KBC-048) e T14; tela nova a especificar com o `product-designer` · Política de privacidade: T11

## Open questions
- O áudio pode sair da nossa infraestrutura, e com qual consentimento? Padrão recomendado: sim, só por acervo marcado por um master, etapa por etapa, padrão `Não`; o master declara a base legal; quem envia vê o aviso; perfis de voz nunca. — owner: dono
- Quais provedores entram na lista e onde processam (país)? Padrão recomendado: Groq (EUA) para transcrição e Modal (EUA) como GPU alugada; pyannoteAI fora. — owner: dono
- Os termos do Groq e do Modal garantem não treinar e apagar após o pedido? A conferir na spec (data e link gravados na configuração); se não garantirem, o provedor não entra na lista. — owner: quem implementar, com aprovação do dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [ ] UI and architecture references linked (ADR 0031 proposta; tela a especificar)
- [ ] Dependencies done or scheduled; no open questions (decisões do dono)
- [x] Fits one goal
