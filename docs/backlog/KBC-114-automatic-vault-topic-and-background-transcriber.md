---
id: KBC-114
title: "Pasta do acervo no vault criada sozinha, transcrições pendentes publicadas por um clique e transcritor em background com status no app"
status: ready
slice: phase-2-research-media
outcome: um acervo criado no app que recebe uma transcrição vira documento pesquisável sem nenhum passo manual no Mac; o master vê quantas transcrições ainda não são documentos e as publica de onde vê "0 documentos"; o transcritor fica ligado sozinho e o app mostra em que pé ele está
depends_on: [KBC-099, KBC-100, KBC-036, KBC-048]
parent: KBC-098
---

# KBC-114 — Pasta do acervo automática, pendentes por um clique e transcritor em background

*Pedido do dono, 2026-11-09 (URGENTE, texto literal em `work/KBC-114/request.md`):* "isso de criar a pasta no vault deveria ser automatico atraves do proprio app … Para os audios que ja inserimos antes, o app deveria identificar quais as transcricoes que ainda nao viraram doc e o usuario poder acionar isso, e isso deveria já criar o vault necessario, a autorizacao ja estaria implicita (deveria tambem ligar o transcritor em background, mostrando no app esse status e com a opcao de ver os detalhes se clicar)".

*Correção do diagnóstico (coordenador, 2026-11-09):* o acervo UDV já tinha pasta (`udv`, com o sub-acervo `udv/palavra-do-mestre` dentro). O bloqueio real era nenhum transcritor com `kb-publish` e nenhum rodando. A pasta automática continua no escopo para os acervos novos, e precisa reconhecer uma pasta que já existe (inclusive a do sub-acervo dentro da do pai) e nunca recriá-la.

*Exigência do dono, 2026-11-09 (literal):* "eu ja tinha dito que o transcritor tem que ser ligado automaticamente quando eu envio um audio!", "isso nao pode depender de eu ligar manualmente", "ele pode ate desligar o transcritor quando termina, mas ao enviar um audio ele deve ligar", sobre os extras: "isso tambem deve ser feito em segundo plano sempre que necessario", e sobre a fila de Vozes: "nao deve ficar parado em nenhuma fila como está agora … isso deve ser automatico no proprio app". Entram BR-12 a BR-14, FR-11 a FR-13 e AC-15 a AC-17.

## Story
Como master, quero que um acervo criado no app vire documentos pesquisáveis assim que recebe uma transcrição, sem abrir o terminal do Mac, e ver de onde estou se o transcritor está ligado e o que ele está fazendo, para nunca mais descobrir que "0 documentos" era um passo manual esquecido.

## Scope
**In:**
- Pasta do acervo no vault criada pelo transcritor do Mac com `kb topic new <slug> <título> <domínio>` no primeiro `kb-publish` do acervo, sub-acervo incluído (`pai/filho`, dentro da pasta do pai, criando o pai antes se faltar); idempotente; uma pasta com `topic.yaml` nunca é recriada; uma pasta sem `topic.yaml` recusa o job com o motivo; caminhos verificados como no KBC-099.
- O job `kb-publish` leva o que o Mac precisa: `collection { title, domain, parent }`.
- Fim da recusa do KBC-100 AC-12: acervo criado na tela também tem documentos e jobs (autorização implícita).
- Publicar por padrão: transcritor pareado de agora em diante já vem com **Publica no acervo**; o transcritor com vault configurado e `kb` no PATH pede `kb-publish` sem marca nenhuma no Mac; `--no-kb-publish` desliga. A caixa **Publica no acervo** continua em Transcritores (status e opção de desligar).
- Transcrições pendentes: faixas **e** gravações sem faixas que ainda não são documento, por acervo (inclusive os sem pasta no vault), com contagem e custo estimado; ação de master em Transcritores (a do KBC-099, que passa a contar as duas) e um aviso no acervo, onde aparece "0 documentos": "N transcrições ainda não são documentos — Publicar".
- Transcritor em background: `transcriber service install|uninstall|status` (LaunchAgent do macOS, RunAtLoad sem KeepAlive — BR-15 —, logs em `~/Library/Logs/nova-alexandria-transcriber/`, ambiente com `KB_CHAT_VAULT` e `PATH` com uv, kb e ffmpeg; nenhum token no plist).
- Status do transcritor: o worker manda um sinal de vida com estado (ocioso, trabalhando em X, aguardando Y, erro), versão, job atual com progresso, últimos jobs, contagens, último erro, pasta do vault e versão do kb; o app mostra um selo de status para masters em Transcritores e no aviso do acervo, e o clique abre os detalhes.
- Desligado: o app mostra o comando exato para ligar; só com a API no mesmo Mac em desenvolvimento (`KB_CHAT_LOCAL_TRANSCRIBER=1`, recusado em produção), o botão **Ligar transcritor** roda `launchctl kickstart -k gui/<uid>/br.com.nova-alexandria.transcriber` sem shell.

