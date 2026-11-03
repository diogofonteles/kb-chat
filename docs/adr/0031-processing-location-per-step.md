# 0031 — Processing location per step: paired computers, the server, on-demand GPU or a cloud provider, with per-collection consent before audio leaves our infrastructure

- Status: proposed (2026-11-03); waits for the owner's answers to the open decisions below (phase 3, `phase-3-server-processing`, KBC-078 to KBC-087)
- Amends (when accepted): [0022](0022-media-library-store-queue-and-streaming.md) (the VM media worker gains `diarize` and voice-embedding kinds; spend caps per person and per collection), [0023](0023-transcription-pull-worker-on-the-owners-mac.md) (the Mac is one location among several; Groq becomes a configurable location instead of a fallback mode; workers of other people), [0029](0029-recording-edits-speakers-tracks-and-subjects.md) (diarization and voice embeddings may run on the server; embeddings still never leave our infrastructure)
- Drivers: the owner's request of 2026-11-03 ("vejo que estamos fazendo algumas features com análise diretamente pelo mac (por ser mais rápido) mas precisamos criar cards para que em um determinado momento possamos fazer tudo diretamente pelo app, sem depender do computador pessoal (isso poderá ser até um parâmetro de configuração, se for o caso), para que outras pessoas possam usar esses recursos / coloque isso como uma outra fase do projeto, para liberarmos em outra versão"); the owner's rule that everything is configured in the UI (2026-10-26); the per-feature permission rule (2026-10-28); the media monthly cap (US$ 10, ADR 0022 §7); LGPD (art. 5º II and art. 11 for voice prints; art. 7º, 33 and 39 for sending personal data to processors abroad)

## Context

Phase 2 puts every speech step on the owner's Mac: transcription (mlx-whisper turbo, ADR 0023), voice separation (Senko or pyannote, KBC-064), voice profiles (ECAPA, KBC-071), and optionally a local text model for tracks (`propose`, ADR 0029 §7). Only Groq exists as a fallback for transcription (KBC-037), turned on by a master. The Mac is fast and free, but it sleeps, is behind NAT and belongs to one person: when it is off the library stops, and nobody else can process their own uploads.

Today's privacy rule (KBC-063 BR-5, ADR 0029 §3) is that audio and voice data never leave the owner's Mac or our server to third parties unless the owner marks it. Running the steps elsewhere changes where audio goes, so the location of each step is a privacy decision as much as a cost one.

What we measured or read (see the references; **[verified]** = measured or read in the primary source, **[inferred]** = our estimate):

| Step | Location | Time per audio hour | US$ per audio hour | pt-BR quality known | Audio leaves our infrastructure? |
|---|---|---|---|---|---|
| Transcription | Owner's Mac, mlx-whisper turbo + VAD + terms | ~3.5 min (17× real time) [verified, pilot] | 0 | WER 7.1 % clean [verified, pilot] | No |
| Transcription | VM (faster-whisper small int8, 1 CPU) | RTF 0.55, wrong names [verified, pilot] | 0 | Unusable | No |
| Transcription | Groq `whisper-large-v3-turbo` | minutes; free tier 2 h of audio per hour, 8 h per day [verified, 2026-10-27] | 0.04 (10 s minimum per request) [verified] | WER 12.9 % one file per track; terms per chunk not yet measured [verified, pilot] | Yes |
| Transcription | Another authorised person's computer (Apple Silicon: mlx; NVIDIA: faster-whisper turbo) | Apple Silicon like the Mac; NVIDIA GPU several times real time; CPU only: slow [inferred] | 0 | Same model as the Mac; faster-whisper parity to measure | Goes to a person who can already hear it |
| Transcription | On-demand GPU running our container (Modal L4, US$ 0.000222/s ≈ US$ 0.80 per GPU hour [verified, modal.com/pricing 2026-11-03]) | ~1.5–3 min of GPU + ~1 min cold start [inferred] | ≈ 0.02–0.05 [inferred]; US$ 30/month of free credit on the Starter plan [verified] | Same model; parity to measure | Yes, to rented compute with no retention by us |
| Voices (diarization) | Owner's Mac, Senko | 2–7 s [verified] | 0 | No DER in pt anywhere; to measure | No |
| Voices | VM CPU, sherpa-onnx (pyannote 3.0 segmentation + CAM++/3D-Speaker, ONNX int8) | RTF ~0.24 ≈ 14.5 min on a third party's CPU [observed by third parties]; on 1 Ampere core to measure | 0 | Same family as Senko | No |
| Voices | On-demand GPU, pyannote `community-1` | ~31 s on a server GPU + cold start [verified for the GPU time] | ≈ 0.01–0.02 [inferred] | Same as on the Mac | Yes, rented compute |
| Voices | pyannoteAI hosted | minutes | 0.04 (`community-1`) to 0.13 (`precision-3`), 19 €/month minimum plan [verified] | Not published | Yes |
| Transcription + voices | AssemblyAI / ElevenLabs / OpenAI / Deepgram | minutes | 0.22–0.67 [verified/observed] | Not checked | Yes |
| Voice embeddings (profiles, recognition) | Owner's Mac, ECAPA on MPS | 11–14 s [verified] | 0 | EER < 1 % with Brazilian speakers [verified, research S36] | No |
| Voice embeddings | VM CPU, ECAPA only on sampled speech per voice (≤ 60 s per voice) | ECAPA over every window on a CPU took 1,411 s per audio hour [verified]; sampling ≈ 1/20 of that ≈ 1–2 min per recording [inferred] | 0 | Same model | No |
| Tracks, titles, subjects (text) | House AI (OpenRouter), DeepSeek V4 Flash | 37 s [verified] | 0.0048 [verified] | 4/4 windows valid; owner's grade pending | Transcript text only, already allowed (ADR 0029 decision 3) |
| Tracks, titles, subjects (text) | Owner's Mac, Qwen3-30B-A3B local | ~11 min, 1 window in 4 invalid [verified] | 0 | Not good enough yet | No |

