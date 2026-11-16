---
id: KBC-136
title: "Compartilhar: link de documento, de áudio no tempo exato e de trecho, só para quem tem acesso"
status: ready
slice: ui-v2-features
outcome: quem estuda em grupo manda o ponto exato de uma aula ou de um texto para outra pessoa do acervo, sem descrever onde está
depends_on: [KBC-127, KBC-129]
---

# KBC-136 — Compartilhar link

## Story
Quando acho um trecho importante, quero copiar um link que abre o documento ou o áudio exatamente ali, para mandar a quem estuda comigo.

## Scope
**In:** ação **Compartilhar** (ícone no player, no documento e no painel da fonte, e no ⋯ das linhas): copiar link (e o menu de compartilhamento do sistema no celular, `navigator.share`); link de documento (com a ocorrência ou o trecho destacado), de mídia no tempo atual (com a opção de começar em outro tempo) e de trecho citado; quem abre sem acesso vê a tela "Você não tem acesso a este conteúdo" com "Pedir acesso" quando cabe.
**Out:** link público (fora do app), validade do link, compartilhar playlists (KBC-058).

## Business rules
- BR-1: o link não dá acesso a nada: quem abre precisa de sessão e de acesso ao acervo e ao nível de hoje.
- BR-2: o link carrega só o identificador estável do item e a posição (tempo em segundos ou intervalo de caracteres); nada de texto do conteúdo vai na URL.
- BR-3: sem sessão, o link leva ao Entrar e, depois, ao alvo.

## Functional requirements
- FR-1: o web deve gerar os links `/documento/:id#t=<início>-<fim>` e `/midia/:id?t=<segundos>` a partir da posição atual, e copiá-los com o aviso "Link copiado.". (BR-2)
- FR-2: abrir um link de documento deve rolar até o trecho e destacá-lo; abrir um de mídia deve posicionar o player no tempo sem tocar sozinho (como o `?t=` do KBC-041). (BR-1)
- FR-3: sem acesso, a tela deve explicar e oferecer "Pedir acesso" quando o pedido existe para aquele caso; sem sessão, guardar o alvo para depois do Entrar. (BR-1, BR-3)

## Non-functional requirements
- NFR-1: axe sem violação séria; o aviso "Link copiado." é anunciado (região de status).

## Acceptance criteria
- AC-1 (FR-1, FR-2): Given o player em 12:34, When a pessoa copia o link e outra pessoa com acesso o abre, Then o player abre em 12:34 parado.
- AC-2 (FR-2): Given o link de um trecho do documento, When abre, Then a página rola até o trecho, destacado.
- AC-3 (BR-1, negativo): Given uma pessoa sem acesso ao acervo, When abre o link, Then vê "Você não tem acesso a este conteúdo" e nenhum dado do item (título incluso).
- AC-4 (BR-3): Given sem sessão, When abre o link e entra, Then cai no alvo.
- AC-5 (BR-2): Given qualquer link gerado, When se inspeciona a URL, Then só há id e posição.
- AC-6 (celular): Given 390 px com `navigator.share`, When toca Compartilhar, Then abre o menu do sistema; sem a API, copia o link.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-4, AC-6 | E2E | Duas contas |
| AC-3 | integração + E2E | Conta sem acesso |
| AC-5 | unitário | Gerador de link |

## References
Figma: ícone de compartilhar no player e no documento em [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) · Plano: `docs/design/redesign-v2.md` · KBC-041 (`?t=`), KBC-058 (fora: link público)

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
