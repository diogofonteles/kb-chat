---
id: KBC-116
title: "Levar as mídias do Mac para a produção: importação verificada, repetível e incremental"
status: in-progress
slice: release
outcome: as 73 mídias do Mac (11 gravações e 62 faixas, com transcrições, correções, aprendizado, vozes, faixas e assuntos) tocam, aparecem na Biblioteca e em "Na fala" na produção, e cada nova mídia do Mac chega lá rodando o mesmo comando, sem transcrever de novo
depends_on: [KBC-034, KBC-041, KBC-099, KBC-105, KBC-113]
---

# KBC-116 — Levar as mídias do Mac para a produção

*Pedido do dono, 2026-11-11 (literal):* "precisamos levar as midias, todas as que ainda nao estao la".

*Decisões do dono que valem aqui (coordenador, 2026-11-11):* "migrar o que existe; o transcritor continua no localhost": a produção só recebe mídia por migração, nunca transcreve de novo. A migração é repetível e incremental: leva só o que mudou, sem duplicar nem apagar o que a produção já tem. Pessoas são ligadas pelo e-mail. Primeiro um ensaio local; antes de rodar, backup da produção; depois, conferência. A migração anda junto com o sync do vault (§7/§7b do runbook), porque as faixas viram documentos do kb no vault (ADR 0035). Os níveis ficam para depois: a produção já tem níveis, mas nenhuma escala.

*Retrato de 2026-11-11 (medido no Mac, só leitura):* `~/.kb-chat-media` com 189 MB (`media.db` na migração 31, áudio 173 MB, JSON brutos 2,8 MB, `uploads/` vazio). 73 mídias: hermetismo 11, udv 33, udv/palavra-do-mestre 29; todas `ready`, nenhuma com nível; nenhuma escala no Mac (`access-levels.json` não existe); nenhum perfil de voz. Na produção, `/srv/kb-chat/media` existe vazio, com dono root, e a mídia está desligada.

## Story
Como dono, quero levar para a produção, com um comando que posso repetir, todas as mídias que o meu Mac já transcreveu e editou, para que as pessoas ouçam, leiam e pesquisem lá o que hoje só existe no meu Mac, sem transcrever nada de novo e sem perder o que a produção já tem.

## Scope
**In:**
- Exportação no Mac (só leitura de `~/.kb-chat*`): um pacote com um retrato consistente do `media.db` (`VACUUM INTO`, migrado na cópia para o schema da versão), os arquivos que as linhas citam (áudio, JSON brutos de transcrição e de separação de vozes), o mapa principal → e-mail das pessoas citadas, os autores dos acervos e um manifesto com o sha256 de cada arquivo.
- Transporte: `rsync` do pacote para uma pasta de entrada na VM (só as diferenças a partir do segundo envio) e conferência dos sha256 na VM antes de importar.
- Importação na VM, dentro de um contêiner de uso único com a imagem da API em produção, com a API parada; um ensaio (`--dry-run`) com a API no ar, sobre uma cópia do banco, que não muda nada.
- O que vai, por gravação (a gravação e as faixas dela, como uma unidade): linhas de `media`, arquivos, transcrições (segmentos, palavras, índice FTS5), correções, separação de vozes e nomes, faixas, rascunhos e revisões, assuntos, forma de onda, silêncios, preparo, documentos de faixa (estado de publicação) e o histórico terminal da fila; o nível de cada mídia (BR-6); a autoria; os falantes e assuntos do acervo; os termos aprendidos e as chaves do aprendizado; o progresso, os marcadores e as preferências de cada pessoa que existir na produção.
- Livro de importações no `media.db` (migração 32) e conferência: banco íntegro, chaves estrangeiras, índice e arquivos batendo com o pacote.
- Correção do `ensure_media_dir` do `deploy.sh`: uma pasta de mídia que já existe com outro dono (criada pelo Docker como root) passa a ser corrigida para o uid 10001, 0700.
- Runbook: seção nova com o passo a passo do rollout e do rollback.

**Out:**
- Impressões de voz (`voice-prints/`), a lista de revogações e consentimentos/perfis de voz (ADR 0032): nunca saem do Mac.
- Uploads incompletos (`uploads/`, mídias que não estão `ready`) e gravações em andamento no Mac (job na fila, corte pendente): ficam para a próxima execução.
- Transcritores pareados (tokens), gastos de mídia (`media_spend`), ajustes de mídia, a fila viva e os caches da Groq: são do ambiente.
- Criar acervos, escalas ou níveis de pessoas na produção; apagar qualquer coisa na produção; levar mídias da produção para o Mac.
- Ligar o transcritor na produção ou publicar no vault a partir dela.

