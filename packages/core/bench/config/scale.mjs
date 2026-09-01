/**
 * What does the reactor actually cost at population?
 *
 * The forward path (evaluate, cache) is measured elsewhere. The question here
 * is the one that decides the architecture: whether standing registrations for
 * a large workforce fit in a process, and what a single submission costs when
 * they do.
 *
 *   node bench/scale.mjs [counts...]
 */
import { Effect } from "effect";

import * as B from "../../dist/config/index.js";

const { BoolExpr, Catalog, Evaluate, Reactor, World } = B;

const MARCH_3 = 1772496000000;
const clock = { now: MARCH_3, granularity: "day" };

// Three questions per employee, of the shape the domain actually uses.
const rules = {
  applies: BoolExpr.eq(World.SUBJECT, "role", "caregiver"),
  section1: BoolExpr.all([
    BoolExpr.exists(World.SUBJECT, "ssn"),
    BoolExpr.exists(World.SUBJECT, "work_auth"),
  ]),
  satisfied: BoolExpr.all([
    BoolExpr.rule("applies"),
    BoolExpr.rule("section1"),
    BoolExpr.exists(World.SUBJECT, "i9_verified_at"),
  ]),
};

const catalog = Catalog.fromNodes(
  Effect.runSync(Effect.all(Object.entries(rules).map(([k, e]) => Catalog.ruleNode(k, e)))),
);

const QUESTIONS = ["applies", "section1", "satisfied"];
const mb = () => process.memoryUsage().heapUsed / 1048576;

for (const n of process.argv.slice(2).map(Number).filter(Boolean).length
  ? process.argv.slice(2).map(Number).filter(Boolean)
  : [10_000]) {
  globalThis.gc?.();
  const before = mb();

  const facts = {};
  for (let i = 0; i < n; i++) {
    facts[`ee${i}/role`] = i % 3 === 0 ? "office" : "caregiver";
    facts[`ee${i}/ssn`] = `000-00-${String(i).padStart(4, "0")}`;
    if (i % 2 === 0) facts[`ee${i}/work_auth`] = "passport";
  }
  const world = World.make(facts);

  const entries = [];
  for (let i = 0; i < n; i++) {
    const env = Evaluate.env(world, clock, catalog, `ee${i}`);
    for (const q of QUESTIONS) {
      entries.push({ key: `ee${i}:${q}`, expr: rules[q], env });
    }
  }

  const t0 = process.hrtime.bigint();
  // registerAll, not register-in-a-loop: the latter is quadratic.
  const reactor = Reactor.registerAll(Reactor.empty, entries);
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  globalThis.gc?.();
  const resident = mb() - before;

  // One submission: the cost that has to stay flat.
  const t1 = process.hrtime.bigint();
  const REPS = 500;
  for (let i = 0; i < REPS; i++) {
    const who = `ee${i % n}`;
    const next = World.withFact(world, who, "work_auth", "passport");
    Reactor.react(
      reactor,
      [Reactor.factKey(who, "work_auth")],
      Evaluate.env(next, clock, catalog, who),
    );
  }
  const perSubmission = Number(process.hrtime.bigint() - t1) / 1e6 / REPS;

  // A publish: how many decisions read the rule that moved.
  const t2 = process.hrtime.bigint();
  const hit = Reactor.affected(reactor, [Reactor.ruleKey("applies")]);
  const fanoutMs = Number(process.hrtime.bigint() - t2) / 1e6;

  // How many DISTINCT decisions back those registrations - the number that
  // would actually be stored if proofs were persisted by content.
  const distinct = new Set([...reactor.registrations.values()].map((r) => r.evaluation.cid)).size;

  console.log(
    [
      `${n.toLocaleString()} employees`,
      `${(n * QUESTIONS.length).toLocaleString()} registrations`,
      `build ${buildMs.toFixed(0)}ms`,
      `resident ${resident.toFixed(0)}MB`,
      `index ${reactor.index.size.toLocaleString()} keys`,
      `submission ${perSubmission.toFixed(3)}ms`,
      `publish fanout ${hit.length.toLocaleString()} in ${fanoutMs.toFixed(1)}ms`,
      `distinct decisions ${distinct}`,
    ].join("\n  "),
  );
  console.log();
}
