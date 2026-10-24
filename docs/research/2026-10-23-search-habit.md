# Plano: busca grátis e filtros no kb-chat

**Decisão que informa:** priorizar a release 2 entre investir em IA (respostas, conversa com contexto) e investir em busca e filtros, e fixar o teto diário de IA. **Prazo:** 4 semanas após o esqueleto andando.

**Perguntas de pesquisa:**
1. A busca grátis resolve a maioria das dúvidas de estudo?
2. Os filtros (relevância, tipo, profundidade, conceito) são entendidos e usados?

**Suposições mais arriscadas** (de `docs/product/brief.md`):
1. "A busca grátis basta para a maioria das perguntas".
2. "Filtros visuais são usados e entendidos".

**Método:**
- Uso real instrumentado (log de eventos local) por 4 semanas.
- Diário curto de 1 linha por sessão.
- 1 teste de usabilidade moderado (think-aloud) com 1 a 2 pessoas de fora.

**Por que:** comportamento observado vale mais que opinião (RM; regra 2). Com um único usuário, nenhum número vira estatística: tudo é leitura qualitativa, antes e depois, não aleatorizada (UT; regra 3).

**Alternativa mais barata:** só o log de eventos, sem diário e sem teste de usabilidade. Perde o "por quê" de pedir IA.

## Participantes

- **Fase 1 (uso real):** o dono, único usuário da v1.
- **Fase 2 (teste de usabilidade):** 1 a 2 colegas de estudo do hermetismo, que serão convidados na release 2. Recrutamento pela rede do dono. Sem incentivo.
- **Triagem:** já estudou o material da escola hermética e nunca usou o kb.
- O dono não serve como participante do teste: conhece o kb e a intenção do design.

## Roteiro e tarefas

**Diário** (fase 1, ao fim de cada sessão, 1 linha):

> "O que você queria achar? Achou (sim / em parte / não)? Precisou da IA? Por quê?"

**Teste moderado** (fase 2, ~30 min, remoto, compartilhando a tela, no esqueleto rodando no Mac do dono). Antes do teste real, fazer um piloto com o próprio dono.

1. "Você lembra de algum assunto que estudou nas apostilas e quis rever? Procure-o." O que observar: a pessoa digita a pergunta? Usa algum modo de busca?
2. "Encontre só os textos mais aprofundados sobre esse assunto." O que observar: ela descobre o chip de profundidade sem ser guiada?
3. "Ache material sobre Cabala que não seja apostila de aula." O que observar: combina o filtro de conceito com o de tipo?
4. "Peça uma resposta resumida e verifique de onde ela veio." O que observar: entende o custo mostrado? Abre a fonte citada?

Depois de cada tarefa, aplicar o SEQ (1 a 7). As tarefas não usam os nomes dos rótulos da interface, para não induzir a resposta.

## Métricas e critério de sucesso

| Sinal | Fonte | Leitura |
|---|---|---|
| % de buscas com "Responder com IA" | log | < 30% sustenta a suposição 1 |
| % de sessões com ≥ 1 filtro | log | ≥ 25% sustenta a suposição 2 |
| % de buscas que abrem um documento | log | ≥ 50% = a busca encontra |
| Sucesso por tarefa e SEQ | teste | Cada tarefa reprovada vira um achado com a causa; nenhuma média é tirada com n = 2 |
| Motivos para pedir IA | diário | Temas recorrentes, por exemplo "queria síntese" ou "a busca não achou" |

## Consentimento e dados

- **Log local:** só eventos e texto das consultas, gravado no Mac do dono (`~/.kb-chat/events.jsonl`). Sem envio externo. Retenção de 90 dias.
- **Teste:** consentimento verbal e por escrito para gravar áudio e tela, revogável. Os participantes aparecem pseudonimizados (P1, P2) no relatório. Os vídeos são apagados depois da síntese (≤ 30 dias).
- **Lei aplicável:** LGPD (Brasil). O responsável é o dono. Isto é orientação prática, não parecer jurídico.

## Análise e entrega

- **Semana 4:** o agente sintetiza log + diário + notas do teste em `docs/research/<data>-search-habit-report.md`, com temas, evidências e recomendação para a release 2.
- **O que o humano roda:**
  - usar o app;
  - manter o diário;
  - recrutar e moderar o teste, ou pedir que o agente prepare o roteiro final.
