# Visão — Nova Alexandria

Nome do produto decidido pelo dono em 2026-10-25 (KBC-016): **Nova Alexandria**. A Biblioteca de Alexandria guardava o conhecimento do mundo antigo, e é em Alexandria que surge o Corpus Hermeticum: uma biblioteca de conhecimento universal com núcleo esotérico (o hermetismo) que também vai guardar outras ciências. O repositório e os identificadores internos continuam `kb-chat`.

## Por que estamos aqui (KB-01)

Pesquisar o que já foi ingerido no kb, pelo navegador e numa conversa, sem precisar de comandos.

## Visão (template de Moore, KB-02)

> **Para** quem estuda um acervo ingerido no kb (começando pelo dono e o hermetismo)
> **que** precisa achar ensinamentos espalhados em milhares de apostilas, mas só consegue pelo terminal,
> **a Nova Alexandria é** uma página de pesquisa em forma de chat
> **que** encontra trechos e documentos por palavra ou por significado, com filtros visuais, e, quando pedido, escreve uma resposta citando as fontes.
> **Diferente** de digitar `kb search` e `kb find` com flags no terminal ou de abrir arquivos no Obsidian,
> **nosso produto** entende a pergunta em linguagem natural, mostra os filtros como chips clicáveis e leva direto ao trecho de origem.

## É / não é / faz / não faz

| É | Não é |
|---|---|
| Uma interface de pesquisa sobre o vault kb | Um editor do vault ou do Obsidian |
| Chat com histórico da sessão | Um assistente geral (só responde a partir do acervo) |
| Genérico para tópicos do kb | Um app exclusivo do hermetismo |

| Faz | Não faz |
|---|---|
| Busca híbrida, por palavra e por significado (QMD) | Ingerir, classificar ou ligar documentos (continua no CLI) |
| Filtros: tópico, genre, relevance, depth, concept | Trabalhar as filas do `kb review` |
| Leitura do documento completo, com o trecho destacado | Gerar artigos de wiki |
| "Responder com IA" sob pedido, com custo estimado | Chamar IA sem o usuário pedir |

## Lista NÃO (KB-03)

| DENTRO (release 1, local) | FORA | Em aberto |
|---|---|---|
| Caixa de pergunta estilo chat | Login e convites (release 2) | Hospedagem: VPS própria ou Fly.io? (release 2) |
| Três modos de busca com nomes amigáveis: "Tudo" (híbrida), "Palavras exatas" (lex), "Por significado" (vec) | Deploy na internet (release 2) | Limite diário de IA por convidado: valor (release 2) |
| Chips de filtro (relevance, genre, depth, concept) com contagens | Ingestão e upload de arquivos pela UI | |
| Lista de resultados com título, trecho e facetas | Edição de documentos | |
| Painel do documento completo | Multiusuário e histórico persistente entre dispositivos | |
| "Responder com IA" (`kb find` + modelo) com fontes citadas e custo mostrado | Voz, OCR e imagens | |
| Seletor de tópico (lista do `kb topic list`) | App mobile nativo (a web responsiva basta) | |
| "Veja também" no painel do documento (relações `example_of`, `extends` e `related`) | | |

## Riscos (KB-04)

**Que a equipe pode tratar**
1. A latência do `kb search` (processo + qmd, que roda em Node 24 via wrapper) deixar o chat lento: medir no esqueleto; se passar de 2 s, manter o qmd aquecido ou ler o SQLite direto.
2. Custo da IA fora de controle: orçamento por pergunta (`--budget`), custo mostrado antes e depois, e teto diário configurável.
3. Resposta da IA inventar coisas fora do acervo: o prompt só responde a partir dos trechos e cita cada afirmação.

**Fora do controle**
4. Mudanças no CLI `kb` ou no formato JSON (versão 0.0.12, ainda instável): isolar num adaptador com testes de contrato.
5. Disponibilidade e preço da OpenRouter.

## Trade-offs (KB-05)

- **Fixo:** custo (só o que for pedido) e qualidade das fontes (toda resposta traz links).
- **Flexível:** escopo (filtros e recursos entram ou saem por release); prazo.
- **Qualidade mais importante:** **encontrar rápido o trecho certo** (relevância + latência), à frente de polimento visual.

## Tamanho (KB-06 / KB-07)

Ordem de grandeza de **semanas** para a release 1 local (um frontend Angular + um backend fino sobre o CLI kb). Viável. Release 2 (login e hospedagem) em mais algumas semanas.

## MVP

- **Tipo:** fatia vertical (vertical slice) usada de verdade pelo dono, com UX caprichada nas buscas e nos filtros.
- **Hipótese:** com chat, filtros visíveis e leitura direta, o dono pesquisa o acervo pelo navegador toda semana.
- **Métrica de perseverar/pivotar:** sessões de pesquisa por semana e % de buscas que terminam abrindo um documento. Perseverar se ≥ 3 sessões/semana nas primeiras 4 semanas.
- **Persona:** estudante do acervo (o dono). Jornadas: perguntar → refinar com filtros → ler o trecho → pedir resposta com IA.
- **Custo e prazo:** desenvolvimento próprio; IA paga por uso (centavos por pergunta).

## Propriedade (KB-08)

Repositório, credenciais (OpenRouter) e vault ficam com o dono.

## Aceite

Visão e lista NÃO aceitas pelo dono em 2026-10-23, com o "veja também" incluído na release 1.