At the planned volumes: 500 h through Groq turbo cost ≈ US$ 20 (2,000 h ≈ US$ 80), above the US$ 10 monthly cap unless spread over months or paid by the free tier; voices on the VM cost nothing but take ≈ 120–250 h of one CPU for 500 h [inferred]; text AI is negligible.

## Decision (proposed)

1. **"Onde processar" is a setting per step, in the UI, not in code.** Steps: `transcribe`, `diarize`, `voice-embedding` (profiles and recognition), `propose` (tracks, titles, speaker names by context), `classify` (subjects). Each step has an **ordered list of locations** and a **fallback rule** ("use the next location when the current one has not taken the job for N hours", N default 12, as KBC-037). Locations:
   - `paired-computer` — any paired worker allowed for the job's collection (the owner's Mac or another authorised person's computer);
   - `server` — the VM media worker (1 CPU cap, ADR 0022), only for steps it can run well: `diarize`, `voice-embedding`; never `transcribe` (pilot);
   - `gpu-on-demand` — our own container on rented GPU (Modal first), started per batch and stopped after; nothing kept on it after the job;
   - `provider:<id>` — a cloud API (Groq first for `transcribe`; pyannoteAI only if the owner adds it for `diarize`); house AI (OpenRouter) for `propose` and `classify`.
   The setting is stored in `media.db` (`media_processing_settings`, versioned, who changed it and when), read by a **dispatcher** in the API that decides, when a job is queued and again on each fallback tick, which location may lease it. Workers keep the pull protocol of ADR 0023; adapters for providers and on-demand GPU run inside the VM media worker. The defaults reproduce phase 2 exactly: `transcribe` = [paired-computer], `diarize` = [paired-computer], `voice-embedding` = [paired-computer], `propose`/`classify` = [house AI]. Changing the setting needs the new permission `media-processing-settings` (masters by default).
