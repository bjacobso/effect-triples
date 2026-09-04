---
layout: home
title: Triplex
titleTemplate: false
description: An Effect-native fact database with Datalog and typed, content-addressed configuration.
sidebar: false
aside: false
pageClass: triplex-index
---

<div class="triplex-home">
  <header class="triplex-home__intro">
    <div class="triplex-home__eyebrow"><span></span> EFFECT 4 · TYPESCRIPT</div>
    <h1>Facts that remember<br><em>when</em> and <em>why</em>.</h1>
    <p>
      An Effect-native fact database with Datalog and typed, content-addressed configuration.
      Query today, reconstruct last Tuesday, and pin every decision to the rules that produced it.
    </p>
    <div class="triplex-home__actions">
      <a class="triplex-home__primary" href="/configuration">Explore the model →</a>
      <a href="https://github.com/bjacobso/triplex">View on GitHub ↗</a>
    </div>
    <div class="triplex-home__coordinates" aria-label="Triplex coordinates">
      <span><b>01</b> entity</span>
      <span><b>02</b> valid time</span>
      <span><b>03</b> recorded time</span>
    </div>
  </header>

  <section class="triplex-home__code" aria-label="Triplex code examples">

::: code-group

<<< @/snippets/home/facts.ts{ts}

<<< @/snippets/home/query.ts{ts}

<<< @/snippets/home/ontology.ts{ts}

:::

  </section>

  <section class="triplex-home__statement">
    <p class="triplex-home__label">ONE COHERENT RECORD</p>
    <h2>Truth, time, policy, and provenance share an identity.</h2>
    <p>
      Operational facts stay separate from immutable configuration releases. The transaction
      journal connects them, so applications can answer what changed, who changed it, and which
      exact schema governed the write.
    </p>
  </section>

  <nav class="triplex-home__primitives" aria-label="Triplex primitives">
    <a href="/datalog"><span>01</span><strong>Triples + Datalog</strong><small>Bitemporal facts, joins, rules, negation, and stable pages.</small></a>
    <a href="/configuration"><span>02</span><strong>Typed configuration</strong><small>Merkle releases, movable refs, schema impact, and proofs.</small></a>
    <a href="/derivations"><span>03</span><strong>Derived work</strong><small>Content-addressed candidates with provenance and wakeups.</small></a>
    <a href="/operational-primitives"><span>04</span><strong>Causal operations</strong><small>Atomic commands, receipts, checkpoints, and entity timelines.</small></a>
  </nav>

  <footer class="triplex-home__footer">
    <span>KV · SQLite · PostgreSQL</span>
    <span>Effect 4.0.0-rc.112</span>
  </footer>
</div>
