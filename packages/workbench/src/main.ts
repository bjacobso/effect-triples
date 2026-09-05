import { ManagedRuntime } from "effect";
import {
  applyChange,
  createWorker,
  fieldOptions,
  initialize,
  organizations,
  previewChange,
  readWorkbench,
  textValue,
  WorkbenchLayer,
  type ChangePreview,
  type EditableField,
  type WorkbenchData,
  type Worker,
} from "./data.js";
import { icon } from "./icons.js";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const runtime = ManagedRuntime.make(WorkbenchLayer);
const app = document.querySelector<HTMLDivElement>("#app")!;
let data: WorkbenchData;
let selected = "worker:2";
let page = "workers";
let view = "table";
let query = "";
let filter = "all";
let sort = false;
let showRole = true;
let inspectorTab = "explanation";
let modal: "create" | "edit" | "help" | null = null;
let preview: ChangePreview | null = null;
let busy = false;
let toast = "";
let error = "";
let returnFocus: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout>;
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
const orgFor = (worker: Worker) => organizations.find((org) => org.id === worker.employer)!;
const btn = (action: string, label: string, symbol = "", cls = "", extra = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ""}${label}</button>`;
const pill = (label: string, kind = "neutral") =>
  `<span class="pill ${kind}"><span class="dot"></span>${esc(label)}</span>`;
const eligiblePill = (eligible: boolean) =>
  `<span class="eligibility ${eligible ? "yes" : "no"}">${icon(eligible ? "check" : "close", 13)}${eligible ? "Eligible" : "Not eligible"}</span>`;
const orgBadge = (worker: Worker) =>
  `<span class="org-mark ${orgFor(worker).color}">${orgFor(worker).name[0]}</span><span>${esc(orgFor(worker).name)}</span>`;
const visibleWorkers = () =>
  data.workers
    .filter(
      (worker) =>
        `${worker.name} ${worker.role} ${orgFor(worker).name} ${worker.state}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "all" || (filter === "eligible" ? worker.eligible : !worker.eligible)),
    )
    .sort((a, b) => (sort ? a.name.localeCompare(b.name) : 0));
const notice = (message: string) => {
  toast = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    toast = "";
    render();
  }, 5000);
};
const run = async (work: () => Promise<void>) => {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await work();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy = false;
    render();
  }
};
const refresh = async () => {
  data = await runtime.runPromise(readWorkbench);
};

