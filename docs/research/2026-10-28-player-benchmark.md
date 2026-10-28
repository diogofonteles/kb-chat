# Benchmark de players de áudio web — referência para o player da Nova Alexandria

Data da pesquisa: 28/10/2026. Escopo: player de aulas faladas (1–2 h, pt-BR) em Angular 21 zoneless, com transcrição clicável sincronizada, WebVTT, velocidade 0,75–2×, retomada entre dispositivos, mini-player persistente, Media Session, atalhos, AAC m4a via HTTP Range, WCAG 2.2 AA, três temas, 1440 px e 390 px.

Convenções deste relatório:
- **[verificado]**: confirmado em fonte primária (doc oficial, código-fonte, página de suporte), com URL inline.
- **[observado por terceiros]**: relato de usuário em fórum/review; indica tendência, não estatística.
- **[premissa]**: não verificado nesta pesquisa; tratar como hipótese.
- Não há notas de avaliação (estrelas) inventadas; quando não citado, não foi medido.
- Produtos proprietários: só comportamento observável/documentado. Projetos open source: código lido no GitHub (engenharia reversa permitida).

---

## 0. Resumo executivo

1. **O cenário de bibliotecas mudou em 2026.** Vidstack, Media Chrome, Plyr e Mux Player foram unificados no **Video.js 10**, GA em 01/10/2026 (Apache-2.0) — https://videojs.org/blog/videojs-10. Vidstack está em **manutenção só de segurança até jan/2028** (https://vidstack.io/docs/player/), Plyr está **deprecated** (README: https://github.com/sampotts/plyr), e Media Chrome "will eventually sunset" (https://www.mux.com/blog/from-media-chrome-to-video-js-v10-the-evolution-of-html-first-video-players).
2. **Video.js 10 ainda não cobre nosso caso**: o preset de áudio não inclui text tracks ("Audio players don't show captions", issue #3039), velocidades são uma lista fixa `0.2, 0.5, 0.7, 1, 1.2, 1.5, 1.7, 2` (sem 0,75/1,25), não define metadados de Media Session (#3042) e não persiste nada entre visitas (#944) — https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#known-gaps.
3. **Recomendação: CONSTRUIR** um componente próprio em Angular (signals), copiando *padrões* (não código) das melhores referências: arquitetura de estado/requests do **Media Chrome/Vidstack**, acessibilidade do **Video.js 10** (status announcer, slider APG) e UX de transcrição do **Able Player** + **YouTube/Apple Podcasts**. Rever a decisão em ~6 meses, quando o Video.js 10 fechar as lacunas.
4. **Mudanças mais importantes na nossa spec** (detalhe na seção 5): atalhos de tecla única precisam de escopo/desligamento (WCAG 2.1.4); transcrição precisa pausar o auto-scroll quando o usuário rola e oferecer "Voltar ao trecho atual"; busca na transcrição; `setPositionState` na Media Session; volume por *feature detection* (iOS), não só por `pointer: fine`; preservar velocidade ao trocar `src` (`defaultPlaybackRate`); indicador de buffering com debounce; mini-player não pode cobrir o foco (WCAG 2.4.11).

---

## 1. Produtos com boa UX de áudio falado / transcrição

### 1.1 YouTube (player + painel de transcrição)
- **Transcrição**: aberta pela descrição do vídeo ("Show transcript"), painel lateral com linhas com timestamp; a linha atual é destacada e o painel acompanha a reprodução. Ao rolar manualmente, aparece o botão **"Sync to video time"** que volta à posição atual [observado por terceiros — usuários perguntam o que o botão faz: https://www.reddit.com/r/youtube/comments/1mvw1m0/whats_the_purpose_of_this_sync_to_video_button/ e https://www.reddit.com/r/youtube/comments/1n3j4n0/what_is_this_sync_to_video_thing_is_this_new/]. O rótulo pouco claro gerou confusão — lição: usar texto explícito ("Voltar ao trecho atual").
- **Atalhos** (padrão de mercado, reproduzido por Vidstack/Video.js): Espaço/K play, J/L ±10 s, ←/→ ±5 s, 0–9 pula para 0–90 %, `<`/`>` velocidade, C legendas, M mudo [premissa quanto aos valores exatos do YouTube; os equivalentes do Video.js 10 estão documentados em https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#keyboard-shortcuts].
- **Reclamações**: confusão com "Sync to video" (acima). Não encontrei fonte primária do Google sobre o painel nesta pesquisa.

### 1.2 Apple Podcasts (transcrições, desde iOS 17.4)
- Destaque **palavra a palavra** durante a reprodução, **busca** por palavra/frase dentro do episódio, **tocar no texto para tocar a partir dali**, compartilhar até 200 palavras com atribuição e link; "timed links" aparecem em linha na transcrição e no player [verificado: https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts; https://www.apple.com/newsroom/2024/03/apple-introduces-transcripts-for-apple-podcasts/].
- Dois modos: leitura acompanhando ("follow along") e **visão estática**, onde é possível selecionar texto e escolher tocar, copiar ou compartilhar a partir dali [verificado: https://support.apple.com/en-kz/guide/iphone/iph9426049e9/ios].
- Transcrição chega "pouco depois" da publicação; trechos alterados por áudio dinâmico não aparecem [verificado, mesma página de podcasters].

### 1.3 Spotify (podcasts, "Read along")
- Transcrições automáticas sincronizadas; no app móvel, rolando a tela "Now Playing" aparece o card "Read along" [verificado por imprensa: https://www.techradar.com/audio/audio-streaming/spotify-will-now-automatically-transcribe-your-favorite-podcasts-as-you-listen; https://www.pcmag.com/news/spotify-rolls-out-auto-generated-podcast-transcripts].
- **Reclamações** [observado por terceiros]: disponibilidade só para alguns programas (usuária com deficiência auditiva: https://community.spotify.com/forum/en/discussion/6190937/do-all-podcasts-have-read-along); transcrição sempre visível e sem opção de desligar, distraindo ao dirigir (https://www.reddit.com/r/truespotify/comments/1k548vr/is_there_a_way_to_turn_off_the_ai_transcripts_on/); **no Web Player a transcrição não sincroniza para podcasts só-áudio**, reportado em 02/09/2026, sem resposta da equipe (https://community.spotify.com/forum/en/discussion/7545511/the-read-along-does-not-sync-for-audio-only-podcasts-on-web-player-and-spotify-for-ubuntu).
- Lições: a transcrição deve poder ser **recolhida** e a preferência lembrada; sincronização tem que funcionar igual no web.

### 1.4 Pocket Casts (web player)
- **Skip padrão: voltar 10 s / avançar 45 s, configurável** em Profile → Settings → Playback [verificado: https://support.pocketcasts.com/knowledge-base/webplayer-settings/].
- **Atalhos**: Espaço play/pause, ←/→ skip, M mudo, `–`/`+` velocidade, números para navegar entre seções, **`?` abre a lista de atalhos** [verificado: https://support.pocketcasts.com/knowledge-base/do-you-have-any-keyboard-shortcuts/].
- **Velocidade**: controle com botões `−`/`+` ao lado do valor (tocar no valor volta a 1×); **no web a velocidade é limitada a 2×** e Trim Silence/Volume Boost não existem no web/desktop [verificado: https://support.pocketcasts.com/knowledge-base/playback-effects/].
- **Reclamação**: falta de "skip silence" no web player [observado por terceiros: https://forums.pocketcasts.com/forums/topic/web-playback-option-skip-silence/].

### 1.5 Overcast
- Diferenciais de app: **Smart Speed** (encurta silêncios sem distorcer) e **Voice Boost** (normaliza volume) [verificado: https://overcast.fm/; https://apps.apple.com/us/app/overcast-podcast-app/id888422857; https://marco.org/2020/01/31/voiceboost2].
- Web player do overcast.fm: [premissa] mais simples que o app (sem esses efeitos); não verificado nesta pesquisa.

### 1.6 Otter.ai
- "Follow along the highlighted word as the audio is playing • Tap on any word to jump the audio to that spot"; destaque de frases em um toque; planos pagos trazem mais velocidades e **skip silence** [verificado: https://apps.apple.com/us/app/otter-transcribe-voice-notes/id1276437113].
- Busca por palavra-chave que leva a todas as ocorrências [verificado em material de terceiros: https://sdrc.ucr.edu/otter-voice-notes].

### 1.7 Descript
- Durante a reprodução, "the playhead also highlights the current word in your script" [verificado: https://help.descript.com/descript-tour/playback-and-navigation].
- **Reclamação**: o editor de transcrição rola para o topo ao clicar para editar [observado por terceiros: https://www.facebook.com/groups/descriptusers/posts/908893358063269/]. Lição: **nunca mover a rolagem contra o leitor**.

### 1.8 Snipd
- Posiciona-se como "podcast app for knowledge seekers": **snip em um toque** (cria trecho com áudio + transcrição + resumo por IA), **capítulos gerados por IA** com descrições, transcrições pesquisáveis, exportação para Obsidian [verificado: https://www.snipd.com/; https://www.snipd.com/blog/how-to-take-notes-from-podcasts-during-workouts; https://www.reddit.com/r/ObsidianMD/comments/1p7fl7x/we_at_snipd_built_a_plugin_to_sync_all_your/].
- Relevância para nós: é o produto mais próximo do caso "estudar áudio". A combinação capítulos + marcar trecho + transcrição é o que os usuários elogiam nas lojas [observado por terceiros: https://play.google.com/store/apps/details?id=ai.topicfinder.podcastdiscovery&hl=en_US].

### 1.9 Audible (Cloud Player web)
- Velocidade **0,5×–3,5×** no cloud player [verificado: https://www.audible.com/ep/NarrationSpeed].
- **Marcadores com notas** no Cloud Player; "Go to Bookmark" retoma da posição exata; clipes de áudio só no app [verificado: https://help.audible.com/s/article/manage-clips-bookmarks?language=en_US].
- Intervalos de skip configuráveis (app) [observado por terceiros: https://www.reddit.com/r/audible/comments/10cog9j/how_do_i_change_these_back_to_skip_forwardback_30/].
- Sincronização de posição entre dispositivos: [premissa] conhecida no Audible (Whispersync), não verificada aqui.

### 1.10 TED (transcrição interativa)
- Botão "Read Transcript" abaixo do player; palavras destacadas à medida que são faladas; clicar no texto pula o vídeo para aquela frase; no TED-Ed, abre à direita do player [verificado: https://help.ted.com/hc/en-us/articles/360018572954-How-do-I-find-transcripts-for-TED-and-TEDx-talks; https://help.ted.com/hc/en-us/articles/4448511398295-How-do-I-access-transcripts-for-TED-Ed-lessons].

### 1.11 Readwise Reader / leitores de vídeo com transcrição
- Readwise: changelog cita setas "Return" e "Jump" e que "auto-scroll picks back up when you return to the spoken text" [verificado: https://docs.readwise.io/changelog]; review da App Store reclama de auto-scroll quebrado após atualização [observado por terceiros: https://apps.apple.com/sg/app/readwise-reader/id1567599761].
- Eden (leitor similar) documenta de forma explícita o padrão que recomendamos: botão **Auto-scroll**; **rolar manualmente desliga o auto-scroll**; ao pular no player aparece **"Jump to 12:30"**; atalhos `<`/`>` velocidade, `A` liga/desliga auto-scroll, `H` marca o trecho atual [verificado: https://eden.so/help/library/reader-for-social-and-video/].

### 1.12 Não cobertos
- Rev e Speechify: não pesquisados em profundidade (baixa relevância para player de aula); nenhuma afirmação feita sobre eles.

### 1.13 Padrões convergentes (o que os melhores fazem igual)
| Padrão | Quem faz |
|---|---|
| Destaque do trecho atual + clicar/tocar no texto para tocar dali | Apple Podcasts, TED, Otter, Descript, YouTube, Able Player |
| Busca dentro da transcrição | Apple Podcasts, Otter, YouTube [premissa p/ YouTube] |
| Auto-scroll suspenso quando o usuário rola + botão para voltar | YouTube ("Sync to video time"), Able Player, Readwise, Eden |
| Capítulos/estrutura do conteúdo | Snipd, Vidstack (capítulos no slider), Able Player (cabeçalhos de capítulo), NN/g |
| Marcar trecho/nota com timestamp | Audible, Snipd, Otter, Eden |
| Skip assimétrico e configurável | Pocket Casts (10/45), Audible; nossa spec (15/30) está alinhada |
| `?` mostra atalhos | Pocket Casts, Media Chrome |

---

## 2. Toolkits open source — engenharia

### 2.1 Status e licenças (out/2026)
| Projeto | Licença | Status | Fonte |
|---|---|---|---|
| **Video.js 10** (`@videojs/html`, `@videojs/react`) | Apache-2.0 | GA 10.0.0 em 01/10/2026; reescrita conjunta | https://videojs.org/blog/videojs-10 |
| **Vidstack** 1.x | MIT | só correções de segurança até jan/2028 | https://vidstack.io/docs/player/ |
| **Media Chrome** 4.19.4 | MIT | ativo (push em 23/10/2026), mas vai ser descontinuado em favor do v10 | `gh api repos/muxinc/media-chrome`; https://www.mux.com/blog/from-media-chrome-to-video-js-v10-the-evolution-of-html-first-video-players |
| **Plyr** | MIT | deprecated, só segurança | https://github.com/sampotts/plyr |
| **Able Player** 5.1.0-beta2 | MIT | ativo (push em 28/10/2026); depende de jQuery | https://github.com/ableplayer/ableplayer |
| **wavesurfer.js** 8.0.3 | BSD-3-Clause | ativo; foco em forma de onda | https://github.com/katspaugh/wavesurfer.js |
| **Shaka Player** 5.3.0 | Apache-2.0 | ativo; motor de streaming (DASH/HLS) | https://github.com/shaka-project/shaka-player |

**Tamanho de bundle** (minificado/gzip, medido pelo time do Video.js): Vidstack 237,4/74,1 kB; Media Chrome 175,5/41,3 kB; Plyr 109,8/32,6 kB; **Video.js 10 Audio Player [HTML] 85,8/23,0 kB** — https://videojs.org/blog/videojs-v10-beta-hello-world-again. (Números do beta; medidos por uma das partes interessadas.)

### 2.2 Arquitetura (como resolvem estado e eventos)
- **Media Chrome**: um `<media-controller>` central guarda o estado e media a comunicação entre o `<audio>/<video>` e os controles; os controles só *pedem* mudanças (eventos `media*request`) e reagem ao estado. Depois veio um `MediaStore` independente de framework. Lição admitida pelos autores: Shadow DOM demais atrapalhou estilização ("we'd use less Shadow DOM — maybe none at all") — https://www.mux.com/blog/from-media-chrome-to-video-js-v10-the-evolution-of-html-first-video-players. No código, cada propriedade de estado declara quais eventos de mídia a recalculam (`state-mediator.ts`): p.ex. `mediaPlaybackRate` escuta `ratechange` **e `loadstart`** (pega o reset na troca de `src`), `mediaLoading = readyState < 3` escuta `waiting/playing/emptied` — https://github.com/muxinc/media-chrome/blob/main/src/js/media-store/state-mediator.ts.
- **Vidstack**: `media-state-manager.ts` normaliza eventos nativos num store de signals (maverick.js), com "request manager" separado para pedidos do usuário — https://github.com/vidstack/player/tree/main/packages/vidstack/src/core/state.
- **Video.js 10**: três peças separadas — *player* (só estado, montado a partir de "features"), *skin* (UI) e *media*; `currentTime` atualiza ~4×/s em vez de a cada frame — https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#behavior-changes-to-check.
- **Para nós**: o mesmo padrão cabe num `PlayerStore` Angular com `signal()`/`computed()` alimentado por listeners do `<audio>` — exatamente o que os três fazem, sem dependência.

### 2.3 Casos difíceis — como cada um trata

**a) `playbackRate` volta a 1 ao trocar `src`**
- É comportamento da especificação: o algoritmo de load redefine `playbackRate` para `defaultPlaybackRate`; o WHATWG manteve isso de propósito ("if a developer specifically resets the src, then they want to reset the playback rate") — https://github.com/whatwg/html/issues/2739.
- Vidstack teve bug reportado ("not persisted when active src is changed") — https://github.com/vidstack/player/issues/1120; o store dele persiste a velocidade e a reaplica (`media-storage.ts`).
- **Para nós**: definir `audio.defaultPlaybackRate` **e** `playbackRate` com a preferência do usuário ao carregar cada aula; manter `preservesPitch = true` (padrão) — https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch.

**b) `waiting`/`stalled` e buffering**
- Vidstack aplica **debounce de 300 ms** ao `waiting` e **ignora `waiting` durante um seek pedido pelo usuário** (`if (this.#firingWaiting || this.#request.seeking) return;`) — https://github.com/vidstack/player/blob/main/packages/vidstack/src/core/state/media-state-manager.ts. Evita piscar o spinner a cada micro-buffer.
- Media Chrome deriva "carregando" de `readyState < 3` (HAVE_FUTURE_DATA) — fonte acima.
- `stalled` não é tratado como estado de UI em nenhum dos dois arquivos lidos [verificado por grep]; tratar `stalled` só como telemetria.

**c) Seek durante buffering / arraste do slider**
- Vidstack: `seekingRequestThrottle: 100` ms durante o arraste, `pauseWhileDragging: false` por padrão — https://vidstack.io/docs/player/components/sliders/time-slider e `time-slider.ts`.
- Video.js 8 historicamente enfileirava eventos `seeked/canplay/playing` em cenários MSE — https://github.com/videojs/video.js/pull/5024 (irrelevante para m4a progressivo, mas mostra que o estado "seeking" deve prevalecer sobre "waiting").

**d) iOS Safari**
- **Volume é somente leitura** em iOS (todos os navegadores WebKit): o valor é sempre 1 e setar não tem efeito — https://github.com/mdn/browser-compat-data/pull/16311; confirmado pelo mantenedor do wavesurfer em set/2026 — https://github.com/katspaugh/wavesurfer.js/issues/4044.
- Media Chrome detecta isso **por feature detection assíncrona** (`hasVolumeSupportAsync`: altera o volume de um elemento de teste e espera `volumechange`) e expõe `mediaVolumeUnavailable` para esconder o controle — https://github.com/muxinc/media-chrome/blob/main/src/js/utils/platform-tests.ts; https://github.com/muxinc/media-chrome/discussions/913. **Melhor que nossa regra atual "volume só em pointer fine"** (iPad com trackpad tem pointer fine e volume read-only).
- **Range obrigatório**: "HTTP servers hosting media files for iOS must support byte-range requests" — https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingVideoforSafarioniPhone/CreatingVideoforSafarioniPhone.html; implementação de referência com 206/416, `Accept-Ranges`, `Content-Range`, ETag/If-Range — https://smoores.dev/post/http_range_requests/.
- Autoplay: Video.js 10 removeu o evento `auto-play-fail`; recomenda chamar `play()` e tratar a Promise rejeitada — https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#autoplay. Para nós: nunca autoplay; `play()` só em gesto do usuário e tratar rejeição.
- `preload`: [premissa] iOS tende a ignorar/limitar `preload`; usar `preload="metadata"` e não depender de duração antes de `loadedmetadata`.

**e) Media Session**
- Vidstack registra `play`, `pause`, `seekforward`, `seekbackward`, `seekto` (offset padrão 10 s), define `metadata` e `playbackState`, mas **não chama `setPositionState`** no arquivo lido — https://github.com/vidstack/player/blob/main/packages/vidstack/src/core/state/navigator-media-session.ts. Media Chrome também não chama (grep sem ocorrências). **Video.js 10 não define metadados** (#3042).
- Guia de referência: chamar `setPositionState` ao iniciar, em seek e em mudança de velocidade; duração > 0, posição ≤ duração, velocidade > 0; `seekOffset` ausente → usar 10–30 s; usar `fastSeek` quando `details.fastSeek`; forçar `playbackState` durante seek/carregamento; artwork 96–512 px (512 no Android) — https://web.dev/articles/media-session; MDN: https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setPositionState.
- Chrome: resetar/atualizar o position state ao trocar de mídia para não exibir progresso errado — https://developer.chrome.google.cn/blog/automatic-picture-in-picture-initiated-by-the-browser (espelho de developer.chrome.com).

**f) Escopo dos atalhos de teclado**
- **Plyr**: `keyboard: { focused: true, global: false }` — atalhos só com o player focado por padrão — https://github.com/sampotts/plyr#options.
- **Media Chrome**: listener de `keydown` no próprio `<media-controller>` (escopo = foco dentro do player); `preventDefault` só em Espaço/setas e **não quando o foco está num range**; atributo `keysused` deixa um controle "reservar" teclas; `hotkeys="no..."` bloqueia teclas; `nohotkeys` desliga tudo; Shift+/ abre diálogo de atalhos; passos: seek 10 s, volume 0,025, velocidade 0,25 — https://github.com/muxinc/media-chrome/blob/main/src/js/media-controller.ts.
- **Vidstack**: `keyTarget: 'player' | 'document'`; ignora a tecla se o foco estiver em `input, textarea, select, [contenteditable], [role^="menuitem"], [role="timer"]`; com vários players, o ativo é o último focado — https://github.com/vidstack/player/blob/main/packages/vidstack/src/core/keyboard/controller.ts.
- **Video.js 10**: um `Hotkey` por atalho; botões ganham `aria-keyshortcuts` automaticamente; com vários players, o primeiro registrado responde — https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#keyboard-shortcuts.

**g) Slider de tempo — semântica de teclado**
- APG Media Seek Slider: setas ±1 passo, **Page Up/Down ±15 passos**, Home/End; `aria-valuetext` em minutos e segundos; **o total só entra no valuetext na inicialização e ao focar**, para não ser verboso a cada mudança; valor exibido ao lado do thumb (ajuda quem usa ampliação); cores via `currentcolor` para modo de alto contraste — https://www.w3.org/WAI/ARIA/apg/patterns/slider/examples/slider-seek/.
- Media Chrome: `aria-valuetext` = "{currentTime} of {totalTime}" (i18n), "video not loaded, unknown time." antes de carregar — `media-time-range.ts`.
- Vidstack: "X out of Y" falado (`formatSpokenTime`), `keyStep: 5` s, `shiftKeyMultiplier: 2` — `time-slider.ts`.
- Video.js 10: foco e teclado no **thumb** (não na raiz); sliders com `touch-action: none` — https://videojs.org/docs/framework/html/guides/accessibility.

### 2.4 Acessibilidade declarada
- **Video.js 10** (a mais completa, documentada): alvo WAI-ARIA 1.2 + WCAG 2.2; container com `role="group"`, `tabindex="0"`, `aria-label`; **live region `role="status"`** que anuncia só mudanças *confirmadas* (play/pause, velocidade, onde o seek terminou), agrupa seeks rápidos e **fica em silêncio enquanto um slider está focado**; respeita `prefers-contrast`, `prefers-reduced-motion`, `prefers-reduced-transparency`; aviso de que `--media-scale-unit` em px não escala com a fonte do usuário — https://videojs.org/docs/framework/html/guides/accessibility.
- **Able Player**: o único com transcrição interativa embutida e preferências de usuário: destaque ligável/desligável, transcrição navegável por teclado **desligada por padrão** porque cria muitos tab stops, transcrição em qualquer idioma de legenda disponível, descrição de áudio estendida — https://ableplayer.github.io/ableplayer/. No código, um checkbox "Auto scroll"; **qualquer rolagem/roda do mouse do usuário desliga o auto-scroll** e cabeçalhos de capítulo com `aria-level` — https://github.com/ableplayer/ableplayer/blob/main/scripts/transcript.js. A W3C o cita como exemplo — https://www.w3.org/WAI/media/av/player/.
- **Plyr**: "full support for VTT captions and screen readers", portado do player acessível do PayPal — README.
- **wavesurfer / Shaka**: não são players de UI acessível para o nosso caso (forma de onda; motor de streaming). Não recomendados.

### 2.5 Compatibilidade com Angular zoneless
- Web components (`@videojs/html`, `media-chrome`, `vidstack` elements) funcionam em Angular com `CUSTOM_ELEMENTS_SCHEMA`; em zoneless, eventos DOM ligados no template disparam detecção normalmente e o estado pode ser lido para signals [premissa — não testado nesta pesquisa].
- Nenhum dos três documenta Angular oficialmente (o guia de presets do Video.js 10 só cita HTML e React — https://videojs.org/docs/framework/html/guides/presets).
- Tema com nossos tokens: Video.js 10 expõe só 8 custom properties públicas; o resto exige editar o código da skin (Shadcn/ejetar) — https://videojs.org/docs/framework/react/guides/migrate-from-vidstack#level-2-restyle-it; o Media Chrome sofre com Shadow DOM (ver 2.2). Um componente próprio em light DOM usa nossos tokens CSS diretamente.

---

## 3. Diretrizes de acessibilidade para player e transcrição interativa

- **W3C WAI — Media Players**: requisitos mínimos: teclado, foco visível, rótulos claros, contraste de texto/controles (1.4.3, 1.4.11); funcionalidades extras desejáveis: mudar velocidade, configurar exibição de legendas, ler legendas com leitor de tela/braille, **transcrição interativa**. Recomenda usar player existente acessível ou ter "advanced HTML and JavaScript skills" para construir — https://www.w3.org/WAI/media/av/player/.
- **W3C WAI — Transcripts**: transcrição interativa "highlight text phrases as they are spoken. Users can select text in the transcript and go to that point"; transcrição deve ser fácil de achar a partir do áudio — https://www.w3.org/WAI/media/av/transcripts/. Para **áudio pré-gravado**, a transcrição é a alternativa exigida (SC 1.2.1, nível A) — https://www.w3.org/WAI/media/av/planning/ ; https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded.
- **Media Accessibility User Requirements** (detalhe de requisitos) — https://www.w3.org/TR/media-accessibility-reqs/.
- **APG slider de seek** — ver 2.3 g.
- **Critérios WCAG 2.2 que mais afetam a nossa spec** (Understanding docs da W3C):
  - **2.1.4 Character Key Shortcuts (A)**: atalhos de tecla única (K, J, L, M, C, 0–9) precisam poder ser desligados, remapeados, **ou só valer quando o componente tem foco** — https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts. Atalhos "estilo YouTube" globais na página violam isso.
  - **2.4.11 Focus Not Obscured (Minimum) (AA)**: um mini-player fixo no rodapé não pode esconder totalmente o elemento focado — https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.
  - **2.5.7 Dragging Movements (AA)**: o slider precisa de alternativa de ponteiro único sem arrastar (clicar na trilha) — https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.
  - **2.5.8 Target Size (Minimum) (AA)**: ≥ 24×24 px — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.
  - **4.1.3 Status Messages (AA)**: mudanças como "Velocidade 1,5×" e "Posição 23:10" via live region — https://www.w3.org/WAI/WCAG22/Understanding/status-messages.
  - **1.4.2 Audio Control (A)**: sem autoplay de áudio > 3 s sem controle — https://www.w3.org/WAI/WCAG22/Understanding/audio-control.
- **NN/g**: usuários precisam de controle (iniciar, parar, reiniciar, volume) e de saber "o que vem" — "giving users a list of content or topics (or transcript) can help them navigate" — https://www.nngroup.com/articles/video-usability/.

---

## 4. Recomendação

### 4.1 Qual é "a melhor" referência
Não existe um único produto que cubra o nosso caso. A melhor combinação de referências:

1. **Engenharia do player (estado, eventos, edge cases): Media Chrome + Vidstack**, lidos no código. São os mais maduros em produção (Vidstack "tested at scale at Reddit" — https://vidstack.io/), MIT, e os casos difíceis (volume iOS, debounce de `waiting`, escopo de atalhos, `aria-valuetext`) estão resolvidos de forma legível.
2. **Acessibilidade do player: Video.js 10** (status announcer, foco no thumb, `prefers-*`, `aria-keyshortcuts`) + **APG Media Seek Slider**.
3. **Transcrição interativa: Able Player** (preferências, auto-scroll que respeita o usuário, capítulos como cabeçalhos) + **Apple Podcasts** (busca, tocar a partir do texto) + **YouTube** (botão de voltar ao trecho atual — com rótulo melhor).
4. **Produto de estudo: Snipd/Audible** (capítulos, marcadores com nota).

### 4.2 BUILD vs ADOPT
| Critério | Adotar Video.js 10 (`@videojs/html`) | Adotar Media Chrome / Vidstack | **Construir (Angular + signals)** |
|---|---|---|---|
| Manutenção | GA há 4 semanas; API recém-estabilizada | Media Chrome com fim anunciado; Vidstack só segurança até 01/2028 | nossa; escopo pequeno (só `<audio>` progressivo) |
| Cobertura do nosso caso | preset de áudio **sem text tracks**, velocidades fixas sem 0,75, **sem metadados Media Session**, sem persistência | cobre mais (Vidstack: capítulos, storage, Media Session), mas está em fim de vida | 100 % do que especificarmos |
| Transcrição sincronizada | não tem (só sugere colocar fora do container) | não tem | precisamos construir de qualquer forma |
| Bundle (gzip) | ~23 kB (áudio HTML) | 41–74 kB | [premissa] ~8–15 kB de código nosso |
| Tema com tokens | 8 custom properties; resto exige ejetar a skin | Shadow DOM/variáveis próprias | tokens diretos, light DOM |
| Angular zoneless | via custom elements, sem doc oficial [premissa: funciona] | idem | nativo |
| Licença | Apache-2.0 | MIT | — |

**Decisão recomendada: CONSTRUIR**, porque (a) as partes de maior valor — transcrição, retomada entre dispositivos, mini-player entre rotas, Media Session com position state — são de nível de aplicação e nenhuma biblioteca entrega; (b) áudio m4a progressivo dispensa motor de streaming, que é onde as bibliotecas mais agregam; (c) todas as opções de biblioteca estão em transição (fim de vida ou recém-GA com lacunas que nos atingem). Mitigação do risco que a W3C aponta ("advanced HTML and JavaScript skills"): seguir à risca APG + os padrões de código citados acima, e testar com NVDA/VoiceOver. **Revisitar** se o Video.js 10 fechar #3039 (captions em áudio), #1404 (velocidades configuráveis) e #3042 (Media Session).

---

## 5. Mudanças na nossa spec (priorizadas)

Legenda: **MUST** = obrigatório para v1 / conformidade; **SHOULD** = forte recomendação; **COULD** = desejável.

### MUST
1. **Escopo dos atalhos de tecla única**: ativos só com foco dentro do player/transcrição/mini-player (ou na página da aula fora de campos), **ignorar quando o foco está em `input, textarea, select, [contenteditable], menuitem`**, e preferência para desligá-los. *Fonte*: WCAG 2.1.4; Plyr `focused: true, global: false`; Vidstack `IGNORE_SELECTORS`; Media Chrome `nohotkeys`/`keysused`.
2. **`?` abre diálogo com a lista de atalhos** e botões expõem `aria-keyshortcuts`. *Fonte*: Pocket Casts; Media Chrome (Shift+/); Video.js 10.
3. **Auto-scroll da transcrição que respeita o leitor**: qualquer rolagem manual (roda, toque, teclado, scrollbar) suspende o acompanhamento; aparece botão **"Voltar ao trecho atual"** (rótulo explícito), que reativa o acompanhamento; ao clicar num trecho, o acompanhamento volta. Nunca rolar a página/painel contra o usuário. *Fonte*: Able Player (`transcript.js`); YouTube "Sync to video time" (e a confusão com o rótulo); Eden/Readwise; reclamação do Descript.
4. **Trecho ativo com `aria-current="true"`** (não live region a cada segmento) e opção de desligar o destaque. *Fonte*: Able Player (preferência "Highlight transcript"); Video.js 10 (não anunciar atualizações rotineiras de tempo).
5. **Teclado na transcrição sem dezenas de tab stops**: um único tab stop no painel com navegação por setas (roving tabindex), Enter toca do trecho. *Fonte*: Able Player desliga a transcrição navegável por padrão justamente pelos tab stops excessivos; a solução por roving tabindex é [premissa] nossa, seguindo padrões da APG.
6. **Busca na transcrição** (realce das ocorrências, próximo/anterior, Enter toca a ocorrência). *Fonte*: Apple Podcasts; Otter.
7. **Media Session completa**: `metadata` (título da aula, professor, curso, artwork 96–512 px), handlers `play/pause/seekbackward(15)/seekforward(30)/seekto` (com `fastSeek`), **`setPositionState`** em `loadedmetadata`, `play`, `pause`, `seeked`, `ratechange`, e reset ao trocar de aula; forçar `playbackState` durante seek/buffering. *Fonte*: web.dev Media Session; MDN; blog do Chrome; lacuna em Vidstack/Media Chrome (não chamam) e Video.js 10 (#3042).
8. **Volume por feature detection**, não só `pointer: fine`: esconder quando `volume` é read-only (iOS/iPadOS). *Fonte*: Media Chrome `hasVolumeSupportAsync`/`mediaVolumeUnavailable`; MDN BCD #16311; wavesurfer #4044.
9. **Velocidade sobrevive à troca de aula**: aplicar `defaultPlaybackRate` + `playbackRate` da preferência a cada `src`; reler em `loadstart`/`ratechange`; `preservesPitch` true. *Fonte*: WHATWG #2739; Vidstack #1120; Media Chrome (`ratechange` + `loadstart`).
10. **Buffering sem piscar**: indicador só após ~300 ms de `waiting`, ignorado durante seek do usuário; "carregando" = `readyState < 3`; `stalled` só para telemetria. *Fonte*: Vidstack `media-state-manager.ts`; Media Chrome `state-mediator.ts`.
11. **Slider conforme APG**: foco no thumb; ←/→ ±5 s, Shift ±10 s [premissa de valores, alinhados a Vidstack], Page Up/Down ±1 min [premissa; APG usa 15 passos], Home/End; `aria-valuetext` falado em pt-BR ("23 minutos e 10 segundos de 1 hora e 32 minutos") com total **apenas no foco/inicialização**; "aula não carregada" antes de `loadedmetadata`; clique na trilha sem arrastar; tempo-prévia junto ao thumb durante o arraste; seek com throttle ~100 ms. *Fonte*: APG Media Seek Slider; Media Chrome; Vidstack; WCAG 2.5.7.
12. **Live region de status** (`role="status"`) para mudanças confirmadas: play/pause, velocidade, "Posição 23:10" após skip/seek, CC; agrupar mudanças rápidas e silenciar enquanto o slider está focado. *Fonte*: Video.js 10 accessibility guide; WCAG 4.1.3.
13. **Mini-player não cobre o foco**: `scroll-padding-bottom` igual à altura do mini-player e conteúdo com margem inferior; testar Tab por toda a página com o mini-player aberto. *Fonte*: WCAG 2.4.11.
14. **Servidor/CDN**: `Accept-Ranges: bytes`, 206 com `Content-Range`, 416 fora do intervalo, `ETag`/`If-Range`, `Content-Type: audio/mp4`; teste automatizado disso no BFF. *Fonte*: Apple Safari Web Content Guide; smoores.dev.
15. **Retomada entre dispositivos robusta**: gravar localmente com throttle (~1 s) e enviar ao servidor em `pause`, `visibilitychange→hidden`, `pagehide` (fetch `keepalive`/`sendBeacon`) e a cada N s em reprodução [premissa: N = 15–30 s]; regra de conflito "posição mais recente por timestamp do servidor" [premissa]; ao chegar a 95 % marcar concluída e não oferecer "Continuar" (já na spec). *Fonte*: Vidstack `media-storage.ts` (throttle 1 s, salva imediato ao terminar); Video.js 10 não persiste nada (#944) → é responsabilidade da aplicação.
16. **Sem autoplay**; `play()` só por gesto, tratando a Promise rejeitada. *Fonte*: WCAG 1.4.2; Video.js 10 (autoplay).

### SHOULD
17. **Capítulos/seções da aula** (WebVTT `kind="chapters"`): marcas no slider, lista de capítulos, título do capítulo atual no player e no mini-player; capítulos como cabeçalhos dentro da transcrição. *Fonte*: Vidstack (capítulos no slider/menu); Able Player (`aria-level` nos capítulos); Snipd; NN/g "Tell users what's coming".
18. **Marcadores com nota** ("Marcar este trecho"), atalho dedicado (p.ex. `B`) [premissa de tecla], lista de marcadores da aula. *Fonte*: Audible Cloud Player (bookmarks + notas); Snipd (snips); Otter/Eden (highlight do trecho atual, `H`). Decisão de produto — confirmar escopo com PO.
19. **Velocidade**: degraus 0,75 · 1 · 1,1 · 1,25 · 1,5 · 1,75 · 2 [premissa: incluir 1,1] com menu + atalhos `<`/`>` (passo 0,25, sem wrap-around), valor atual sempre visível; tocar no valor volta a 1×. *Fonte*: Pocket Casts (stepper e reset); Media Chrome (passo 0,25); crítica implícita ao Video.js 10 (lista fixa e wrap-around).
20. **Intervalos de skip configuráveis** (padrão 15/30). *Fonte*: Pocket Casts (10/45 configurável); Audible.
21. **`0–9` pula para 0–90 %** e `J/L` ±10 s como aliases. *Fonte*: Plyr; Video.js 10 skins.
22. **Transcrição recolhível** com preferência lembrada; tamanho de fonte da transcrição seguindo o tema. *Fonte*: reclamação Spotify (não dá para desligar); Able Player (preferências).
23. **Copiar/compartilhar trecho com link `?t=`** (ex.: "Copiar citação com tempo"). *Fonte*: Apple Podcasts (até 200 palavras com link).
24. **`prefers-reduced-motion`**: rolagem automática sem `smooth`; `prefers-contrast`/forced colors com `currentcolor` no slider. *Fonte*: Video.js 10; APG (alto contraste).
25. **Tamanhos em `rem`** para escalar com a fonte do usuário. *Fonte*: Video.js 10 (alerta sobre `--media-scale-unit` em px).

### COULD
26. **Encurtar silêncios / normalizar volume** (Smart Speed/Voice Boost-like via Web Audio). *Fonte*: Overcast; Otter (skip silence); Pocket Casts não oferece no web (pedido no fórum). Custo/complexidade alto.
27. **Destaque palavra a palavra** (exige timings por palavra no VTT/JSON). *Fonte*: Apple Podcasts, Otter, Descript, TED. Segmento-a-segmento basta na v1.
28. **Sleep timer** [premissa: comum em apps de áudio; não verificado em web players nesta pesquisa].
29. **Gestos de toque** (duplo toque laterais ±skip) no player expandido mobile. *Fonte*: Video.js 10 gestures.
30. **Forma de onda** (wavesurfer.js) — baixo valor para aula falada; não recomendado.

### O que manter da spec atual (validado pelas fontes)
- Play/pause 56 px (acima de 2.5.8); back 15 s / forward 30 s (assimetria igual à do mercado); faixa de buffer no slider (Vidstack `Progress`, Media Chrome `mediaBuffered`); toggle decorrido/restante; prompt "Continuar de 23:10"; 95 % = concluída; CC via WebVTT.

---

## 6. Lacunas e premissas desta pesquisa
- Comportamento exato do YouTube (valores de atalhos, busca no painel) não foi verificado em fonte do Google.
- Web players de Overcast e Audible não foram inspecionados ao vivo.
- Compatibilidade Angular zoneless dos web components não foi testada.
- Tamanho estimado do componente próprio é estimativa.
- Data de GA do Video.js 10 (01/10/2026) vem do blog oficial + https://www.forasoft.com/learn/video-streaming/articles-streaming/video-js-v10-spf ; a release `video.js@10.0.1` de 02/10/2026 foi vista via `gh api repos/videojs/v10/releases`.

---

## 7. Lições de players em produção nos sistemas de áudio da empresa do dono (só conhecimento)

Leitura de dois produtos internos (um em React, um em Angular com signals, a mesma base do kb-chat), sem copiar código, conforme a regra do dono. Oito players encontrados: modais simples de gravação, bolhas de áudio de chat e uma lista de reprodução de análise de fala com transcrição clicável.

**O que vale como ideia (adotado na spec):**
- Velocidade aplicada em `defaultPlaybackRate` **e** `playbackRate`, com `preservesPitch`, e a preferência guardada validada contra a lista de valores permitidos.
- Contador de sequência para descartar a resposta de uma carga antiga que chega depois de uma nova (clicar A, depois B, e A responder por último).
- Um único elemento de mídia para o app inteiro: só uma coisa toca por vez, base do mini-player.
- Trabalho pesado da transcrição memorizado, para não rodar a cada `timeupdate` (cerca de 4 vezes por segundo).
- Marcas no slider para momentos importantes, com pulo ao clicar (vai para os capítulos da fase B).

**Bugs e armadilhas vistos no histórico ou no código (evitados na spec):**
- Um proxy que lia o arquivo inteiro e respondia sempre 200, ignorando o `Range`, mesmo anunciando `Accept-Ranges` (pulo quebrado em arquivos longos, pior no Safari). Coberto pelos testes de Range do KBC-034.
- O navegador busca a mídia sozinho, sem o cabeçalho `Authorization`: autenticação por cabeçalho não funciona num `src` nativo. O kb-chat usa o cookie de sessão, que segue junto.
- Estado "tocando" marcado antes de a promessa de `play()` confirmar e sem ouvir `pause` e `error`: a tela fica dessincronizada quando o sistema pausa (fone, chamada). Na spec, o estado vem só dos eventos.
- `audio.src = ''` para limpar dispara erro ou pede a URL da página; o certo é remover o atributo e chamar `load()`.
- Ao terminar, voltar a 0 sozinho; na spec, aparece "Ouvir de novo".
- Busca linear do segmento ativo a cada tique: aceitável numa ligação, lenta numa palestra de 2 h. Na spec, busca binária.
- Página pulando quando os metadados chegam: reservar o espaço do player desde a primeira pintura.
- Áudio codificado que tocava no Chrome e não no iPhone: testar os arquivos convertidos no Safari real (está na barra de qualidade).

**O que faltava neles e entra no nosso:** Media Session, retomar, mini-player, legendas, busca na transcrição, atalhos, `aria-valuetext` falado, rolagem automática que respeita o leitor, estados de espera e erro com nova tentativa e testes E2E de Range e de pulo.
