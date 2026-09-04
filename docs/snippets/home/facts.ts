import { Effect } from "effect";
import { EntityId, KvTriples, Triples, ref, string } from "@bjacobso/triplex";

const student = EntityId.make("student:ada");
const course = EntityId.make("course:logic");

export const enrollment = Effect.gen(function* () {
  const triples = yield* Triples;

  return yield* triples.transact(
    [
      {
        op: "assert",
        entityId: student,
        entityType: "Student",
        attribute: ":student/name",
        value: string("Ada Lovelace"),
      },
      {
        op: "assert",
        entityId: student,
        entityType: "Student",
        attribute: ":student/course",
        value: ref(course),
      },
    ],
    {
      actor: "teacher:grace",
      commandId: "enroll:ada:logic",
      configSnapshot: "config:learning-2026.1",
    },
  );
}).pipe(Effect.provide(KvTriples.layer));