2. **Audio leaves our infrastructure only for collections marked to allow it.** "Our infrastructure" is the VM and the computers paired by authorised people (who can already hear the collection). Each collection has `audioMayLeave`: `no` (default), `transcription`, or `transcription-and-voices`, plus the allow-list of providers and whether rented GPU counts; a sub-collection inherits its parent's. The dispatcher never routes a job of a collection to a location the collection does not allow; such a job waits with the reason shown ("Este acervo não permite enviar áudio para fora"). Marking a collection records who, when, the legal basis declared and the text shown, and is audited. Phase 2's Groq fallback (KBC-037) is brought under this rule.
3. **Voice embeddings never leave our infrastructure**, whatever the collection allows: profiles (biometric, sensitive data) are computed and compared only on the server or on a paired computer, never by a provider or on rented GPU. Per-recording diarization (no embedding kept, ADR 0029 §1) may go to a provider or rented GPU only when the collection allows `transcription-and-voices`.
4. **Providers on the allow-list must not train on our audio and must delete it after the request**, verified in their terms when added (date and link recorded in the setting); the app sends 16 kHz mono FLAC chunks with no title, author or collection name in the request.
5. **Every paid location reserves its estimate before the job leaves** against three caps: the media monthly cap (ADR 0022 §7, default US$ 10), a per-collection monthly cap and a per-person monthly cap (the person who asked for the step); the job refuses with the cap that blocked it, and unspent reservations are refunded. Estimates per audio hour come from the table above and are refreshed from the real spend of the last 30 days.
6. **Workers of other people.** A person with the new permission `media-worker-pair` pairs their own computer (macOS, Windows, Linux) with the same token flow as ADR 0023; the worker may lease jobs only of collections the person can access **and** that allow other people's computers; it never receives voice profiles of collections the person cannot edit. Builds: mlx-whisper on Apple Silicon, faster-whisper (CTranslate2) with CUDA or CPU elsewhere, both with the same VAD, terms and post-filter parameters, and the worker reports its engine so quality can be compared.
7. **Fair queue.** Among queued jobs a location may take, the dispatcher picks round-robin by the person who asked, then by age, so one large import does not starve others; masters can raise a job's priority.
8. **Monitoring.** Each location reports last seen, jobs done and failed in 24 h, queue age and spend in the month; masters get an alert (e-mail, ADR 0012) when the oldest queued job of a step passes the fallback time with no location able to take it.

## Options considered

1. **Per-step ordered locations with per-collection consent (chosen).** One rule covers every step; phase 2 behaviour is the default; each collection decides whether its audio may leave; costs stay under caps.
2. **One global switch "Mac or cloud".** Simpler, but voices and transcription have very different costs and privacy weight, and some collections must never leave.
3. **Cloud provider for everything (AssemblyAI, ElevenLabs).** No machine to keep, but 5–15× the cost of Groq per hour, quality in pt unknown, and every recording and voice leaves.
4. **A paid GPU VM always on.** Fast, but tens to hundreds of dollars a month for a few hours of audio a week; on-demand GPU gives the same speed at cents per hour.
5. **Run Whisper on the VM.** Measured: too slow and wrong on names (pilot).
6. **Keep everything on the owner's Mac.** Free and best quality, but it is what the owner asked to stop depending on.

## Consequences

- Good: the library keeps working when the Mac is off; other people can process their own uploads with their own computers at no cost; every cost has an estimate and a cap.
- Good: the privacy decision is explicit, per collection and audited; voice prints never leave.
- Bad: more moving parts (dispatcher, adapters, other workers' builds, a GPU account); the VM worker image grows (ONNX models, possibly Python).
- Bad: quality may differ by location; every location must pass the same WER/DER gates on the pilot's excerpts before it can be first in a list.
- Bad: sending audio abroad (Groq, Modal and pyannoteAI process in the USA or the EU) is an international transfer under LGPD; the owner must record the legal basis per collection and the privacy policy (T11) must say so.
- Revisit when: a provider changes terms or price; volume passes ~100 h/month (a reserved GPU may become cheaper); a pt-BR diarization benchmark appears.
- Compliance: dispatcher unit tests (order, fallback, privacy refusal, caps); integration tests with fake workers and fake providers proving no job of a `no` collection reaches a provider or rented GPU and no embedding leaves the server; WER/DER gate scripts per location kept with the pilot's excerpts.

## Open decisions for the owner (recommended default first)

1. **May audio leave our infrastructure?** Recommended: yes, only for collections a master marks, step by step (`transcription`, `transcription-and-voices`), default `no` for all; voice profiles never.
2. **Under which consent?** Recommended: the master who marks a collection declares that the institution holds the rights to the recordings and the legal basis (legitimate interest or consent of the speakers); uploaders see a notice at upload; the privacy policy names the providers and countries.
3. **Which providers?** Recommended: transcription on Groq (`whisper-large-v3-turbo`, or `whisper-large-v3` if it wins the WER test) with on-demand GPU (Modal) for bulk; voices on the server (VM) by default and on-demand GPU for bulk; pyannoteAI and full-service APIs not enabled.
4. **Monthly caps?** Recommended: media cap stays US$ 10/month; per collection US$ 5/month; per person 5 h of paid audio per month; per run as today (US$ 0.25 for AI).
5. **Who may change "Onde processar" and pair computers?** Recommended: `media-processing-settings` only for masters; `media-worker-pair` granted per person by a master.
