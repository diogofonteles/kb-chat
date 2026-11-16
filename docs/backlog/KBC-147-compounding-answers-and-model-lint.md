---
id: KBC-147
title: "Wiki que se acumula: respostas boas viram páginas, e um lint com modelo aponta contradições e lacunas"
status: ready
slice: complete-answers
outcome: o mapa do acervo melhora com o uso (respostas aprovadas viram páginas ligadas aos assuntos) e fica consistente (contradições e lacunas vão para a revisão), como o padrão de wiki compilado de Karpathy pede
depends_on: [KBC-141, KBC-144]
---

# KBC-147 — Respostas que se acumulam e lint com modelo

## Story
Como dono, quero que uma boa resposta do Profundo vire parte do mapa do acervo e que o mapa aponte sozinho onde se contradiz ou tem lacunas, para o acervo ficar mais completo e coerente a cada uso.

## Scope
**In:**
- **Guardar no acervo:** um master marca uma resposta do Profundo como boa. Ela vira uma página em `outputs/queries/` com as citações, ligada aos nós da árvore; depois da revisão, é promovida a página do wiki. A próxima pergunta sobre o mesmo assunto recebe a página como mais uma fonte compilada.
- **`kb-map lint`,** periódico (semanal) e depois de cada backfill:
  - contradições entre páginas e entre autores, sempre separando o Mestre Laércio dos outros;
  - afirmações superadas por fontes mais novas;
  - entidades e conceitos citados sem página própria;
  - páginas órfãs;
  - lacunas, que são aspectos com uma fonte só.

  O resultado vai para a fila de revisão do kb e para um relatório em `outputs/reports/`.

**Out:** busca na web para preencher lacunas; edição das páginas pelo app.

## Business rules
- BR-1: só um master guarda uma resposta no acervo, e só respostas com todas as citações verificadas (KBC-145).
- BR-2: uma página de resposta nunca substitui as fontes: ela cita as seções, e a checagem do KBC-141 continua valendo só sobre as fontes.
- BR-3: o lint não muda nenhuma página sozinho; ele propõe, e a revisão decide.
- BR-4: uma página de resposta respeita o nível de acesso das fontes que cita. Só a vê quem vê todas elas.

## Functional requirements
- FR-1: a resposta do Profundo deve ter "Guardar no acervo" para masters. A API manda a página para o Mac pelo mesmo caminho do `kb-publish` (a API não escreve no vault, Q7). (BR-1, BR-4)
- FR-2: `kb-map lint <topic>` deve produzir os achados do escopo com a página e as seções envolvidas, e gravá-los na fila de revisão e no relatório. (BR-3)
- FR-3: a montagem do Profundo (KBC-144) deve incluir as páginas de resposta dos nós da pergunta como fonte compilada, com o mesmo filtro de nível. (BR-2, BR-4)

## Non-functional requirements
- NFR-1: o lint do Hermetismo inteiro custa ≤ US$ 2 com o modelo barato e roda em ≤ 1 h.

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given uma resposta com citações verificadas, When um master usa "Guardar no acervo", Then a página aparece no vault depois do próximo `kb-publish`, ligada aos nós da pergunta.
- AC-2 (BR-1, negativo): Given um membro, When ele vê a resposta, Then não há "Guardar no acervo".
- AC-3 (BR-4, permissão): Given uma página de resposta que cita uma seção de nível alto, When Ana (nível baixo) pergunta sobre o assunto, Then a página não é usada nem citada (suíte de vazamento).
- AC-4 (FR-2): Given duas páginas que dizem o oposto sobre um aspecto, When o lint roda, Then a contradição entra na fila de revisão com as duas seções.
- AC-5 (BR-3): Given o lint com achados, When termina, Then nenhuma página do wiki foi alterada.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2 | integração (API) + E2E | Transcritor stub |
| AC-3 | integração | `levels-leakage` estendida |
| AC-4, AC-5 | unitário (pytest) | Provedor fake |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §2a · gist de Karpathy sobre wiki compilado (2026-04-04) · ADR 0035 (kb-publish) · KBC-141, KBC-144, KBC-145

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
