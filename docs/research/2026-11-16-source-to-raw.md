# Da fonte ao `raw/`: conversão, originais e proveniência (2026-11-16)

Pedido do dono (chat, 2026-11-16), a partir de um slide "Da fonte ao raw/":
- **as fontes:** web, documentos (PDF e Office), mídia (vídeo e áudio), imagens (diagramas e scans) e dados (CSV, JSON, conversas);
- **os conversores:** Firecrawl/Jina (web → Markdown), MarkItDown (Office, áudio, YouTube), Docling (PDF, OCR, tabelas, vídeo), ou nenhum (CSV, JSON, assets nativos);
- **o `raw/`:** Markdown mais os originais, porque "o derivado textual facilita a leitura; o formato nativo preserva a evidência";
- **a organização:** nomes claros, data quando importa, agrupado por fonte, projeto ou assunto, e o formato original preservado.

## Como é hoje (fatos)

| Fonte | Hoje no app e no vault |
|---|---|
| Web | `kb ingest url` (Firecrawl) existe. Nenhum acervo usa, e o app não aceita link |
| PDF e Office | Convertidos fora do app para `.txt` puro (`_convert/ready/…/<arquivo>.pdf.txt`), depois `kb ingest`. O texto perde **títulos, capítulos, tabelas, notas e a ordem das colunas**, e ganha números de página e quebras de linha no meio da frase. Os scans passaram por um OCR à parte (`_convert/ocr`) |
| Originais | **Não ficam no vault.** O `source_path` aponta o `.txt` convertido. Não há hash do original, conversor, versão nem data da conversão |
| Áudio e vídeo | Transcritor próprio no Mac (Whisper, vozes, faixas, ADR 0023/0035), melhor que um conversor genérico para o nosso caso |
| YouTube | `kb ingest youtube`/`channel` (legenda do YouTube). Não usado |
| Imagens (diagramas, mandalas, tabelas escaneadas) | Nada: uma imagem dentro do PDF some na conversão |
| Pelo app | Só mídia. Texto, link e documento entram só pelo Mac, à mão |

**Impacto na resposta completa:** o mapa do acervo (KBC-139) divide cada documento em seções. Com o texto puro de hoje, um livro de 255 KB não tem um título sequer para cortar. Com um Markdown estruturado, os capítulos e as seções já vêm marcados, as tabelas ficam legíveis e cada citação aponta uma página.

## Decisão proposta: uma etapa "converter" no Mac, antes do `kb ingest`

| Fonte | Conversor | Por quê |
|---|---|---|
| PDF com texto, PDF escaneado, tabelas | **Docling** (local, livre) | Títulos e capítulos, ordem de leitura, tabelas e OCR num só passo; Markdown com o número da página de cada bloco |
| Word, PowerPoint, Excel, EPUB, HTML salvo | **MarkItDown** (local, livre) | Office e EPUB para Markdown com títulos e listas |
| Página web e link | **Firecrawl** (o que o kb já usa); **Jina Reader** como alternativa sem chave | Web → Markdown limpo |
| Áudio e vídeo | **O nosso transcritor** (sem mudança) | Já faz vozes, faixas, termos e citação no tempo |
| YouTube | O transcritor sobre o áudio baixado, em vez da legenda automática | Mesma qualidade e o mesmo tratamento de uma faixa (KBC-142 BR-5) |
| CSV, JSON, conversas | **Sem conversão**, com uma página Markdown curta que descreve o arquivo | O dado fica como é |
| Imagens | OCR do Docling e uma descrição curta por um modelo de visão barato, marcada como "descrição gerada" | Diagramas e scans entram na busca sem se passar pelo texto do autor |

**Em todo caso:**
- **O original fica guardado** em `raw/_originals/<hash>.<ext>`. Na produção, ele é servido ao leitor pelo botão "Ver original".
- **A proveniência vai no frontmatter:** `original_sha256`, `original_name`, `converter` e a versão dele, `converted_at`, mais o `source_path` de sempre.
- **Os nomes** seguem `<autor ou origem>-<título>-<ano>` e a pasta segue a origem, como o slide pede.
- **Uma conversão que falha ou sai vazia** vai para a fila de revisão do kb e não entra no acervo.

## Itens
- **KBC-148:** a etapa de conversão no Mac, com Docling, MarkItDown e Firecrawl, os originais e a proveniência, mais a **reconversão do acervo atual** a partir dos originais que ainda existem. Vem **antes do backfill do mapa (KBC-143)**, para as seções nascerem dos títulos.
- **KBC-149:** enviar documento e link pelo app (PDF, Office, EPUB, imagem, URL, YouTube). O envio vai para a fila do Mac, passa pela conversão e recebe o mesmo tratamento de um texto: ingest, classificação, ligações e mapa.