## Business rules
- BR-1: A produção só recebe mídia por esta migração; nada que a migração leva dispara transcrição, separação de vozes ou corte na produção. Exceções: nenhuma.
- BR-2: A unidade da migração é a gravação com as suas faixas, identificada pelo id da mídia, que é o mesmo nos dois ambientes.
- BR-3: A migração nunca apaga nem sobrescreve o que a produção mudou. Uma unidade que a produção alterou depois da última importação fica retida como conflito e é listada; nenhuma linha dela muda. Uma unidade que perdeu faixas no Mac também fica retida.
- BR-4: Uma unidade que já está na produção e não mudou no Mac não muda. Uma que mudou no Mac e não mudou na produção é atualizada inteira, mantendo os dados das pessoas (progresso, marcadores) e o nível da produção.
- BR-5: Pessoas são ligadas pelo e-mail: o principal de origem vira o e-mail pela lista de pessoas do Mac, e o e-mail vira o principal da produção (o dono é `owner` nos dois). Os dados pessoais (progresso, marcadores, preferências, estado da biblioteca) de quem não existe na produção não vão e são contados. A autoria registrada (quem corrigiu, quem aprovou) vai como está quando a pessoa não existe lá.
- BR-6: O nível de cada mídia vai na primeira importação e, a partir dela, é da produção. Na escala da produção: o mesmo id fica; um id que a escala da produção não tem vira "Sem nível" (só masters). Sem escala na produção para o acervo: uma mídia sem nível vai sem nível; uma mídia com nível fica retida até a escala existir lá, porque abriria o que o Mac fecha. Nenhuma escala é criada pela migração.
- BR-7: O acervo de cada mídia precisa existir na produção (pasta do vault com `topic.yaml` ou acervo do app); sem ele, a unidade fica retida com o motivo. Os autores que faltam no acervo da produção são acrescentados; os que ela já tem não mudam.
- BR-8: Um arquivo que já existe na produção com outro conteúdo nunca é sobrescrito: a unidade fica retida.
- BR-9: A migração só roda entre schemas iguais: as migrações do pacote e as do banco da produção têm as mesmas versões e nomes.

## Functional requirements
- FR-1: When the owner runs the export, the system shall write a package with a consistent copy of the media database, the referenced files, the people map, the authors and a manifest with each file's sha256, reading `~/.kb-chat*` only. (BR-2, BR-9)
- FR-2: When the import runs, the system shall verify every package file against the manifest before any change and refuse the whole run on a mismatch. (BR-8)
- FR-3: When a unit is absent from production, the system shall insert all of its rows and copy its files, and record the unit in the import ledger. (BR-2)
- FR-4: When a unit is unchanged on both sides since the last import, the system shall leave it as it is. (BR-4)
- FR-5: When a unit changed on the Mac only, the system shall replace its content rows, keep the people's rows and production's level, and update the ledger. (BR-4, BR-6)
- FR-6: When a unit changed in production, lost tracks on the Mac, has a file conflict, a missing collection, an unmappable level or work in progress, the system shall hold it, change nothing of it and list it with the reason. (BR-3, BR-6, BR-7, BR-8)
- FR-7: When the import maps people, the system shall translate principals by e-mail and skip personal rows of people absent in production, counting them. (BR-5)
- FR-8: When the import runs with `--dry-run`, the system shall report exactly what a real run would do and change nothing in production. (BR-3)
- FR-9: When the import ends, the system shall check integrity, foreign keys, the transcript index and every imported file, and exit 0 only if everything matched and nothing was held (3 when something was held, 1 on failure).
- FR-10: When the schemas differ, the system shall refuse before any change and say which side to update. (BR-9)
- FR-11: When `deploy.sh` finds the media folder owned by someone other than the app, it shall give it to uid 10001 with mode 0700 (root) or warn (non-root).

## Non-functional requirements
- NFR-1: A second run with nothing changed takes under 60 s for the current 73 media on the Mac and transfers only the manifest's changed files (rsync), measured in the local rehearsal.
- NFR-2: The production API is down only while the real import runs: under 2 min for 189 MB, measured in the rehearsal (import time) plus the API's start.
- NFR-3: No secret in an argument, the package or the output; the media worker token is generated on the VM and never shown.