**Out:**
- Envio de texto pelo app (KBC-009 não existe ainda): quando existir, o primeiro documento de texto de um acervo novo cria a pasta pelo mesmo caminho (o job `kb-publish` com `collection`). Aqui só a transcrição de áudio gera documento.
- Ligar o Mac pelo app em produção (a API roda na VM e não alcança o Mac; o serviço do launchd é que mantém o transcritor ligado).
- Status persistido entre reinícios da API (o sinal de vida chega a cada 30 s).
- Instalar o serviço no Mac do dono e publicar as pendentes de verdade: rollout do coordenador depois do merge (`work/KBC-114/rollout.md`).

## Business rules
- BR-1: a API nunca escreve no vault (Q7); a pasta é criada pelo `kb` no Mac, dentro da trava de publicação, antes de escrever os documentos.
- BR-2: uma pasta é "do kb" quando tem `topic.yaml`; com ela, `kb topic new` nunca roda. Uma pasta sem `topic.yaml` no lugar do acervo recusa o job ("a pasta existe sem topic.yaml") e nada é escrito.
- BR-3: sub-acervo `pai/filho` (um nível só, ADR 0028) é criado com `kb topic new pai/filho …`, que o kb 0.0.12 põe dentro da pasta do pai (`category: pai`, `path: pai/filho`, como `udv/palavra-do-mestre`); sem a pasta do pai, o pai é criado antes com o título e o domínio dele.
- BR-4: o domínio de um acervo novo é o do pai (sub-acervo); senão, o mais usado entre os acervos do vault (empate: ordem alfabética); sem nenhum, `geral`. O documento renderizado leva o mesmo domínio (o `kb lint` o exige).
- BR-5: só slugs do contrato (`[a-z0-9-]`, no máximo `pai/filho`), resolvidos dentro do vault, e o `parent` do job tem de ser o primeiro segmento do slug; qualquer outra coisa recusa o job antes de o kb rodar.
- BR-6: autorização implícita: um acervo conhecido do app (do vault ou criado na tela) tem documentos; o teto mensal da mídia continua valendo (KBC-100 BR-6).
- BR-7: um transcritor pareado de agora em diante vem marcado **Publica no acervo**; o Mac só pede `kb-publish` com vault configurado e `kb` no PATH; `transcriber run --no-kb-publish` nunca pede. Os já pareados mantêm a marca que têm (o do dono já a tem).
- BR-8: "transcrição pendente" é uma faixa publicada, pronta, não arquivada, com transcrição, ou uma gravação pronta, não arquivada, transcrita e que nunca teve faixa, sem documento ainda. Publicar é só de masters, idempotente, e respeita o teto.
- BR-9: o status do transcritor é o último sinal de vida dele; sem sinal há mais de 2 min, "Desligado" (com "visto por último"). Estados: **Ocioso**, **Trabalhando** (no quê, com %), **Aguardando** (o quê), **Erro** (a mensagem). Só o token pareado manda o próprio status; o da VM não.
- BR-10: **Ligar transcritor** só existe com `KB_CHAT_LOCAL_TRANSCRIBER=1` e fora de produção (a API não sobe com ele em produção); roda um programa fixo com argumentos fixos (rótulo fixo, uid do processo), nunca um shell nem texto vindo da requisição.
- BR-11: o plist nunca leva token; o token continua no Keychain.
- BR-12: o dono nunca liga o transcritor à mão. O serviço (rótulo `br.com.nova-alexandria.transcriber`, o que o Mac do dono já roda) é instalado junto com o pareamento e só roda quando há o que fazer (BR-15). Sempre que um job do Mac espera (transcrever, separar vozes, perfil de voz, publicar no acervo — criado pelo envio, por uma etapa que terminou, por um "tentar de novo", por uma publicação, ou já na fila quando a API sobe) e nenhum transcritor está ligado, a API no mesmo Mac o liga sozinha (`launchctl kickstart`, sem `-k`, no máximo uma vez por minuto). Na produção a API não alcança o Mac: o app mostra o transcritor desligado e o que fazer.
- BR-13: os componentes opcionais (separar vozes, perfis de voz) se instalam sozinhos: o serviço roda `uv run --extra diarize --extra voiceprint`, e o uv instala o que faltar antes de o worker subir. Enquanto carrega, o status diz "preparando o transcritor…". O app nunca pede um comando do uv.
- BR-15 (o dono, 2026-11-09: "é importante que os servicos não fiquem o tempo inteiro em execucao no mac … ele precisa ser ligado quando realmente tiver necessidade de uso e desligado logo em seguida"): o LaunchAgent não tem `KeepAlive`; roda `transcriber run --exit-when-idle` uma vez no login (`RunAtLoad`) e a cada `launchctl kickstart` da API. O worker sai depois de uma fila vazia, uma espera de 30 s para a próxima etapa e outra fila vazia; sai também depois de 3 erros seguidos ao pedir trabalho, ou na hora com o token revogado, em vez de ficar na memória tentando. Ao sair, avisa a API com `stopped`, que o mostra desligado e o liga de novo no próximo job.
- BR-16: nenhum teste toca o transcritor real do Mac: a configuração, o Keychain e o `launchctl` ficam isolados (HOME temporária, `security` e `launchctl` barrados), e um teste falha se a configuração real mudar (incidente de 2026-11-09: um teste de pareamento gravou o `config.json` do dono).
- BR-14: a tela de preparo do áudio mostra o status do transcritor (ligado, trabalhando ou desligado, e desde quando), com os detalhes no clique.

