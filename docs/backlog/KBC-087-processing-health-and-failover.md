---
id: KBC-087
title: "Saúde do processamento e troca entre locais: painel por local e etapa, alerta por e-mail quando a fila para e troca automática quando um local falha"
status: draft
slice: phase-3-server-processing
outcome: nenhuma fila fica parada mais que N + 1 horas sem um master saber; quando um local falha 3 vezes seguidas, os trabalhos seguem para o próximo local permitido sozinhos
depends_on: [KBC-079]
---

# KBC-087 — Saúde do processamento e troca entre locais

## Story
Como master, quero ver em um lugar se cada local de processamento está funcionando e ser avisado quando a fila para, e quero que um local que falha seja pulado sozinho, para o acervo não ficar parado sem ninguém perceber.

## Scope
**In:** painel "Saúde do processamento" (masters): por local (cada computador pareado, servidor, GPU alugada, cada provedor) o visto por último, trabalhos feitos e falhos em 24 h, tempo médio por hora de áudio, gasto do mês; por etapa, o trabalho mais antigo na fila e quais locais poderiam pegá-lo; alerta por e-mail (Gmail SMTP, ADR 0012) aos masters quando o mais antigo de uma etapa passa de N + 1 horas sem local que possa pegá-lo, e quando um provedor responde erro de autenticação ou cota; disjuntor: depois de 3 falhas seguidas de um local, ele fica "Em pausa" por 30 min e os trabalhos vão ao próximo da lista; métricas num `/metrics` novo, só na rede privada (fila por etapa, idade do mais antigo, falhas por local).
**Out:** página de status pública; alertas por SMS ou push; trocar a ordem dos locais sozinho (só pula o que está em pausa).

## Business rules
- BR-1: um local "Em pausa" não recebe trabalhos por 30 min; depois volta e, se falhar de novo, pausa de novo, dobrando até 4 h.
- BR-2: pular um local nunca fura a privacidade (KBC-078) nem os tetos (KBC-086): se o próximo não é permitido, o trabalho espera e o alerta sai.
- BR-3: no máximo um e-mail por etapa e por motivo a cada 6 h; o painel mostra todos.
- BR-4: falha permanente do arquivo (áudio corrompido) não conta para pausar o local (ADR 0022 §2).

## Functional requirements
- FR-1: `GET /api/v1/media/processing-health` (masters) deve devolver os números do painel por local e por etapa.
- FR-2: Ao registrar a 3ª falha seguida (não permanente) de um local, o sistema deve pô-lo em pausa e o despachante deve pulá-lo. (BR-1, BR-4)
- FR-3: A cada 5 min, o sistema deve conferir a idade do trabalho mais antigo por etapa e mandar o alerta quando passar de N + 1 h sem local possível. (BR-2, BR-3)
- FR-4: Um `/metrics` novo (formato Prometheus, só na rede privada, fora do Caddy) deve expor `media_queue_jobs{step}`, `media_queue_oldest_seconds{step}` e `media_location_failures_total{location}`.
- FR-5: O painel deve permitir "Tirar da pausa" e "Pausar" um local.

## Non-functional requirements
- NFR-1: o alerta sai em ≤ 10 min depois do limite (relógio falso no teste).
- NFR-2: o painel abre em ≤ 1 s com 50 locais e 5.000 trabalhos.

## Acceptance criteria
- **AC-1** (FR-2, BR-1): Given o Groq respondendo 500 três vezes seguidas, When chega o 4º trabalho, Then o Groq aparece "Em pausa até <hora>" e o trabalho vai ao próximo local permitido.
- **AC-2** (BR-4, negativo): Given 3 arquivos corrompidos seguidos no servidor, When falham, Then o servidor não entra em pausa.
- **AC-3** (FR-3, BR-2): Given `transcribe` só com o Mac, o Mac parado e N = 12, When o trabalho mais antigo faz 13 h, Then os masters recebem um e-mail "A transcrição está parada há 13 h; nenhum local pode pegar" com o link do painel.
- **AC-4** (BR-3): Given o alerta enviado, When passam 2 h com a fila ainda parada, Then nenhum e-mail novo sai.
- **AC-5** (BR-2, negativo): Given o Groq em pausa e o próximo local proibido pelo acervo, When o despachante roda, Then o trabalho espera e o motivo aparece na mídia.
- **AC-6** (FR-1, permissão): Given uma pessoa sem ser master, When chama o painel, Then 403.
- **AC-7** (FR-4): Given 3 trabalhos `transcribe` na fila, When o `/metrics` é lido, Then `media_queue_jobs{step="transcribe"} 3`.
- **AC-8** (FR-5): Given um local em pausa, When o master clica "Tirar da pausa", Then ele volta a receber trabalhos.
- **AC-9**: painel em 1440 px e 390 px nos três temas, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-5, AC-8 | integração | provedor falso, relógio falso |
| AC-3, AC-4 | integração | SMTP falso |
| AC-6, AC-7 | integração | |
| AC-9 | E2E | axe |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§8), [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0012](../adr/0012-gmail-smtp-email-provider.md) · Itens: KBC-079, KBC-086

## Open questions
- Quem recebe os alertas? Padrão recomendado: todos os masters, com opção de cada um desligar. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
