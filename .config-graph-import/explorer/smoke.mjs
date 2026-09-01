/**
 * A DOM shim just large enough to run the explorer headlessly.
 *
 * Not a test of rendering - it is a test of *wiring*. The scenario logic is
 * already covered by Lifecycle.e2e.test.ts; what this catches is the class of
 * bug that suite cannot see: an element id that does not exist, a handler that
 * throws, a render path that runs before its data is ready. Those only show up
 * when the module is actually executed against a document.
 *
 *   node explorer/smoke.mjs
 */

const listeners = new Map();

const makeEl = (tag) => {
  const node = {
    tagName: tag,
    className: "",
    textContent: "",
    children: [],
    dataset: {},
    disabled: false,
    append: (...kids) => node.children.push(...kids),
    replaceChildren: (...kids) => {
      node.children = [...kids];
    },
    addEventListener: (event, fn) => {
      listeners.set(`${node.__id}:${event}`, fn);
    },
  };
  return node;
};

const byId = new Map();
const IDS = [
  "theme",
  "release-tiles",
  "release-note",
  "step",
  "reset",
  "timeline",
  "step-tiles",
  "answers",
  "step-note",
  "verify",
  "tamper",
  "untamper",
  "tree",
  "verify-out",
  "propose",
  "publish",
  "diff-out",
  "replay-out",
];
for (const id of IDS) {
  const el = makeEl("div");
  el.__id = id;
  byId.set(id, el);
}

globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: (id) => {
    const el = byId.get(id);
    if (!el) throw new Error(`explorer references missing element #${id}`);
    return el;
  },
  createElement: makeEl,
  createTextNode: (text) => ({ tagName: "#text", textContent: text }),
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
};

const fire = (id, event = "click") => {
  const fn = listeners.get(`${id}:${event}`);
  if (!fn) throw new Error(`no ${event} handler bound to #${id}`);
  fn();
};

const text = (node) =>
  [node.textContent ?? "", ...(node.children ?? []).map(text)].join("");

await import("./build/app.js");

// Walk the same path a person would.
const trace = [];
for (let i = 0; i < 4; i++) {
  fire("step");
  const tiles = byId.get("step-tiles").children.map(text);
  trace.push(tiles.join(" | "));
}

fire("verify");
const clean = text(byId.get("verify-out"));

fire("tamper");
fire("verify");
const tampered = text(byId.get("verify-out"));

fire("untamper");
fire("propose");
const diff = text(byId.get("diff-out"));

fire("publish");
const replay = text(byId.get("replay-out"));

fire("theme");
fire("reset");

const problems = [];
if (!clean.startsWith("Verified."))
  problems.push(`clean verify said: ${clean}`);
if (!tampered.startsWith("Tampered at")) problems.push(`tamper not caught: ${tampered}`); // prettier-ignore
if (!diff.includes("i9-applies")) problems.push("diff did not name the changed rule"); // prettier-ignore
if (!replay.includes("Pinning is precise")) problems.push("replay panel empty");

console.log("steps:");
for (const line of trace) console.log("  " + line.replace(/\s+/g, " "));
console.log("\nverify (clean)   :", clean.slice(0, 60));
console.log("verify (tampered):", tampered.slice(0, 60));
console.log(
  "diff names rules :",
  /i9-applies|i9-required|i9-overdue/.test(diff)
);
console.log("replay verdict   :", replay.slice(0, 80));

if (problems.length > 0) {
  console.error("\nFAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("\nexplorer wiring OK");