## Functional requirements
- FR-1: O transcritor deve, antes de escrever, garantir a pasta do acervo do job (`ensure_topic`): nada com `topic.yaml`; `kb topic new` do pai e depois do acervo quando faltarem; recusar pasta sem `topic.yaml`, slug inseguro ou pai divergente. (BR-1 a BR-3, BR-5)
- FR-2: `kbPublishJobSchema` deve ganhar `collection? { title, domain, parent: { slug, title, domain } | null }` (aditivo) e a API deve preenchê-lo em todo lease. (BR-4)
- FR-3: O reconciliador, o status da publicação e as pendentes devem tratar todo acervo conhecido como publicável (sem a checagem de pasta). (BR-6)
- FR-4: Parear deve gravar `kinds: ['transcribe', 'kb-publish']`. (BR-7)
- FR-5: `GET /api/v1/media/track-documents` e `POST …/publish` devem contar e publicar faixas e gravações sem faixas, de todo acervo conhecido. (BR-8)
- FR-6: A conversa, num acervo com pendentes, deve mostrar a masters o aviso "N transcrições ainda não são documentos", o custo estimado, **Publicar** e o selo do transcritor. (BR-8, BR-9)
- FR-7: `transcriber service install [--vault V] [--extra E]… [--no-load]`, `uninstall` e `status` devem gerar/remover o LaunchAgent e chamar `launchctl` (`bootstrap`, `bootout`, `print`) por uma porta trocável nos testes. (BR-11)
- FR-8: O worker deve mandar `POST /api/v1/media-worker/status` a cada mudança de estado e a cada 30 s; a API deve guardar o último por transcritor (em memória) e servir `GET /api/v1/media/transcribers/status` a masters com os transcritores, o estado derivado, a fila do kb e o que dá para fazer para ligar. (BR-9)
- FR-9: `POST /api/v1/media/transcribers/local/start` (masters) deve existir só com `KB_CHAT_LOCAL_TRANSCRIBER=1` e rodar `launchctl kickstart -k gui/<uid>/<rótulo>` por `execFile`. (BR-10)
- FR-10: Transcritores deve mostrar o selo de cada transcritor, abrindo os detalhes (estado, job atual com %, últimos jobs, últimos erros, visto por último, pasta do vault, versão do kb, versão do transcritor) e, desligado, os comandos para ligar. (BR-9, BR-10)

