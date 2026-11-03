---
id: KBC-071
title: "Perfis de voz com consentimento: reconhecer, ao editar, quem fala a partir de vozes cadastradas com autorização da pessoa"
status: ready
slice: phase-2-editing
outcome: numa gravação nova de um falante cadastrado, a voz dele já vem sugerida com o nome certo em ≥ 90 % dos casos, sem nenhum perfil de voz de quem não autorizou
depends_on: [KBC-065, KBC-063]
---

# KBC-071 — Perfis de voz com consentimento

## Story
Como quem edita, quero que o sistema reconheça a voz de quem já foi cadastrado (com a autorização dele) e sugira o nome ao separar as vozes, para não precisar nomear o mesmo palestrante em toda gravação.

## Scope
**In:** permissão nova `media-voice-profiles` ("Cadastrar perfis de voz"), só masters por padrão; tela "Perfis de voz": cadastrar o perfil de um falante (KBC-065) a partir de vozes já nomeadas em gravações, só depois de registrar o consentimento (quem autorizou, quando, por qual meio, para qual finalidade, documento anexado ou texto do aceite); o transcritor do Mac calcula a impressão de voz e a API a guarda cifrada (ADR 0017), separada do resto; ao separar vozes (KBC-064), o Mac compara com os perfis do acervo e a API sugere "Voz 1 parece ser Mestre Gabriel (semelhança alta)"; quem edita aceita ou recusa (nunca automático); revogar o consentimento apaga o perfil e as impressões na hora; relatório "Perfis e consentimentos" para o dono; política de privacidade (T11) atualizada.
**Out:** perfil de quem pergunta da plateia; reconhecimento entre acervos diferentes; aplicar nomes sem confirmação; identificar pessoas fora das gravações do acervo.

## Business rules
- BR-1: impressão de voz ligada a uma pessoa é dado biométrico, dado pessoal sensível na LGPD (art. 5º, II; tratamento pelo art. 11); só existe perfil com consentimento específico e destacado registrado antes, para a finalidade "sugerir o nome ao editar gravações do acervo". Pessoas falecidas: só com autorização escrita de quem responde pela obra (decisão do dono, 2026-11-03).
- BR-2: revogar o consentimento apaga o perfil, as impressões e as sugestões pendentes em até 1 minuto; os nomes já confirmados por uma pessoa nas gravações continuam (foram dados à mão).
- BR-3: a sugestão por voz só aparece acima do limiar escolhido no KBC-063 (falso positivo ≤ 2 % no teste) e sempre como sugestão.
- BR-4: o perfil vale só no acervo onde foi cadastrado (e nos sub-acervos dele).
- BR-5: as impressões nunca saem da API para o navegador; o transcritor recebe as do acervo do trabalho só durante o trabalho e as apaga ao terminar.

## Functional requirements
- FR-1: `POST /api/v1/topics/{slug}/voice-profiles` deve exigir um consentimento registrado (`consent`: quem, data, meio, finalidade, anexo ou texto) e as vozes de origem; sem consentimento, 422. (BR-1)
- FR-2: O trabalho `voice-profile` deve calcular a impressão no Mac a partir das vozes de origem e a API deve guardá-la cifrada. (BR-5)
- FR-3: No trabalho `diarize`, o transcritor deve comparar as vozes com os perfis do acervo e enviar só o perfil mais próximo e a semelhança por voz; a API mostra a sugestão acima do limiar. (BR-3, BR-4, BR-5)
- FR-4: `DELETE /api/v1/voice-profiles/{id}` (revogar) deve apagar o perfil, as impressões e as sugestões pendentes e registrar a revogação no relatório. (BR-2)
- FR-5: O relatório "Perfis e consentimentos" deve listar perfis, consentimentos, revogações e quantas sugestões cada perfil gerou.

## Non-functional requirements
- NFR-1: acerto do nome sugerido ≥ 90 % e falso positivo ≤ 2 % nas gravações de teste do KBC-063 com 3 perfis.
- NFR-2: revogação completa em ≤ 1 minuto, medida no teste de integração.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given um master sem consentimento registrado, When tenta cadastrar o perfil, Then a API responde 422 e a tela pede o consentimento primeiro.
- **AC-2** (FR-2, FR-3): Given o perfil de "Mestre Gabriel" com consentimento e uma gravação nova dele, When as vozes são separadas, Then a voz dele vem com "parece ser Mestre Gabriel" e só vira nome quando quem edita aceita.
- **AC-3** (BR-2, FR-4): Given o perfil usado em 4 gravações (2 nomes confirmados, 2 sugestões pendentes), When o consentimento é revogado, Then o perfil e as impressões somem, as 2 sugestões pendentes somem e os 2 nomes confirmados ficam.
- **AC-4** (BR-3, negativo): Given uma voz parecida mas abaixo do limiar, When separada, Then nenhuma sugestão aparece.
- **AC-5** (BR-4): Given o perfil cadastrado na "UDV", When uma gravação de outro acervo é separada, Then o perfil não é comparado.
- **AC-6** (BR-5): Given um trabalho `diarize` terminado, When o teste procura impressões no Mac e nas respostas da API ao navegador, Then não há nenhuma.
- **AC-7** (permissão): Given quem tem `media-edit` sem `media-voice-profiles`, When abre "Perfis de voz", Then não vê a tela (403).
- **AC-8** (FR-5): Given perfis e uma revogação, When o dono abre o relatório, Then vê cada consentimento, a revogação com data e as contagens.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-5, AC-7, AC-8 | integração + E2E | |
| AC-2, AC-4 | integração com transcritor falso + 1 execução manual no Mac | |
| AC-6 | pytest no `tools/transcriber` + integração | |
| NFR-1 | manual na validação local | gabarito do KBC-063 |

## References
LGPD (Lei 13.709/2018), art. 5º, II e art. 11 · ADR 0017 (segredos cifrados), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · Tela T11 (política de privacidade) · Pesquisa: KBC-063 (modelo de impressão de voz e limiar) · `docs/product/context.md` (Lei aplicável: LGPD)

## Decisão do dono (2026-11-03)
- **Identificar pessoas reais pela voz (dado biométrico, LGPD): quem pode ter perfil e quem autoriza?** — aprovado o padrão recomendado: só pessoas vivas que assinarem um consentimento específico (texto pronto na tela, com finalidade, guarda e como revogar), cadastrado por um master; nunca quem pergunta da plateia; para mestres e autores falecidos, só com autorização escrita de quem responde pela obra (a instituição ou os herdeiros), registrada do mesmo jeito; sem consentimento, só o nome manual do KBC-065 e a sugestão por contexto do KBC-067, que não usam a voz. Isto é orientação prática, não parecer jurídico; o dono pode consultar um advogado antes de ligar a funcionalidade em produção.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