## Acceptance criteria
- AC-1 (FR-1, FR-3)
  Given a clean production state and media database
  When the package of the Mac is imported
  Then the 73 media, their transcripts, corrections, tracks and files are in production and the ledger has 11 units
- AC-2 (FR-4)
  Given the package was imported
  When the same package is imported again
  Then nothing changes: 0 inserted, 0 updated, 11 unchanged, and the database fingerprint is the same
- AC-3 (FR-3, FR-4)
  Given the package was imported
  When a new recording appears on the Mac and the import runs again
  Then only that recording and its files go, and the others are unchanged
- AC-4 (FR-5)
  Given an imported unit with a person's progress in production
  When a word is corrected on the Mac and the import runs
  Then production has the correction and still has the person's progress
- AC-5 (FR-6, BR-3, negative)
  Given an imported unit whose title was changed in production
  When the Mac changes the same unit and the import runs
  Then the unit is held as a conflict and production keeps its title
- AC-6 (FR-6, BR-6, negative)
  Given a Mac media with a level and no scale for its collection in production
  When the import runs
  Then the unit is held with "escala ausente" and the exit code is 3
- AC-7 (BR-6)
  Given production has the collection's scale without the Mac's level id
  When the import runs
  Then the media arrives "Sem nível" and only masters see it
- AC-8 (FR-6, BR-7, negative)
  Given a collection that does not exist in production
  When the import runs
  Then its units are held with "acervo ausente" and nothing of them is written
- AC-9 (FR-7, BR-5)
  Given a person on the Mac with progress and a bookmark who does not exist in production
  When the import runs
  Then their rows are skipped and counted, and a person who exists has them under their production principal
- AC-10 (FR-2, negative)
  Given a package file whose content differs from the manifest
  When the import runs
  Then it refuses before any change, naming the file
- AC-11 (FR-8)
  Given production with part of the media
  When the import runs with `--dry-run`
  Then the report lists what would go and production's database and files are byte-identical afterwards
- AC-12 (FR-10, negative)
  Given a package whose migrations differ from production's
  When the import runs
  Then it refuses before any change and names the differing versions
- AC-13 (Out: voice prints)
  Given voice prints and a revocation list in the Mac's media folder
  When the package is exported and imported
  Then neither the package nor production contains them, nor consents or profiles
- AC-14 (BR-1)
  Given imported media
  When the production API starts
  Then no transcribe, diarize, cut or transcode job is queued for them
- AC-15 (FR-6, BR-8, negative)
  Given a production file at an imported path with other content
  When the import runs
  Then the unit is held and the file is untouched
- AC-16 (FR-11)
  Given `/srv/kb-chat/media` exists owned by root
  When `deploy.sh` runs as root
  Then the folder is owned by 10001 with mode 0700
- AC-17 (local validation)
  Given the API on port 3418 over the imported destination
  When a master opens the library at 1440 and 390 px
  Then audio plays, the library search finds tracks and a member without access to the collection sees none of it

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 a AC-15 | integração (Vitest, `media-transfer.integration.test.ts`) | bancos e pastas temporários (`tools/test-temp.mjs`), fixtures SQL nas tabelas principais |
| AC-1 a AC-3, NFR-1 | ensaio local | cópia do `media.db` do Mac (`sqlite3 -readonly .backup`) e dos arquivos em `work/KBC-116/rehearsal/` |
| AC-16 | integração do script (`deploy-scripts.test.ts`) | `KB_CHAT_DEPLOY_DIR` temporário, sem root: o aviso; o caminho root fica no ensaio |
| AC-17 | validação local no navegador | API em 3418 sobre o destino importado, 1440 e 390 px |

## References
ADR: [0010](../adr/0010-deploy-oracle-cloud-always-free.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0032](../adr/0032-voice-prints-outside-the-database-and-the-backup.md), [0035](../adr/0035-tracks-as-kb-documents.md), [0036](../adr/0036-access-levels-per-collection.md), [0038](../adr/0038-media-moves-to-production-by-verified-import.md) · Runbook: `docs/deploy/runbook.md` §7, §7b, §9d, §11 e a seção nova · Sem tela nova.

## Open questions
Nenhuma: os padrões estão nas BR e foram registrados como decisões no goal.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal (otherwise split)