- FR-11: a API deve conferir na subida, a cada 15 s e depois de cada pedido de mídia que muda algo se há job do Mac esperando sem transcritor ligado, e então rodar `launchctl kickstart gui/<uid>/br.com.nova-alexandria.transcriber` por `execFile` (só com `KB_CHAT_LOCAL_TRANSCRIBER=1`). (BR-12)
- FR-12: `transcriber pair` deve instalar o serviço no macOS (`--no-service` evita), e `service install` deve gravar o rótulo do dono, `--extra diarize --extra voiceprint` e o log `service.log`, atualizando o agente que existir e tirando um deixado sob o rótulo antigo. (BR-12, BR-13)
- FR-13: a página de preparo deve mostrar o selo do transcritor a masters; o selo deve dizer "desde" quando ligado e quando desligado. (BR-14)

## Non-functional requirements
- NFR-1: o sinal de vida custa ≤ 1 requisição a cada 30 s por transcritor ocioso; o corpo ≤ 16 KB.
- NFR-2: `GET /api/v1/media/transcribers/status` responde em p95 ≤ 50 ms local (só memória e contagens da fila).
- NFR-3: o selo e os detalhes cabem em 390 px sem rolagem lateral; o estado é texto, não só cor.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given um job do acervo `novo` sem pasta no vault, When o Mac o processa, Then `kb topic new novo "Novo acervo" espiritualidade` roda uma vez, antes de `classify`, e o documento fica em `<vault>/novo/raw/media/…`.
- **AC-2** (FR-1, BR-3): Given o sub-acervo `pai/filho` sem a pasta do pai, Then rodam `kb topic new pai …` e depois `kb topic new pai/filho …`; Given o pai com `topic.yaml` (como `udv`), Then só o do filho.
- **AC-3** (FR-1, BR-2): Given `udv/topic.yaml` e `udv/palavra-do-mestre/topic.yaml`, When um job de `udv/palavra-do-mestre` roda, Then `kb topic new` nunca roda; Given a pasta do acervo sem `topic.yaml`, Then o job falha com "a pasta existe sem topic.yaml" e nada é escrito.
- **AC-4** (FR-1, BR-5, negativo): Given um slug `a/b/c`, um `parent` que não é o primeiro segmento, ou um vault com link simbólico para fora, Then o job é recusado antes de o kb rodar e nenhum arquivo é criado.
- **AC-5** (FR-2, BR-4): Given um acervo criado na tela, When o Mac pega o job, Then o job tem `collection` com o título do app e o domínio do BR-4; o documento renderizado tem o mesmo `domain`; um sub-acervo leva o pai.
- **AC-6** (FR-3, BR-6): Given um acervo criado na tela sem pasta, When uma faixa dele é publicada, Then o documento é desejado e um job sai; o estado da faixa não é mais "Fora da pesquisa: o acervo ainda não tem pasta no kb".
- **AC-7** (FR-4, BR-7): Given um master que pareia um transcritor, Then ele vem com `kb-publish`; Given o Mac com vault e kb, Then pede `kb-publish`; Given `--no-kb-publish` ou sem vault, Then não pede.
- **AC-8** (FR-5, BR-8): Given um acervo da tela com 2 faixas e 1 gravação sem faixas transcritas e sem documento, When um master abre a visão geral, Then vê 3 a publicar e custo ≈ US$ 0,003; When publica, Then 3 entram na fila; de novo, 0 e 3 puladas; membro, 403; sem sessão, 401.
- **AC-9** (FR-6): Given um master no acervo com 3 pendentes, Then o aviso diz "3 transcrições ainda não são documentos", o custo e **Publicar**, com o selo do transcritor; When publica, Then o aviso diz que estão na fila; Given um membro, Then nenhum aviso.
- **AC-10** (FR-7, BR-11): Given `transcriber service install --vault V`, Then o plist em `~/Library/LaunchAgents/br.com.nova-alexandria.transcriber.plist` tem o rótulo, `RunAtLoad` (sem `KeepAlive`, AC-18), logs em `~/Library/Logs/nova-alexandria-transcriber/`, `KB_CHAT_VAULT=V` e `PATH` com as pastas de uv, kb e ffmpeg, nenhum token, e `launchctl bootstrap gui/<uid> <plist>` roda (o falso); `uninstall` roda `bootout` e apaga o plist; `status` diz carregado/rodando/parado.
- **AC-11** (FR-8, BR-9): Given o worker, When ocioso, trabalhando, aguardando a trava do vault ou com erro, Then manda o estado com versão, job atual e contagens; Given o token da VM, 403; sem token, 401; corpo inválido, 400.
- **AC-12** (FR-8, FR-10): Given um transcritor que mandou "Trabalhando: transcrevendo 'Aula 3' 40 %", Then Transcritores mostra o selo "Trabalhando" e, no clique, os detalhes com job, %, últimos jobs e erros, visto por último, vault e kb; Given sem sinal há 3 min, Then "Desligado".
- **AC-13** (FR-9, BR-10): Given `KB_CHAT_LOCAL_TRANSCRIBER=1` e o transcritor desligado, Then o botão **Ligar transcritor** aparece e roda `launchctl kickstart -k gui/<uid>/br.com.nova-alexandria.transcriber` (o falso) sem shell; Given sem a variável, Then a rota responde 404 e o botão não existe, só os comandos; Given `NODE_ENV=production` com a variável, Then a API não sobe.
- **AC-14** (NFR-3, acessibilidade): Given só o teclado, Then o selo abre os detalhes com Enter, Esc fecha e o foco volta ao selo; o estado é texto; em 390 px cabe sem rolagem lateral; axe sem violações sérias.

