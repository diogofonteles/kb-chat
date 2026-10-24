---
id: KBC-011
title: Pesquisa mais rápida
status: in-progress
slice: release-1
outcome: a resposta começa a aparecer em até 10 s e termina em até 20 s no modo padrão, sem perder as citações
depends_on: [KBC-008]
---

# KBC-011 — Pesquisa mais rápida

## Story
Quando pergunto ao acervo, quero ver a resposta começar a aparecer logo, como no Claude, e poder pedir uma pesquisa mais funda quando a pergunta merece, para não ficar esperando sem ver nada.

Pedido do dono em 2026-10-24, depois de testar o KBC-008 com a assinatura do Claude: "no teste achei um pouco demorado na resposta". Plano aprovado: "sim, use o sonnet (isso deveria ser configurável), mostre a resposta assim que começar".

Medição no acervo real, com a assinatura do Claude e a pergunta "quais são os 5 princípios ocultos": cerca de 5 s até o CLI começar e ligar o MCP, 14 s de pesquisa (10 passos, quase todos em sequência) e 13 s escrevendo com o modelo padrão (`claude-opus-5-5`). O texto ficava retido até 800 caracteres (regra contra narração do ADR 0006), então o leitor não via nada por cerca de 18 s.

## Scope
**In:**
- Modelo configurável por provedor, inclusive nas assinaturas: um **modelo rápido** e um **modelo profundo** em ⚙ Configurações. Na assinatura do Claude, o rápido é o Sonnet 5.5 e o profundo é o Opus 5.5 (Haiku 5.5 também pode ser escolhido).
- **Perfis "Rápido" e "Profundo"**: um seletor discreto na caixa de pergunta da "Pesquisa com IA". O padrão vem de Configurações e o navegador lembra a última escolha.
- **A resposta aparece assim que começa**: sem a retenção de 800 caracteres, nos dois executores (o laço na API e os CLIs das assinaturas). Texto escrito antes de uma chamada de ferramenta sai da resposta e vai, recolhido, para a linha de passos como "Pensando: …".
- **Menos idas e voltas**: resultados de busca com resumo e trecho mais longos (≈ 400 caracteres), a ferramenta `read_documents` (até 4 documentos numa chamada) e chamadas de ferramenta em paralelo.
- **Aquecimento**: o cache do `find_text` do acervo inicial é montado quando a API sobe.
- **Aprofundamento automático** (decisão de 2026-10-24, alinhada ao dono: nunca responder "não está no acervo" quando uma pesquisa mais funda acharia): uma resposta Rápida que não resolve a pergunta pelo acervo continua, na mesma resposta, com o perfil Profundo. Liga e desliga em Configurações ("Aprofundar automaticamente", ligado por padrão).
- `agent-eval` com `--profile fast|deep`, tempo até o primeiro texto e as ferramentas do acervo servidas ao CLI pelo próprio script.

**Out:**
- Processo do Claude Code mantido aquecido entre perguntas: medido e descartado (ADR 0009).
- Escolher o esforço de raciocínio na tela.
- Mudar o perfil de uma pergunta já feita.

## Business rules
- BR-1: o perfil **Rápido** usa o modelo rápido do provedor, no máximo **6** passos de ferramenta e pede uma resposta focada. O **Profundo** usa o modelo profundo, no máximo **15** passos e o prompt completo (KBC-008 BR-3).
- BR-2: o perfil padrão é o Rápido. Configurações define o padrão; a escolha feita na caixa de pergunta vale para este navegador e prevalece sobre o padrão até o padrão ser mudado em Configurações.
- BR-3: a assinatura do Claude só aceita os modelos que o Claude Code oferece (`sonnet`, `opus`, `haiku`, `fable` e os ids completos). Provedores por token aceitam qualquer id válido (regex do ADR 0007).
- BR-4: o texto da resposta aparece assim que o modelo começa a escrever. Só a primeira frase pode ficar retida (no máximo ~120 caracteres), para descartar um preâmbulo sobre o próprio trabalho ("Tenho tudo o que preciso.").
- BR-5: se o texto já mostrado era o agente pensando alto (a chamada pediu ferramentas depois), ele sai da resposta e aparece recolhido na linha de passos como "Pensando: …". O histórico salvo guarda só o texto da resposta.
- BR-6: cada provedor guarda os próprios modelos; trocar de provedor e voltar recupera a escolha.
- BR-7 *(emenda 2026-10-24)*: com "Aprofundar automaticamente" ligado, quando a pesquisa Rápida não consegue responder por completo pelo acervo (o modelo escreve só o marcador `<<APROFUNDAR>>` com um motivo, ou a resposta diz que o acervo "não nomeia", "não traz", "não há informação", ou "não encontrei"), o texto mostrado sai, aparece o passo "Aprofundando a pesquisa…" e a mesma resposta continua com o modelo profundo, até 15 passos no total, aproveitando o que já foi achado. O leitor nunca vê o marcador.

