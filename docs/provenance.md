# Source provenance

Triplex began as the database subsystem of
[`bjacobso/open-ontology`](https://github.com/bjacobso/open-ontology).

The initial import was filtered from source commit
`473753746f7c8f40c059edf81cca47a8e04202ef` and retained the history affecting:

- `packages/database`
- `test/stress`

The filtered history is merged into this repository, preserving commit authorship and messages.
The source-to-filtered commit map is recorded in `docs/import-commit-map.txt`. After import, the
packages were renamed and flattened into the standalone package family; Open Ontology is not a
dependency and is not automatically synchronized with this repository.

Typed configuration began in the adjacent MIT-licensed `config-graph` repository. Its complete
reachable history through source commit `93de8e3` was merged without squashing, first under the
temporary `.config-graph-import` prefix and then reshaped into Triplex in a separate commit. The
source repository was not modified and remains an independent historical repository.