- **AC-15** (BR-12, FR-11, FR-12): Given a API no Mac (`KB_CHAT_LOCAL_TRANSCRIBER=1`) e nenhum transcritor ligado, When um áudio enviado termina de converter e sua transcrição entra na fila (ou qualquer job do Mac espera), Then a API roda `launchctl kickstart gui/<uid>/br.com.nova-alexandria.transcriber` (o falso), sem `-k`, uma vez por minuto no máximo; Given um transcritor ligado, Then nada roda; Given a produção (sem a variável), Then nada roda; Given `transcriber pair` no Mac, Then o serviço é instalado; Given um agente feito à mão com o mesmo rótulo, Then `service install` o atualiza, nunca duplica.
- **AC-16** (BR-14, FR-13): Given um master na página de preparo de um áudio, Then o selo do transcritor aparece ao lado das etapas, diz desde quando está ligado ou desligado, e o clique abre os detalhes; Esc devolve o foco ao selo.
- **AC-17** (BR-13): Given `service install`, Then o plist roda `uv run --project <repo>/tools/transcriber --extra diarize --extra voiceprint transcriber run`; While os modelos carregam, Then o status diz "preparando o transcritor…"; os detalhes nunca mostram um comando do uv.

- **AC-18** (BR-15): Given `service install`, Then o plist não tem `KeepAlive`, tem `RunAtLoad` e roda `transcriber run --exit-when-idle`; Given o worker em `--exit-when-idle`, When a fila esvazia, Then espera a carência, pega a próxima etapa se ela chegou e sai na segunda fila vazia com `stopped`; When a API não responde 3 vezes seguidas, Then sai com código 1; When o token foi revogado, Then sai na hora; Given um `stopped` recebido, Then a API o mostra desligado e o liga no próximo job.
- **AC-19** (BR-16): Given a suíte do transcritor, Then cada teste roda com uma HOME e uma configuração próprias, `security` e `launchctl` levantam erro se chamados, e a sessão falha se o `config.json` real mudar.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4 | unidade (worker) | `tools/transcriber/tests/test_topic.py` com kb falso que grava os comandos e cria a pasta como o kb 0.0.12 (spike de 2026-11-09 num vault de rascunho) |
| AC-5, AC-6 | integração | `kb-publish.integration.test.ts`, `media-documents.integration.test.ts` (o teste do antigo AC-12 muda de sentido) |
| AC-7 | integração + unidade (worker) | `media-transcribers.integration.test.ts`; `test_worker.py`/`test_cli.py` |
| AC-8 | integração | `existing-tracks.integration.test.ts` |
| AC-9, AC-12, AC-14 | componente + E2E | `pending-transcriptions.spec.ts`, `transcriber-status.spec.ts`; `e2e/specs/transcriber-status.spec.ts` 1440 e 390, Chrome e WebKit |
| AC-10 | unidade (worker) | `test_service.py` com launchctl falso e HOME temporário |
| AC-11 | unidade (worker) + integração | `test_status.py`; `transcriber-status.integration.test.ts` |
| AC-13 | integração + unidade | `transcriber-status.integration.test.ts` com runner falso; `config.test.ts` |
| AC-15 | unidade + integração + worker | `transcriber-waker.test.ts`; `transcriber-status.integration.test.ts` ("starts by itself"); `launchctl-local-transcriber.test.ts`; `test_cli.py` (pair instala), `test_service.py` (rótulo, idempotente, rótulo antigo) |
| AC-16 | componente + E2E | `transcriber-status.spec.ts` ("desde"); E2E `media-transcriber-status` AC-16 |
| AC-18 | worker + unidade + integração | `test_worker.py` (carência, 3 erros, revogado, `stopped`), `test_service.py` (sem KeepAlive); `transcriber-status.test.ts`, `transcriber-status.integration.test.ts` (`stopped` → liga de novo) |
| AC-19 | worker | `tests/conftest.py` (`isolated_mac`, `real_config_untouched`), `test_isolation.py` |
| AC-17 | worker + componente | `test_service.py` (extras), `test_status.py` (preparando); `transcriber-status.spec.ts` (sem uv) |

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md) (emenda 2026-11-09) · ADR [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (emenda 2026-11-09) · ADR [0028](../adr/0028-app-owned-collections-and-sub-collections.md) · KBC-099 FR-11 · KBC-100 AC-12 (substituído) · Spec `work/KBC-114/spec.md`.

## Open questions
Nenhuma bloqueante. Decisões tomadas pelo padrão recomendado (registradas no estado do item): domínio do BR-4; a caixa "Publica no acervo" fica como status e opção de desligar; status em memória; os já pareados mantêm as marcas.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR emendada
- [x] Dependências no `develop`
- [x] Cabe num goal