## Functional requirements
- FR-1: `POST /api/v1/topics/:topic/research` recebe `profile: 'fast' | 'deep'` (padrão `fast`).
- FR-2: os eventos `token` levam `segment` (uma chamada ao modelo = um segmento) e o novo evento `retract { segment }` retira um segmento da resposta.
- FR-3: `GET/PUT /api/v1/settings` trocam `ai.model` por `ai.models[provedor] = { fast?, deep? }` e ganham `preferences.researchProfile`. Um arquivo antigo com `ai.model` vira os dois perfis do provedor salvo.
- FR-4: `GET /api/v1/ai/providers` informa, por provedor, `defaultModels { fast, deep }`, a lista de modelos e se aceita texto livre (`freeModel`).
- FR-5: a web mostra "Rápido | Profundo" na caixa de pergunta da "Pesquisa com IA", com uma linha de ajuda, e "Modelo rápido" e "Modelo profundo" em Configurações (lista fechada na assinatura do Claude, texto livre com sugestões nos provedores por token).
- FR-6: `search_collection` e `find_text` trazem resumo e trecho de ≈ 400 caracteres; o trecho do `find_text` vai mais adiante do que antes da ocorrência. `read_documents(documents[], around?)` lê até 4 documentos, até 6.000 caracteres cada, com um passo "Lendo …" por documento.
- FR-7: as ferramentas MCP declaram `readOnlyHint`, e o prompt pede chamadas em paralelo e leituras em lote.
- FR-8: a API monta o cache do `find_text` do acervo inicial ao subir e registra quanto tempo levou.
- FR-9: `agent-eval` aceita `--profile fast|deep`, serve as ferramentas do acervo ao CLI num endpoint MCP próprio e informa o tempo até o primeiro texto, o tempo de cada passo, os textos recolhidos e quantas respostas foram aprofundadas.
- FR-10: o passo de aprofundamento é `step { kind: 'deepen' }`; `done` traz o modelo profundo e `escalated: true`; `preferences.autoDeepen` (padrão `true`) liga o aprofundamento. No laço da API, a mesma conversa continua com o modelo profundo; nos CLIs, uma segunda execução recebe o que a primeira achou (motivo, passos e documentos numerados) e mantém a numeração [n].

## Non-functional requirements
- NFR-1: no perfil Rápido (padrão), mediana do tempo até o primeiro texto ≤ 10 s no conjunto de 10 perguntas (`apps/api/eval/hermetismo-questions.json`).
- NFR-2: no perfil Rápido, mediana do tempo total ≤ 20 s no mesmo conjunto.
- NFR-3: no perfil Rápido, ≥ 8/10 respostas citam o documento esperado.
- NFR-4: no perfil Profundo, a resposta a "quais são os 5 princípios ocultos" nomeia descontinuidade, limite, movimento, espaço e tempo.
- NFR-5 *(emenda 2026-10-24)*: no perfil Rápido com aprofundamento automático (o padrão), as duas perguntas sobre os 5 princípios ocultos nomeiam os cinco (2/2).

## Acceptance criteria
- **AC-1 (FR-1, BR-1)**
  - Given um roteiro de stub com 20 buscas
  - When o agente roda no perfil Rápido
  - Then ele para em 6 passos e responde com o que tem
- **AC-2 (FR-2, BR-4)**
  - Given um modelo que escreve uma resposta longa
  - When a primeira frase termina
  - Then o texto já chega ao leitor, sem esperar 800 caracteres
