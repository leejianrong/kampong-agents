<!--
title: "RAG over our own docs, and the ADR it missed"
description: A research agent that answers questions about kampong-agents with citations, built on local embeddings and Supabase pgvector. It works, and its best moment was a question it got slightly wrong.
slug: research-analyst
author: Jian
date: 2026-10-02
tags: [mastra, agents, rag, pgvector, supabase, embeddings, kampong-agents]
-->

---

# RAG over our own docs, and the ADR it missed

The fourth demo answers questions about kampong-agents using kampong-agents' own docs. We chunk the ADRs, planning docs and concept pages, embed them, store the vectors in Supabase with pgvector, and let an agent answer with citations back to the source files.

We picked it because the kampong spec already has a `knowledge_base` field, and we wanted to know whether that field gets you real retrieval or only a pile of text pasted into a prompt.

![The research-analyst dashboard: a real question answered with citations to three source documents, above a retrieval trace showing each matched chunk and its similarity score](https://raw.githubusercontent.com/leejianrong/kampong-agents/main/mastra-projects/research-analyst/docs/dashboard.png)

## The field that does nothing

It gets you neither, yet. `knowledge_base` accepts a `pdf`, `url` or `text` source, and the engine never reads it. A grep for "knowledge" across the engine's source returns zero hits. Agent instructions are built from `role` and `goal` strings and nothing else, and the reference docs say so themselves: "Declared, not yet executed".

So there was nothing to refine. The whole pipeline (chunking, embedding, a vector store, similarity search, citation) is the part that doesn't exist.

## Chunking

Chunks split on markdown headings first, so a chunk stays on one topic and can be cited as one. Any section still longer than 1200 characters gets cut into overlapping pieces (150 characters of overlap):

```ts
const MAX_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;
```

That second step is a naive fixed-width cut, and it can slice a sentence in half. It's fine for our corpus, where most sections are short. For a real product I'd want sentence-aware splitting.

## Embeddings without a second API key

Every other demo sends its model calls through OpenRouter, but OpenRouter has no embeddings endpoint. It only implements chat completions. The usual answer is a second provider (OpenAI, Cohere, Voyage) and a second key.

We ran a local sentence-transformer instead, `Xenova/all-MiniLM-L6-v2` through Transformers.js. The vectors are real 384-dimension embeddings, nothing is hashed or faked, and after the first weight download there's no network call per embedding. A kampong `knowledge_base` executor would have to make this choice deliberately: bundle a local model (no setup, but a runtime dependency and some CPU) or ask the user for a second BYOK key. I lean towards the local model for the default, since it keeps the local-first promise.

Retrieval is a Supabase RPC, `match_document_chunks`, doing cosine similarity and returning the top six. The analyst agent gets those six as a numbered list and has to cite the paths it actually used. If the sources don't answer the question, the instructions say to say so.

## What it does well

Ask it why kampong keeps canvas layout in a sidecar file and it returns a one-line answer (coordinates in the spec YAML would clutter it and make noisy diffs) citing `docs/concepts.md`, the ADR on the sidecar layout file and the external-editing tutorial. The trace shows the three matching chunks scoring 0.83, 0.76 and 0.72.

A harder one, how the local-first no-telemetry principle and the V5 hosted mode fit together, needed more than one document. It came back citing four (an ADR, the concepts page, `QUESTIONS.md` and `SLICES.md`), and the answer was careful about it, saying the sources don't state the link as one explicit rule but show the two treated as connected constraints. That's the behaviour we asked for.

## What it got wrong

I asked it what ADR-0007 decides about YAML parsing. The ADR is in the store (six chunks, according to the ingest log), and retrieval never returned a single one of them. The analyst still answered correctly, because the same decision is restated in a register entry in `QUESTIONS.md`, and it flagged honestly that this was an indirect source rather than ADR-0007 itself.

I find that more interesting than the successes. Plain cosine similarity on a short, specific question will happily prefer a shorter, more self-contained restatement elsewhere over the document you actually asked about. Once a corpus has near-duplicates, which any real set of docs does, you need more than a top-six vector search: hybrid keyword and vector matching, a larger match count, or rewriting the query first.

## A smaller lesson about free tiers

When I came back to run the demo again, nothing worked. The Supabase project had been paused for inactivity and its hostname no longer resolved, which shows up in the app as a bare `fetch failed`. Restoring it from the dashboard fixed it. If you build on a free tier, put the pause in your troubleshooting notes before you need it.

## What it says about kampong-agents

Static injection (here are three documents, put them in the prompt) and per-query retrieval are different capabilities, and they don't scale from one to the other. The first breaks down past a handful of small files. The second needs an ingestion pipeline, a vector store connection and a retrieval step that runs on every question. If `knowledge_base` is going to be real, the spec has to say which of the two it means, and for the second one it also has to say which embeddings to use.
