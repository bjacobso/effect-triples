import {
  COMMIT_POSITION_TABLE_DDL,
  INDEX_DDLS,
  MIGRATIONS_TABLE_DDL,
  TRIPLES_TABLE_DDL,
} from "./schema.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: TRIPLES_TABLE_DDL,
  },
  {
    version: 2,
    name: "create_migrations_table",
    up: MIGRATIONS_TABLE_DDL,
  },
  {
    version: 3,
    name: "add_indexes",
    up: INDEX_DDLS[0],
  },
  {
    version: 4,
    name: "add_attribute_index",
    up: INDEX_DDLS[1],
  },
  {
    version: 5,
    name: "add_type_index",
    up: INDEX_DDLS[2],
  },
  {
    version: 6,
    name: "add_attr_string_index",
    up: INDEX_DDLS[3],
  },
  {
    version: 7,
    name: "add_attr_number_index",
    up: INDEX_DDLS[4],
  },
  {
    version: 8,
    name: "add_ref_index",
    up: INDEX_DDLS[5],
  },
  {
    version: 9,
    name: "add_temporal_index",
    up: INDEX_DDLS[6],
  },
  {
    version: 10,
    name: "add_entity_attr_index",
    up: INDEX_DDLS[7],
  },
  {
    version: 11,
    name: "add_tx_id_index",
    up: INDEX_DDLS[8],
  },
  {
    version: 12,
    name: "add_blob_value_type",
    up: `SELECT 1`,
  },
  {
    version: 13,
    name: "add_retract_tx_id",
    up: `ALTER TABLE triples ADD COLUMN retract_tx_id TEXT`,
  },
  {
    version: 14,
    name: "create_commit_position",
    up: COMMIT_POSITION_TABLE_DDL,
  },
];
