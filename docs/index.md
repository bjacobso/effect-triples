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
    <h1>Triplex</h1>
    <p>
      Bitemporal facts, Datalog, and typed, content-addressed configuration—built on Effect.
    </p>
    <div class="triplex-home__actions">
      <a href="/current-state">Get started →</a>
      <a href="/configuration">Configuration →</a>
    </div>
  </header>

  <section class="triplex-home__code" aria-label="Triplex code examples">

::: code-group

<<< @/snippets/home/facts.ts{ts twoslash}

<<< @/snippets/home/query.ts{ts twoslash}

<<< @/snippets/home/ontology.ts{ts twoslash}

:::

  </section>

  <nav class="triplex-home__guides" aria-label="Guides">
    <a href="/datalog">Datalog →</a>
    <a href="/configuration">Typed configuration →</a>
    <a href="/derivations">Derived facts →</a>
    <a href="/operational-primitives">Operations →</a>
    <a href="https://github.com/bjacobso/triplex">GitHub ↗</a>
  </nav>
</div>