function sidebar() {
  const nav = (id: string, label: string, symbol: string, count?: number) =>
    btn(
      `page:${id}`,
      `<span>${label}</span>${count === undefined ? "" : `<span class="nav-count">${count}</span>`}`,
      symbol,
      `nav-item ${page === id ? "active" : ""}`,
      `aria-label="${label}" ${page === id ? 'aria-current="page"' : ""}`,
    );
  return `<aside class="sidebar"><a class="brand" href="/" aria-label="Workbench home"><span class="brand-mark">w<span>·</span></span>workbench<span class="beta">BETA</span></a>
    <div class="workspace"><span class="workspace-mark">N</span><div>Northstar<span>Workforce operations</span></div><span class="workspace-dot"></span></div>
    <div class="nav-section">WORKSPACE</div><nav aria-label="Workspace">${nav("workers", "Workers", "people", data.workers.length)}${nav("organizations", "Organizations", "building", organizations.length)}${nav("tasks", "Tasks", "tasks", data.tasks.length)}</nav>
    <div class="nav-section second">EXPLORE</div><nav aria-label="Explore">${nav("ontology", "Ontology", "graph")}${nav("rules", "Rules & derivations", "code")}${nav("activity", "Activity", "clock")}</nav>
    <div class="sidebar-bottom"><div class="connected-card"><span class="live-dot"></span><strong>A connected way to work.</strong><p>Every row is an object.<br>Every change has a story.</p>${btn("help", "Explore Workbench", "arrow", "text-button")}</div>${btn("help", "Quick start guide", "book", "nav-item guide")}<div class="profile"><span class="avatar profile-avatar">YO</span><div>You<span>Local workspace</span></div><span class="local-label">DEMO</span></div></div></aside>`;
}
function header() {
  const title = (
    {
      workers: "Workers",
      organizations: "Organizations",
      tasks: "Tasks",
      ontology: "Ontology",
      rules: "Rules & derivations",
      activity: "Activity",
    } as Record<string, string>
  )[page];
  return `<header class="topbar"><div class="breadcrumb">${icon("grid")}<span>Workspace</span>${icon("chevron", 12)}<strong>${title}</strong></div><div class="topbar-right"><span class="local-status"><span class="live-dot"></span>Browser-local demo</span>${btn("help", "", "info", "icon-button", 'aria-label="About this workspace"')}<span class="avatar tiny">YO</span></div></header>`;
}
function heading(title: string, subtitle: string, symbol: string, actions = "") {
  return `<div class="page-heading"><div class="title-icon">${icon(symbol, 25)}</div><div><div class="eyebrow">WORKFORCE OPERATIONS</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function stats() {
  const eligible = data.workers.filter((worker) => worker.eligible).length;
  const cards = [
    ["Total workers", data.workers.length, "Across 3 organizations", "people", ""],
    [
      "Eligible to work",
      eligible,
      `${Math.round((eligible / data.workers.length) * 100)}% of your workforce`,
      "check",
      "green",
    ],
    [
      "Needs attention",
      data.workers.length - eligible,
      "Review eligibility blockers",
      "spark",
      "amber",
    ],
    [
      "Open tasks",
      data.tasks.filter((task) => task.status === "Open").length,
      "Linked to your workers",
      "tasks",
      "",
    ],
  ];
  return `<div class="stats">${cards.map(([label, value, caption, symbol, color]) => `<div class="stat"><div class="stat-label">${label}${icon(String(symbol), 15)}</div><div class="stat-value ${color}">${value}<span class="stat-symbol">${icon(String(symbol), 25)}</span></div><div class="stat-caption">${caption}</div></div>`).join("")}</div>`;
}
function workerTable() {
  const rows = visibleWorkers();
  return `<div class="table-scroll"><table><thead><tr><th class="row-number">#</th><th>${icon("people", 13)} Worker</th><th>${icon("link", 13)} Employer</th><th>State</th><th>Status</th><th>I-9 verification</th><th class="derived">ƒ Eligibility</th><th class="derived">ƒ Tasks</th></tr></thead><tbody>${rows.map((worker, index) => `<tr class="${worker.id === selected ? "selected" : ""}"><td class="row-number">${String(index + 1).padStart(2, "0")}</td><td><button class="person-cell" data-action="select:${worker.id}"><span class="avatar tone-${index % 5}">${initials(worker.name)}</span><span><strong>${esc(worker.name)}</strong>${showRole ? `<small>${esc(worker.role)}</small>` : ""}</span></button></td><td><button class="org-cell" data-action="org:${worker.employer}">${orgBadge(worker)}</button></td><td>${btn(`edit:${worker.id}:state`, esc(worker.state), "", "editable", 'aria-label="Edit state for ' + esc(worker.name) + '"')}</td><td>${btn(`edit:${worker.id}:status`, pill(worker.status, worker.status === "Active" ? "green" : "neutral"), "", "cell-button")}</td><td>${btn(`edit:${worker.id}:i9`, `<span class="verification ${worker.i9 === "Complete" ? "complete" : worker.i9 === "Missing" ? "missing" : "review"}">${icon(worker.i9 === "Complete" ? "check" : worker.i9 === "Missing" ? "close" : "clock", 13)}${esc(worker.i9)}</span>`, "", "cell-button")}</td><td class="derived-cell">${btn(`select:${worker.id}`, eligiblePill(worker.eligible), "", "cell-button", 'aria-label="Explain eligibility for ' + esc(worker.name) + '"')}</td><td class="derived-cell">${btn(`tasks:${worker.id}`, String(worker.tasks).padStart(2, "0"), "", `task-count ${worker.tasks ? "has-tasks" : ""}`)}</td></tr>`).join("")}</tbody></table>${rows.length ? "" : `<div class="empty">${icon("search", 30)}<h3>No workers found</h3><p>Try a different search or clear your filter.</p>${btn("reset", "Clear search & filters", "", "button")}</div>`}</div><div class="table-footer"><span>${rows.length} of ${data.workers.length} workers</span><span><span class="formula-key">ƒ</span> Derived from your graph ${icon("info", 13)}</span></div>`;
}
function graph() {
  const rows = visibleWorkers();
  return `<div class="graph-view"><div class="graph-caption">${icon("graph")} Workforce relationships <span>Click a worker to inspect</span></div><div class="graph-columns">${organizations
    .map(
      (org) =>
        `<div class="graph-cluster"><div class="graph-org"><span class="org-mark ${org.color}">${org.name[0]}</span><strong>${org.name}</strong><small>Organization</small></div><div class="graph-branches">${rows
          .filter((worker) => worker.employer === org.id)
          .map(
            (worker) =>
              `<button class="graph-node ${worker.id === selected ? "node-selected" : ""}" data-action="select:${worker.id}"><span class="avatar">${initials(worker.name)}</span><span>${esc(worker.name)}<small>${esc(worker.role)}</small></span><span class="node-dot ${worker.eligible ? "green" : "amber"}"></span></button>`,
          )
          .join("")}</div></div>`,
    )
    .join(
      "",
    )}</div><div class="graph-legend"><span class="live-dot"></span>Eligible <span class="live-dot amber-bg"></span>Needs attention <span>Lines represent employer references stored in Triplex</span></div></div>`;
}
function board() {
  return `<div class="board">${["Complete", "In review", "Missing"]
    .map((status) => {
      const workers = visibleWorkers().filter((worker) => worker.i9 === status);
      return `<section class="board-column"><h3>${pill(status, status === "Complete" ? "green" : "amber")}<span>${workers.length}</span></h3>${workers.map((worker) => `<button class="board-card" data-action="select:${worker.id}"><span class="avatar">${initials(worker.name)}</span><strong>${esc(worker.name)}</strong><small>${esc(orgFor(worker).name)} · ${worker.state}</small><div>${eligiblePill(worker.eligible)}<span>${worker.tasks} tasks</span></div></button>`).join("") || '<p class="muted">No workers in this stage.</p>'}</section>`;
    })
    .join("")}</div>`;
}
function inspector() {
  const worker = data.workers.find((row) => row.id === selected);
  if (!worker) return "";
  const candidate = data.evaluation.candidates.find(
    (item) => item.identity["?worker"] === worker.id,
  );
  const checks = [
    ["Employment is active", worker.status === "Active", ":worker/status", worker.status],
    ["I-9 verification is complete", worker.i9 === "Complete", ":worker/i9", worker.i9],
    [
      "No blocking violations",
      !worker.blocked,
      ":worker/blocked",
      worker.blocked ? "Blocking violation" : "None",
    ],
  ] as const;
  return `<aside class="inspector"><div class="inspector-heading"><span>${icon("spark")} OBJECT INSPECTOR</span>${btn("close-inspector", "", "close", "icon-button", 'aria-label="Close inspector"')}</div><div class="inspector-person"><span class="avatar large">${initials(worker.name)}</span><h2>${esc(worker.name)}</h2><p>${esc(worker.role)}</p><span class="object-id">${esc(worker.id)} ${icon("link", 11)}</span></div><div class="inspector-tabs">${btn("inspect:explanation", "Explanation", "", inspectorTab === "explanation" ? "active" : "")}${btn("inspect:history", "History", "", inspectorTab === "history" ? "active" : "")}${btn("inspect:facts", "Facts", "", inspectorTab === "facts" ? "active" : "")}</div>${
    inspectorTab === "explanation"
      ? `<div class="inspector-content"><div class="result-card ${worker.eligible ? "result-good" : "result-bad"}"><div>ƒ Eligibility ${eligiblePill(worker.eligible)}</div><p>${worker.eligible ? "All eligibility requirements are met." : "This worker has unmet requirements."}</p></div><div class="section-label">WHY THIS RESULT?</div><div class="proof-tree">${checks.map(([label, pass, attr, value]) => `<div class="proof-step ${pass ? "pass" : "fail"}"><span class="proof-icon">${icon(pass ? "check" : "close", 12)}</span><strong>${label}</strong><div class="proof-fact"><code>${attr}</code><span>${esc(value)}</span></div></div>`).join("")}</div><div class="rule-note">${icon("code", 15)}<div><strong>Worker eligibility <span>v1</span></strong><p>Datalog derivation · ${candidate ? candidate.sources.length + " source facts" : "Source checks shown above"}</p></div></div><dl class="metadata"><dt>Evaluated at</dt><dd>${new Date(data.basis.validAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</dd><dt>Rule definition</dt><dd title="${esc(data.definition.id)}">${data.definition.id.slice(0, 19)}…</dd><dt>Temporal basis</dt><dd>Current snapshot</dd></dl><div class="what-if"><span class="what-if-icon">${icon("spark", 19)}</span><h3>What if things changed?</h3><p>Try a change and see its impact before applying it.</p>${btn(`edit:${worker.id}:i9`, "Preview a change", "arrow", "button full")}</div></div>`
      : inspectorTab === "facts"
        ? `<div class="inspector-content"><div class="section-label">STORED SOURCE FACTS</div>${worker.facts.map((fact) => `<div class="fact-item"><code>${esc(fact.attribute)}</code><strong>${esc(textValue(fact))}</strong><small title="${fact.id}">${fact.id}</small></div>`).join("")}</div>`
        : `<div class="inspector-content"><div class="section-label">CAUSAL TRANSACTION HISTORY</div>${data.journal
            .filter((tx) => tx.changes.some((change) => change.entityId === worker.id))
            .map(
              (tx) =>
                `<div class="history-item">${icon("clock")}<strong>${tx.actor === "workbench/demo" ? "Worker added to workspace" : "Worker updated"}</strong><p>${new Date(tx.instant).toLocaleString()}</p><small>${esc(tx.actor)}</small>${tx.changes
                  .filter((change) => change.entityId === worker.id)
                  .map(
                    (change) =>
                      `<div class="history-change">${change.op === "assert" ? "+" : "−"} ${esc(change.attribute.replace(":worker/", ""))}: ${esc(change.value?.value)}</div>`,
                  )
                  .join("")}</div>`,
            )
            .join("")}</div>`
  }</aside>`;
}
function workersPage() {
  return `${heading("Workers", "Your workforce, connected. Explore objects, understand decisions, and act with context.", "people", btn("export", "Export", "download", "button") + btn("create", "Add worker", "plus", "button primary"))}${stats()}<section class="work-area"><div class="view-bar"><div class="view-tabs">${[
    ["table", "Table", "grid"],
    ["board", "Board", "board"],
    ["graph", "Graph", "graph"],
  ]
    .map(([id, label, symbol]) => btn(`view:${id}`, label!, symbol, view === id ? "active" : ""))
    .join(
      "",
    )}</div><span class="view-caption"><span class="live-dot"></span>Live view</span></div><div class="sheet-layout"><div class="sheet"><div class="toolbar"><label class="search">${icon("search", 15)}<input id="worker-search" placeholder="Search workers…" value="${esc(query)}" aria-label="Search workers"/><kbd>/</kbd></label><div class="tools"><label class="filter-control">${icon("filter")}<select id="filter" aria-label="Filter workers"><option value="all" ${filter === "all" ? "selected" : ""}>Filter</option><option value="attention" ${filter === "attention" ? "selected" : ""}>Needs attention</option><option value="eligible" ${filter === "eligible" ? "selected" : ""}>Eligible</option></select></label>${btn("sort", "Sort", "sort", sort ? "tool-active" : "", `aria-pressed="${sort}"`)}${btn("columns", "Roles", "columns", showRole ? "" : "tool-active", `aria-pressed="${showRole}"`)}</div></div>${view === "table" ? workerTable() : view === "graph" ? graph() : board()}</div>${inspector()}</div></section><div class="workspace-hint">${icon("info", 14)} Click an eligibility cell to see why. Click a state or verification value to preview a change.<span>POWERED BY <strong>triplex</strong></span></div>`;
}
function otherPage() {
  if (page === "organizations")
    return `${heading("Organizations", "The organizations connected to your workforce.", "building")}<div class="organization-cards">${organizations
      .map((org) => {
        const workers = data.workers.filter((worker) => worker.employer === org.id);
        return `<article class="organization-card"><span class="org-mark ${org.color}">${org.name[0]}</span><h2>${org.name}</h2><p>${org.sector}</p><div><strong>${workers.length}</strong> workers <span>·</span> ${workers.filter((worker) => worker.eligible).length} eligible</div>${btn(`org:${org.id}`, "Explore workers", "arrow", "button")}</article>`;
      })
      .join("")}</div>`;
  if (page === "ontology")
    return `${heading("Ontology", "Objects and relationships that describe your operational world.", "graph")}${graph()}`;
  if (page === "rules")
    return `${heading("Rules & derivations", "Understand the logic behind every derived eligibility result.", "code")}<article class="rule-page"><div>${pill("Live", "green")}<span class="muted"> workforce-v1</span></div><h2>Worker eligibility</h2><p>A worker is eligible when their employment is active, their I-9 is complete, and they have no blocking violations.</p><pre><code>${esc(JSON.stringify(data.definition.query, null, 2))}</code></pre><dl class="metadata"><dt>Definition</dt><dd>${esc(data.definition.id)}</dd><dt>Config release</dt><dd>${esc(data.release)}</dd><dt>Current candidates</dt><dd>${data.evaluation.candidates.length} eligible workers</dd></dl>${btn("page:workers", "Explore results", "arrow", "button")}</article>`;
  if (page === "tasks") {
    const tasks = data.tasks.filter((task) => !query || task.worker === query);
    return `${heading("Tasks", "Open work linked to the people it belongs to. Demo tasks are managed independently of eligibility.", "tasks", query ? btn("all-tasks", "Show all tasks", "", "button") : "")}<div class="task-list">${
      tasks
        .map((task) => {
          const worker = data.workers.find((row) => row.id === task.worker)!;
          return `<article>${icon("tasks", 22)}<div><h3>${esc(task.title)}</h3><p>${esc(worker.name)} · ${esc(orgFor(worker).name)}</p></div>${pill(task.status, "amber")}${btn(`worker:${worker.id}`, "View worker", "arrow", "button")}</article>`;
        })
        .join("") ||
      '<div class="empty"><h3>No open tasks</h3><p>This worker has no linked tasks.</p></div>'
    }</div>`;
  }
  return `${heading("Activity", "An attributed, atomic history of changes to your workspace.", "clock")}<div class="activity-list">${data.journal
    .filter((tx) => tx.actor?.startsWith("workbench/"))
    .map(
      (tx) =>
        `<article><span class="activity-icon">${icon("clock", 20)}</span><div><h3>${tx.actor === "workbench/demo" ? "Demo workforce imported" : tx.commandId?.includes("create") ? "Worker created" : "Worker facts updated"}</h3><p>${esc(tx.actor)} · ${new Date(tx.instant).toLocaleString()}</p><code>${esc(tx.txId)}</code><details><summary>${tx.changes.length} fact changes · position ${tx.position}</summary>${tx.changes.map((change) => `<div class="history-change">${change.op === "assert" ? "+" : "−"} ${esc(change.entityId)} ${esc(change.attribute)} = ${esc(change.value?.value)}</div>`).join("")}</details></div>${pill("Committed", "green")}</article>`,
    )
    .join("")}</div>`;
}
let editField: EditableField = "i9";
let editValue = "Missing";
let createDraft = { name: "", role: "", employer: "org:acme", state: "CA" };
function dialog() {
  if (!modal) return "";
  const worker = data.workers.find((row) => row.id === selected)!;
  const selectOptions = (items: readonly string[], current: string) =>
    items
      .map((item) => `<option ${item === current ? "selected" : ""}>${esc(item)}</option>`)
      .join("");
  const body =
    modal === "help"
      ? `<div class="dialog-icon">${icon("spark", 26)}</div><h2 id="dialog-title">A spreadsheet with context.</h2><p>Workbench connects the table you work in to the world it describes.</p><div class="help-steps"><p><b>01 · Explore your workforce</b>Search, filter, and switch between table, board, and graph views.</p><p><b>02 · Follow the reasoning</b>Click an eligibility cell to inspect its rule and source facts.</p><p><b>03 · Try a change</b>Edit a state, status, or I-9 value. Review the hypothetical result, then apply it as one attributed transaction.</p></div><div class="demo-note">This demo runs in your browser. Reloading resets the data. It is not connected to a production workforce system.</div>${btn("dismiss", "Start exploring", "arrow", "button primary full")}`
      : modal === "create"
        ? `<h2 id="dialog-title">Add a worker</h2><p>Create a new object in your workforce graph.</p><form id="create-form"><label>Full name<input id="new-name" name="name" value="${esc(createDraft.name)}" required maxlength="100" placeholder="e.g. Alex Morgan"/></label><label>Role<input id="new-role" name="role" value="${esc(createDraft.role)}" required maxlength="100" placeholder="e.g. Operations specialist"/></label><label>Organization<select id="new-employer" name="employer">${organizations.map((org) => `<option value="${org.id}" ${org.id === createDraft.employer ? "selected" : ""}>${org.name}</option>`).join("")}</select></label><label>State<select id="new-state" name="state">${selectOptions(fieldOptions.state, createDraft.state)}</select></label><div class="demo-note">New workers start active with a missing I-9. You can preview verification changes from the table.</div><div class="dialog-actions">${btn("dismiss", "Cancel", "", "button")}<button class="button primary" ${busy ? "disabled" : ""}>${busy ? "Adding…" : "Add worker"}</button></div></form>`
        : `<div class="dialog-icon">${icon("spark", 24)}</div><div class="eyebrow">HYPOTHETICAL OVERLAY</div><h2 id="dialog-title">Preview a change</h2><p>See what changes for <strong>${esc(worker.name)}</strong> before applying.</p><form id="preview-form"><div class="edit-fields"><label>Attribute<select name="field" id="edit-field">${(["i9", "state", "status"] as const).map((field) => `<option value="${field}" ${editField === field ? "selected" : ""}>${field === "i9" ? "I-9 verification" : field === "state" ? "State" : "Employment status"}</option>`).join("")}</select></label><label>Proposed value<select id="edit-value" name="value">${selectOptions(fieldOptions[editField], preview?.value ?? editValue)}</select></label></div>${preview ? `<div class="preview-result"><div class="section-label">PROPOSED CHANGE</div><p>${esc(textValue(preview.previous))} ${icon("arrow")} <strong>${esc(preview.value)}</strong></p><div class="section-label">ELIGIBILITY IMPACT</div><p>${eligiblePill(worker.eligible)} ${icon("arrow")} ${eligiblePill(preview.eligible)}</p><small>${worker.eligible === preview.eligible ? "Eligibility is unchanged by this edit." : preview.eligible ? "This worker would become eligible to work." : "This worker would no longer be eligible to work."}</small></div><div class="demo-note">Evaluated against a pinned snapshot. Applying records the old and new facts in one transaction. Linked demo tasks remain independently managed.</div>` : '<div class="demo-note">Your proposed edit is evaluated without changing any stored facts.</div>'}<div class="dialog-actions">${btn("dismiss", "Cancel", "", "button")}${preview ? btn("apply", busy ? "Applying…" : "Apply change", "check", "button primary", busy ? "disabled" : "") : `<button class="button primary" ${busy ? "disabled" : ""}>${busy ? "Evaluating…" : "Preview impact"}${icon("arrow")}</button>`}</div></form>`;
  return `<div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">${btn("dismiss", "", "close", "icon-button dialog-close", 'aria-label="Close dialog"')}${body}${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}</section></div>`;
}
function render() {
  if (!data) return;
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const selection = active?.tagName === "INPUT" ? active.selectionStart : null;
  app.innerHTML = `${sidebar()}<div class="main-shell">${header()}<main>${page === "workers" ? workersPage() : otherPage()}</main><footer class="statusbar"><span><span class="live-dot"></span> All changes committed locally</span><span>${data.workers.length + organizations.length + data.tasks.length} objects<span class="status-divider">/</span>${data.release.slice(0, 19)}…<span class="status-divider">/</span>Triplex engine</span></footer></div>${dialog()}${toast ? `<div class="toast" role="status">${icon("check")}${esc(toast)}</div>` : ""}${error && !modal ? `<div class="error floating-error" role="alert">${esc(error)}${btn("clear-error", "Dismiss")}</div>` : ""}`;
  if (focusId) {
    const input = document.getElementById(focusId) as HTMLInputElement | null;
    input?.focus();
    if (selection !== null && input?.tagName === "INPUT")
      input.setSelectionRange(selection, selection);
  }
}
function openModal(kind: typeof modal) {
  returnFocus = document.activeElement as HTMLElement;
  modal = kind;
  preview = null;
  error = "";
  render();
  app.querySelector<HTMLElement>(".dialog input, .dialog select, .dialog .button")?.focus();
}
function closeModal() {
  modal = null;
  preview = null;
  error = "";
  render();
  const action = returnFocus?.dataset["action"];
  if (action)
    [...app.querySelectorAll<HTMLElement>("[data-action]")]
      .find((node) => node.dataset["action"] === action)
      ?.focus();
}
app.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  const action = button?.dataset["action"];
  if (!action || busy) return;
  if (action.startsWith("page:")) {
    page = action.slice(5);
    query = "";
  } else if (action.startsWith("view:")) view = action.slice(5);
  else if (action.startsWith("select:")) {
    selected = action.slice(7);
    if (page === "ontology") {
      page = "workers";
      view = "graph";
      query = "";
      filter = "all";
    }
    inspectorTab = "explanation";
  } else if (action.startsWith("worker:")) {
    selected = action.slice(7);
    page = "workers";
    query = "";
  } else if (action.startsWith("inspect:")) inspectorTab = action.slice(8);
  else if (action.startsWith("tasks:")) {
    page = "tasks";
    query = action.slice(6);
  } else if (action.startsWith("org:")) {
    page = "workers";
    query = organizations.find((org) => org.id === action.slice(4))!.name;
    filter = "all";
  } else if (action.startsWith("edit:")) {
    const parts = action.slice(5).split(":");
    editField = parts.pop() as EditableField;
    selected = parts.join(":");
    editValue = data.workers.find((worker) => worker.id === selected)![editField];
    openModal("edit");
    return;
  } else if (action === "create" || action === "help") {
    if (action === "create")
      createDraft = { name: "", role: "", employer: "org:acme", state: "CA" };
    openModal(action);
    return;
  } else if (action === "dismiss") {
    closeModal();
    return;
  } else if (action === "sort") sort = !sort;
  else if (action === "columns") showRole = !showRole;
  else if (action === "close-inspector") selected = "";
  else if (action === "reset") {
    query = "";
    filter = "all";
  } else if (action === "all-tasks") query = "";
  else if (action === "clear-error") error = "";
  else if (action === "apply" && preview) {
    const change = preview;
    void run(async () => {
      await runtime.runPromise(applyChange(change));
      await refresh();
      modal = null;
      preview = null;
      notice(`Updated ${change.worker.name}. Change recorded in Activity.`);
    });
    return;
  } else if (action === "export") {
    const cell = (value: string) => `"${value.replaceAll('"', '""').replace(/^[=+@-]/, "'$&")}"`;
    const csv = [
      ["Worker", "Role", "Employer", "State", "Status", "I-9", "Eligible", "Open tasks"],
      ...visibleWorkers().map((worker) => [
        worker.name,
        worker.role,
        orgFor(worker).name,
        worker.state,
        worker.status,
        worker.i9,
        String(worker.eligible),
        String(worker.tasks),
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "workbench-workers.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice("Exported the current worker view.");
  }
  render();
});
app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "worker-search") {
    query = target.value;
    render();
  } else if (target.closest("#create-form")) {
    createDraft = { ...createDraft, [target.name]: target.value };
  }
});
app.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "filter") {
    filter = target.value;
    render();
  } else if (target.id === "edit-field") {
    editField = target.value as EditableField;
    editValue = data.workers.find((worker) => worker.id === selected)![editField];
    preview = null;
    render();
  } else if (target.closest("#preview-form")) {
    editValue = target.value;
    preview = null;
    render();
  } else if (target.closest("#create-form")) {
    createDraft = { ...createDraft, [target.name]: target.value };
  }
});
app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const values = new FormData(form);
  if (form.id === "create-form")
    void run(async () => {
      selected = await runtime.runPromise(
        createWorker(
          String(values.get("name")),
          String(values.get("role")),
          String(values.get("employer")),
          String(values.get("state")),
        ),
      );
      await refresh();
      modal = null;
      query = "";
      filter = "all";
      notice("Worker added to the graph.");
    });
  else if (form.id === "preview-form")
    void run(async () => {
      const worker = data.workers.find((row) => row.id === selected)!;
      const value = String(values.get("value"));
      if (worker[editField] === value)
        throw new Error("Choose a different value to preview a change.");
      preview = await runtime.runPromise(previewChange(data, worker, editField, value));
    });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modal && !busy) closeModal();
  if (
    event.key === "/" &&
    !modal &&
    !(event.target instanceof HTMLInputElement) &&
    !(event.target instanceof HTMLSelectElement)
  ) {
    event.preventDefault();
    document.getElementById("worker-search")?.focus();
  }
  if (event.key === "Tab" && modal) {
    const nodes = [
      ...app.querySelectorAll<HTMLElement>(
        ".dialog button:not(:disabled), .dialog input, .dialog select",
      ),
    ];
    const first = nodes[0];
    const last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
window.addEventListener("pagehide", () => {
  void runtime.dispose();
});
void (async () => {
  try {
    await runtime.runPromise(initialize);
    await refresh();
    render();
  } catch (cause) {
    app.innerHTML = `<div class="startup-error"><h1>Workbench couldn’t start</h1><p>${esc(cause)}</p><button onclick="location.reload()">Try again</button></div>`;
  }
})();
