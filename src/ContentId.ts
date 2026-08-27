/**
 * A content id: the SHA-256 of a canonically encoded value, rendered as
 * `sha256-<64 lowercase hex>`.
 *
 * The algorithm is in the string on purpose. Content ids are written to the
 * database and compared across deploys, so the day SHA-256 has to be replaced
 * the two generations must be able to coexist in one column rather than
 * requiring a flag day; a bare hex digest could not tell them apart.
 *
 * Every hash is domain-separated by a caller-supplied tag. Without it the
 * digest of a node body and the digest of an arbitrary string blob live in the
 * same space, and a value crafted to look like an encoded node could be passed
 * off as one.
 */

import { createHash } from "node:crypto";
import { Schema } from "effect";

export const ContentIdSchema = Schema.String.pipe(
  Schema.pattern(/^sha256-[0-9a-f]{64}$/, {
    message: () => "Expected a content id of the form sha256-<64 hex chars>",
  }),
  Schema.brand("ContentId")
);

export type ContentId = typeof ContentIdSchema.Type;

/**
 * Hash `payload` within `domain`. `domain` names the kind of thing being
 * hashed (`"config-graph/node"`, `"config-graph/closure"`) and is length-
 * prefixed so no two domains can produce the same pre-image.
 */
export const hash = (domain: string, payload: string): ContentId => {
  const digest = createHash("sha256")
    .update(`${domain.length}:${domain}:`, "utf8")
    .update(payload, "utf8")
    .digest("hex");
  return `sha256-${digest}` as ContentId;
};

export const isContentId = Schema.is(ContentIdSchema);

/** First 12 hex chars, for logs and UI. Never for equality. */
export const short = (id: ContentId): string => id.slice(7, 19);
