# Brief — pesquisar o acervo kb pelo navegador

## Resultado desejado

O dono passa a consultar o acervo ingerido (começando pelo hermetismo) **pelo navegador, toda semana**, em vez de deixar o acervo parado ou recorrer ao terminal. Isso importa porque o acervo custou ~US$ 13 em créditos de IA e horas de conversão: só vale se for consultado.

- **Métrica de resultado (HEART / Engagement):** sessões de pesquisa por semana. Linha de base: 0 pelo navegador; uso do terminal não medido [assumption]. Meta: ≥ 3 sessões por semana nas 4 primeiras semanas.
- **Métrica de entrada (Task success):** % de buscas que terminam com um documento aberto (proxy de "achei o que queria"). Meta: ≥ 50%.
- **Guarda de custo:** gasto em IA por semana ≤ US$ 1 [assumption: teto a confirmar pelo dono].
- **Instrumentação:** log local de eventos (`search`, `filter`, `open_doc`, `ai_answer` com custo), sem dados pessoais. Só dá um antes/depois **não aleatorizado**, já que há um único usuário (sem A/B).

## Oportunidade

Job: "Quando surge uma dúvida de estudo (por exemplo, 'o que é a natureza sétupla?'), quero achar rapidamente o ensinamento nas apostilas, para estudar a partir da fonte e não da memória." [assumption: declarado pelo dono no pedido, não observado]

- **Quem:** o dono (v1); convidados com login (release 2).
- **Lados:** produto de um lado só. O lado do convidado só entra na release 2 (custo de IA por pessoa).

## Evidências

- O acervo tem 4.235 documentos classificados por relevance, genre, depth e 39 conceitos, com 2.068 relações — [evidence: saídas de `kb classify` e `kb link`, 2026-10-23].
- Busca por significado já devolve documentos relevantes sem as palavras exatas ("proteger de energias negativas" trouxe "Meios de defesa contra sugadores") — [evidence: teste `kb search --vec`, 2026-10-23].
- O dono pediu explicitamente para não precisar digitar `kb search`, `--topic` ou `--vec` — [evidence: pedido de 2026-10-23].
- O dono vai usar toda semana — [assumption].

## Soluções candidatas

1. **App Angular estilo chat + backend fino sobre o CLI kb** (escolhida): busca grátis por padrão, IA sob pedido.
2. Usar o Obsidian com plugins de busca: sem custo de desenvolvimento, mas sem busca vetorial nem facetas do kb.
3. Script de terminal interativo (TUI) com menus: mais barato, mas não atende "estilo chat do Claude" nem a release 2 na internet.

## Riscos

| Risco | Nível | Por quê | Como reduzir barato |
|---|---|---|---|
| Valor | Médio | Não se sabe se a pesquisa vira hábito ou fica esporádica | Esqueleto andando em poucos dias e medir sessões por semana desde o primeiro uso |
| Usabilidade | **Alto** | Muitas facetas (relevance, genre, depth, concept, modos de busca) podem virar um painel de controle, não um chat | Nomes em pt-BR leigos, filtros como chips sugeridos a partir dos resultados, padrões sensatos (modo "Tudo", sem filtros); teste com o dono sobre a spec das telas antes de codar |
| Viabilidade técnica | Médio | `kb` 0.0.12 instável; qmd depende do wrapper com Node 24; latência de subprocesso | Adaptador isolado com teste de contrato do JSON; medir p95 no esqueleto |
| Viabilidade de negócio (custo) | Médio | A IA consome créditos limitados (já acabaram uma vez); na release 2, convidados multiplicam o gasto | IA só sob pedido, `--budget` por pergunta, custo estimado mostrado antes, teto diário |

## Suposições mais arriscadas e teste

| Suposição | Importância | Evidência | Teste | Critério de sucesso |
|---|---|---|---|---|
| A busca grátis (sem IA) já basta para a maioria das perguntas | Alta: define custo e UX | Nenhuma | Uso real do esqueleto por 2 semanas: % de perguntas que pedem "Responder com IA" | < 30% das buscas pedem IA |
| Filtros visuais são usados e entendidos | Alta | Nenhuma | Log de eventos `filter` + teste de usabilidade com o dono (plano do `ux-researcher`) | ≥ 1 filtro em ≥ 25% das sessões; o dono explica cada chip sem ajuda |
| A latência é aceitável para chat | Média | O `kb search` responde em segundos no terminal [evidence: testes manuais] | Medir p95 no esqueleto | p95 < 2 s (busca), < 20 s (IA) |

## Recomendação

**Seguir.** Construir o esqueleto andando (pergunta → busca híbrida → resultados → abrir documento) e medir o uso semanal antes de investir em mais facetas. O trade-off principal é escolher a busca grátis como padrão: o resultado fica menos parecido com o Claude, mas garante custo previsível. A IA vem por botão.