- **AC-3 (FR-2, BR-5)**
  - Given um modelo que escreve "Os textos sobre o ritmo são dois." e depois chama uma ferramenta
  - When a chamada de ferramenta chega
  - Then a API envia `retract` daquele segmento
  - And a web tira o texto da resposta e mostra "Pensando: Os textos sobre o ritmo são dois." na lista de passos
  - And o histórico salvo guarda só a resposta
- **AC-4 (FR-5, BR-2)**
  - Given a "Pesquisa com IA" aberta
  - When o leitor escolhe "Profundo" e pergunta
  - Then a requisição leva `profile: 'deep'`
  - And, ao recarregar a página, "Profundo" continua escolhido
- **AC-5 (FR-3, FR-5, BR-3, BR-6)**
  - Given a assinatura do Claude em Configurações
  - When o leitor abre "Modelo rápido"
  - Then vê uma lista com "Padrão: sonnet", `opus`, `haiku`
  - And um `PUT` com um modelo fora da lista recebe 400
- **AC-6 (FR-3)**
  - Given um `settings.json` de antes do KBC-011 com `ai.model: 'opus'` na assinatura do Claude
  - When a API o lê
  - Then os dois perfis da assinatura usam `opus`
- **AC-7 (FR-6)**
  - Given um documento cuja lista vem 220 caracteres depois de "cinco princípios"
  - When o agente usa `find_text`
  - Then o trecho mostra a lista
- **AC-8 (FR-6)**
  - Given 3 referências, uma repetida e uma inexistente
  - When o agente chama `read_documents`
  - Then lê os 2 documentos (até 6.000 caracteres cada), mostra um passo por documento e avisa qual não achou
- **AC-9 (FR-9)**
  - Given a assinatura do Claude e nenhuma API ouvindo na porta configurada
  - When o `agent-eval` roda
  - Then o CLI usa as ferramentas do acervo (passos "Buscando …" no relatório)
- **AC-10 (NFR-1..4)**
  - Given o acervo real e a assinatura do Claude
  - When o `agent-eval` roda com `--profile fast` e com `--profile deep`
  - Then os relatórios ficam em `work/KBC-011/eval-fast.md` e `eval-deep.md`, com as metas acima

- **AC-11 (BR-7, FR-10)**
  - Given o perfil Rápido, o aprofundamento ligado e um modelo que responde `<<APROFUNDAR>> a lista ficou incompleta`
  - When a resposta termina
  - Then o leitor não vê o marcador, aparece "Aprofundando a pesquisa…" e o modelo profundo continua com os resultados já obtidos
  - And `done` traz o modelo profundo e `escalated: true`
- **AC-12 (BR-7)**
  - Given uma resposta Rápida "O acervo não nomeia os cinco princípios."
  - When ela termina
  - Then o texto é retirado e a resposta continua no perfil Profundo
  - And, com "Aprofundar automaticamente" desligado ou no perfil Profundo, a resposta fica como está

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-2, AC-3 (API), AC-7, AC-8 | Unitário e integração da API (stub com roteiro, CLI falso) |
| AC-5 (API), AC-6, AC-9 | Integração da API (`settings.integration`, `eval-session`) |
| AC-3 (web), AC-4, AC-5 (web) | Unitário web + E2E Playwright (stub) |
| AC-11, AC-12 | Unitário da API (stub com dois modelos, CLI falso em duas execuções) + unitário web + E2E da opção em Configurações |
| AC-10, NFR-5 | `agent-eval` no acervo real com a assinatura (sem custo por token) |

## References
- ADR 0009 (pesquisa mais rápida: perfis, streaming com retirada), que emenda o ADR 0006 (regra de narração, teto de passos) e o ADR 0007 (modelo por provedor).
- Telas: `docs/design/screens.md`, T4 (seletor e "Pensando: …") e T6 (modelos por perfil).

## Open questions
Nenhuma. O dono aprovou o Sonnet como padrão e a exibição imediata; os padrões dos outros provedores estão no ADR 0009.

## Definition of ready
- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências
- [x] Dependências feitas
