import {
  COMMAND_RECEIPTS_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  INDEX_DDLS,
  TRIPLES_TABLE_DDL,
} from "./schema.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: ReadonlyArray<string>;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "triplex_baseline",
    up: [TRIPLES_TABLE_DDL, ...INDEX_DDLS, COMMIT_POSITION_TABLE_DDL, COMMAND_RECEIPTS_TABLE_DDL],
  },
];
