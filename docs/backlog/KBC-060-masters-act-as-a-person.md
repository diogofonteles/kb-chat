---
id: KBC-060
title: "Ver como outra pessoa: o master usa o app com a visão e os dados de alguém, com auditoria"
status: ready
slice: phase-2-a
outcome: o master reproduz em minutos o problema que uma pessoa relata e corrige a configuração dela, sem pedir prints nem a conta da pessoa
depends_on: [KBC-010]
---

# KBC-060 — Ver como outra pessoa

## Story
Como master, quero usar o app como uma pessoa específica (ver o que ela vê, com os acervos, permissões e dados dela), para entender os problemas que ela relata e ajustar as configurações dela.

## Scope
**In:** permissão "Ver como outra pessoa" (dada pelo dono a cada master); "Ver como" em "Pessoas e permissões", com motivo obrigatório; faixa fixa em todas as páginas com o nome, o tempo restante e "Voltar para a minha conta"; até 30 min; tudo o que a pessoa vê e faz, com os acervos, permissões e dados dela; auditoria (início, fim e cada escrita) visível aos masters com a permissão; "Acessos à sua conta" em Configurações para a pessoa ver quem entrou, quando e por quê; política de privacidade atualizada.
**Out:** modo só leitura (pode virar outra permissão depois); ver como o dono ou como outro master; várias pessoas ao mesmo tempo.

## Business rules
- BR-1: só quem tem "Ver como outra pessoa" pode iniciar; o dono a tem sempre e a dá ou tira de cada master; não vem junto com o papel de master (regra do dono: toda funcionalidade é liberada por pessoa).
- BR-2: não é possível ver como o dono nem como outro master.
- BR-3: enquanto vê como a pessoa, o master tem exatamente os acervos, as permissões e o papel dela (nada a mais).
- BR-4: ficam só da pessoa: entrar e sair da conta dela, conta Google e e-mail, chaves de IA próprias (não aparecem, não trocam, não apagam), assinaturas conectadas, apagar a conta e gastar dinheiro dela (IA com a chave dela é recusada com aviso).
- BR-5: a sessão "ver como" termina em 30 min, em "Voltar para a minha conta", ao sair da conta e quando o master perde a permissão ou a pessoa perde o acesso ao app.
- BR-6: início, fim e cada escrita ficam na auditoria com o master, a pessoa, o motivo, a rota e a hora; a auditoria fica 12 meses e não pode ser editada.
- BR-7: a pessoa vê em "Acessos à sua conta" cada sessão: quem, quando, quanto tempo e o motivo.

## Functional requirements
- FR-1: `POST /api/v1/people/{id}/act-as` com `{ reason }` (permissão BR-1) deve iniciar a sessão e devolver o fim previsto; `DELETE /api/v1/act-as` deve encerrar. (BR-1, BR-2, BR-5)
- FR-2: com a sessão ativa, toda rota deve rodar com o principal, os acervos, as permissões e o papel da pessoa; `GET /api/v1/me` deve dizer `actingAs: { personId, name, endsAt }` e o master real. (BR-3)
- FR-3: as rotas do BR-4 devem responder 403 `NOT_WHILE_ACTING` com a mensagem "Isto só a própria pessoa pode fazer." (BR-4)
- FR-4: cada escrita durante a sessão deve gerar uma linha de auditoria; início e fim também. (BR-6)
- FR-5: a tela deve mostrar a faixa fixa em todas as páginas ("Você está vendo como Ana Souza · termina em 29:41 · Voltar para a minha conta"), anunciada a leitores de tela ao começar e 1 min antes do fim. (BR-5)
- FR-6: "Pessoas e permissões" deve ter "Ver como" em cada pessoa elegível (diálogo com motivo) e a aba "Auditoria" com filtros por pessoa e por master. (BR-1, BR-6)
- FR-7: "Configurações → Acessos à sua conta" deve listar as sessões de que a pessoa foi alvo. (BR-7)
- FR-8: a política de privacidade deve explicar o "ver como" e a auditoria. (BR-7)

## Non-functional requirements
- NFR-1: com a sessão ativa, nenhuma rota fica mais de 20 ms mais lenta (p95 no teste de integração com 200 requisições).
- NFR-2: a auditoria resiste a queda do processo: cada linha é gravada antes da resposta (append + fsync) e não pode ser reescrita pela API.

## Acceptance criteria
- **AC-1** (FR-1, FR-2, BR-3): Given o dono e a Ana (membro, só o acervo UDV e "Ouvir mídia"), When o dono escolhe "Ver como" na Ana com o motivo "não vê os marcadores", Then o seletor de acervo mostra só a UDV, a Mídia mostra os marcadores da Ana e a faixa diz "Você está vendo como Ana".
- **AC-2** (FR-6, BR-3): Given a sessão como Ana, When o master tenta abrir "Pessoas e permissões", Then não consegue (a Ana não é master).
- **AC-3** (BR-2): Given outra pessoa master, When alguém tenta "Ver como" nela ou no dono, Then a API recusa (403) e a opção nem aparece.
- **AC-4** (BR-1): Given um master sem a permissão, When chama `POST …/act-as`, Then recebe 403 e não vê "Ver como".
- **AC-5** (FR-3, BR-4): Given a sessão como Ana, When o master tenta trocar a chave de IA dela, apagar a conta ou pesquisar com a IA da chave dela, Then vê "Isto só a própria pessoa pode fazer." e nada muda.
- **AC-6** (FR-4, BR-6): Given a sessão como Ana, When o master muda a velocidade padrão dela, Then a mudança vale para a Ana e a auditoria tem a linha com o master, a Ana, o motivo e a rota.
- **AC-7** (BR-5): Given a sessão iniciada há 30 min, When o master faz qualquer ação, Then a sessão já terminou, a faixa some e ele está na própria conta.
- **AC-8** (FR-7, BR-7): Given duas sessões como Ana, When a Ana abre "Acessos à sua conta", Then vê as duas, com quem, quando, duração e motivo.
- **AC-9** (FR-1): Given um motivo vazio, When o master tenta iniciar, Then o diálogo mostra o erro no campo e nada começa.
- **AC-10** (acessibilidade): faixa, diálogo e auditoria funcionam só com teclado, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-6, AC-7 | integração + E2E | relógio falso para os 30 min |
| AC-3, AC-4, AC-5 | integração | todas as rotas do BR-4 cobertas por uma tabela |
| AC-8, AC-9 | componente + E2E | |
| AC-10 | E2E | axe |
| NFR-1 | integração com medição | |
| NFR-2 | unitário do adaptador de auditoria | |

## References
ADR [0027](../adr/0027-masters-act-as-a-person.md) (altera a 0008) · Permissões: KBC-010, ADR 0008 · Tela: `docs/design/screens.md` T6 (Configurações), T9 (Pessoas e permissões), T11 (privacidade); a faixa e o diálogo entram na spec do item

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
