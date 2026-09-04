# @bjacobso/triplex-cloudflare

Cloudflare Durable Object SQLite storage support for Triplex.

```bash
npm install effect @bjacobso/triplex @bjacobso/triplex-cloudflare
```

This package currently exposes the Durable Object `StorageAdapter` and database-manager wiring. It
uses the greenfield bitemporal schema, but it does not yet expose the same one-line `Triples` layer
or pass the complete shared backend conformance corpus.

Status: private experimental workspace package, held from the first npm release.

MIT © 2026 Ben Jacobson.
