---
id: KBC-159
title: "Aposentar a permissão \"Ver quem fala na transcrição\" (media-speakers), sem efeito desde o KBC-151"
status: ready
slice: ui-v2-areas
outcome: a permissão deixa de existir na lista de "Pessoas" e no contrato, e nenhum dado guardado (pessoas, convites, perfis) quebra ao carregar
depends_on: [KBC-151]
---

# KBC-159 — Aposentar `media-speakers`

Pedido do dono (2026-11-17): depois do KBC-151 todo ouvinte vê quem fala; a permissão pode ter perdido o efeito.

## Evidência (investigação de 2026-11-17)
Usos de `media-speakers` fora de testes:
- `libs/contracts/src/auth.ts:19,36`: só a lista `FEATURES` e o comentário.
- `apps/web/src/app/features/people/feature-labels.ts:18`: só o rótulo "Ver quem fala na transcrição" (a lista de permissões em Pessoas).
- `apps/api/src/adapters/sqlite/media-migrations.ts:821`: **não é a permissão**: é o nome da migração 13 que criou a tabela `media_speakers`; deve ficar.
- A API **não lê mais** a permissão em nenhum módulo (`apps/api/src/modules`: zero resultados); `transcript-routes` decide por `media-edit` (separação inteira) e por BR-0 do KBC-151 (nomes confirmados para todos).
- Web: `media-player-page.ts:286-292`, `canSeeSpeakers` é `session.me() !== null` (não consulta a permissão); o interruptor "Mostrar quem fala" é só preferência local (`transcript-preferences.ts`).
- Testes que ainda a concedem: `media-voice-names.integration.test.ts` (105-109, 377, 412, 429, 450), `media-voice-refusal.integration.test.ts` (71, 84), `track-levels-round1.integration.test.ts:33`, `media-player-page.spec.ts:813`. O próprio teste `media-voice-names...:377` já prova que sem ela os nomes aparecem.
- Nomear/editar falantes é de `media-edit` (KBC-065 BR-3, ADR 0032), não dela.

**Conclusão:** a permissão não protege mais nada; mantê-la na tela de Pessoas engana quem a desmarca. Recomendação: **remover** (não renomear: não há nada a proteger com outro nome).

## Story
Como dono, quero que a lista de permissões só mostre o que de fato libera ou nega algo, para não conceder nem retirar uma permissão sem efeito.

## Scope
**In:** remover `media-speakers` de `FEATURES`, do rótulo, dos testes e dos fixtures; ler dados antigos sem erro; ADR/doc: nota no KBC-065 e no KBC-151.
**Out:** a tabela `media_speakers` e a migração 13 (ficam); `media-edit`; o interruptor "Mostrar quem fala".

## Business rules
- BR-1: dados antigos continuam legíveis: um grant `media-speakers` em `people.json`, em convites (`invite-profiles`), em perfis ou em sessões é **ignorado ao ler** e não reaparece ao gravar. Nenhum erro de validação, nenhuma pessoa perde outra permissão.
- BR-2: a remoção não muda o que ninguém vê: todos continuam vendo nomes confirmados (KBC-151 BR-0).
- BR-3: o registro de auditoria antigo que cite a permissão continua legível como texto.

## Functional requirements
- FR-1: `featureSchema` não aceita mais `media-speakers` em **entrada** nova (PUT de pessoa, convite); a **leitura** de armazenamento antigo a descarta (um preprocess `z.array(z.string()).transform(filtra os conhecidos)` nos leitores de `people-store`, `invite-profiles`, sessão). (BR-1)
- FR-2: uma migração de dados idempotente na subida reescreve `people.json` e os perfis sem a permissão (um único write, mesma regra do KBC-109), registrada uma vez. (BR-1)
- FR-3: a tela Pessoas deixa de listá-la, no modal de pessoa e no de convite/perfil. (BR-2)

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given `people.json` com `features: ['media','media-speakers']`, When a API sobe, Then carrega a pessoa com `['media']` e não falha.
- AC-2 (FR-2): Given o mesmo arquivo, When a migração roda duas vezes, Then o arquivo fica sem a permissão e a segunda execução não escreve.
- AC-3 (negativo): Given um PUT de pessoa com `media-speakers`, Then 400 de validação.
- AC-4 (BR-2): Given um ouvinte só com `media`, When abre uma faixa com falantes nomeados, Then vê os nomes (e nunca a separação nem impressões de voz).
- AC-5 (FR-3, UI, 1440 e 390, Chromium e WebKit): Given o modal de uma pessoa, Then a lista não tem "Ver quem fala na transcrição" e o resto das permissões não mudou de posição de forma quebrada.
- AC-6 (BR-1, edge): Given um convite pendente que a continha, When aceito, Then a pessoa entra com as outras permissões.

## Test strategy
Unidade do leitor tolerante e da migração (contracts e API), integração de AC-3/AC-4 (ajustando os 3 testes de API que a concedem), spec do modal de Pessoas, E2E de Pessoas em 1440 e 390, Chromium e WebKit.

## UI references
Figma `au1MI6z2Vwy9tnqOv2vrfH`, "v2 · Configurações — Pessoas" (modal com abas, Permissões): atualizar o(s) frame(s) tirando a linha; sem frame novo.

## References
`libs/contracts/src/auth.ts` · `apps/web/src/app/features/people/feature-labels.ts` · `apps/api/src/modules/auth/people-rules.ts`, `person.ts` · KBC-065, KBC-109, KBC-151 · ADR 0008, 0032

## Decisão a confirmar
- Recomendado: remover. Alternativa descartada: renomear (nada resta para proteger).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions (a decisão acima é a recomendada)
- [x] Fits one goal
