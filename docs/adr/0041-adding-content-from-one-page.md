# 0041 — Adding content from one page: inclusions with a ceiling, folders, recordings from links and lists, and a web search that goes on, all through the publishing Mac

- Status: accepted (2026-11-25, KBC-009, KBC-184, KBC-185, KBC-186; the owner's decisions of the day are named below)
- Amends: [0040](0040-source-conversion-and-document-uploads.md) §9 and §11 (a person's own half-sent file goes on at the level chosen now; another's never blocks; a link to a recording is any site yt-dlp reads one from, not YouTube alone; kb's `review` is in the collection, its `quarantined` is not), [0035](0035-tracks-as-kb-documents.md) (`kb index` runs with `--embed=false` and QMD embeds the collection alone), [0023](0023-transcription-pull-worker-on-the-owners-mac.md) (the lease order)
- Keeps: Q7 (the API never writes the vault), [0036](0036-access-levels-per-collection.md) §5, [0017](0017-ai-keys-sealed-at-rest.md) (the Firecrawl key), [0033](0033-resumable-uploads-tus-core-on-the-item.md)
- Drivers: the owner's request of 2026-11-25 ("todo o mecanismo … de criar acervo e adicionar documentos (texto, áudio, pesquisa na web em vídeos e etc) … totalmente pronto no app"), and what they said while trying it: whole folders with nothing lost, an estimate before sending, a search that is asked for a number of sources with no limit, goes on, and never repeats what it gave, and a screen that says what is happening

## Context

Documents and links could be sent (ADR 0040), but there was no page for it, a folder or a channel could not be given, nothing bounded what one inclusion spends, and searching the web for sources was done in the terminal. The collection made on the screen had no folder in the vault until its first recording.

## Decision

1. **One page, `/adicionar?acervo=<slug>`**, for files and whole folders, links, the web search, and audio or video. `ContentSender` is app-wide: the sends go on while the person uses the app, the browser asks before the tab closes, and a new version of the app does not reload over them. Its account always closes (sent + already there + failed + on their way = total; a failure taken off the list is still said).
2. **An inclusion (`batch`) has a ceiling.** Each item carries `{id, capUsd}` (default US$ 0.50, 0.05 to 5, adjustable later). A lease takes the rest of the month's or the inclusion's, whichever is smaller, less what other leases hold; under `MIN_LEASE_USD` the item waits, said with `heldBy`. What an item spent still counts after it leaves the list. All spend is counted: vision, `kb ingest`, classify, link and the map step.
3. **The estimate comes from what happened here**: the 90th percentile of the last items of each kind (document, image, page, recording), first measurements until there are some.
4. **Recordings from links.** yt-dlp on the Mac takes the sound of one item (`--playlist-items 1 --max-filesize 2G --match-filter !is_live`, its own configuration ignored) outside the vault lock, and gives it back as the sender's recording. A channel or playlist is listed first (`--flat-playlist`), and only what the person chooses becomes items. A video file enters by its sound. There is no video player (the owner's choice).
5. **The web search is Firecrawl's**, with the house's key sealed like the AI keys. One round is one query of ten per kind and author; each next round asks in other words, an audio or a video of one site at a time. Names go unquoted: spelled another way a quoted one finds nothing. What neither names the author nor is about the subject (half of its words, by their roots, in the title, extract or address) is dropped, and so are social networks, shops, streaming players and the engine's own redirects as texts. The closest come first. A search is kept in memory by person, collection and request: the same request goes on from there, with what was found and not given yet first. What a person was given is remembered per collection as short hashes (`web-search-seen.json`), so another day's search leaves it out; `again` brings it back. The API gives up to 30 a request and starts no round after 20 s; the screen asks until it has the number wanted, with no ceiling, and can be stopped.
6. **Documents before recordings.** A paired transcriber takes sent documents first (a minute each), five in a row, then what else waits has its turn.
7. **`kb index --embed=false`, then `qmd embed -c <collection>`.** `kb index` embeds every collection's pending documents; after a reconversion that is thousands, and one document would wait an hour for them.
8. **Room.** A person's waiting files are bounded (5 GiB; not a master's) and the disk keeps a reserve (5 GiB). Bytes that stopped arriving are given up in a week; what ended leaves the record in three months.

## Consequences

- The Mac does the work: an item sent to an API no paired Mac talks to waits, and the screen says there is no Mac. The owner's Mac is paired with the local app (staging); production needs a pairing of its own.
- The search's relevance is lexical, in the words the engine shows: an ambiguous subject ("cocriação" in marketing and in mysticism) is told apart by its authors or by a longer subject.
- A search costs two Firecrawl credits a query. Measured on 2026-11-25: 30 sources for four authors, 18 credits; 57 over two requests without authors, 24.
- Measured on the owner's Mac on 2026-11-25, on a clone of the vault: a web page ready in 36 to 52 s for US$ 0.0002 to 0.0013; a five-minute recording downloaded, transcribed and published in about two minutes.
