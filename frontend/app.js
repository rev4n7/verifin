/* Verbil front end — plain JS, no build step */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (x) => (x == null ? "—" : "₹" + Number(x).toLocaleString("en-IN", { maximumFractionDigits: 0 }));
const short = (h, n = 10) => (h ? (String(h).startsWith("0x") ? h : "0x" + h).slice(0, n + 2) + "…" : "—");
const STATUS = { AUTO_APPROVED: "Auto-approved", APPROVED: "Approved", MANUAL_REVIEW: "Manual review", REJECTED: "Rejected", FUNDED: "Funded", REPAID: "Repaid", SUBMITTED: "Submitted", DISPUTED: "Disputed by buyer" };
const pill = (s, label) => `<span class="pill s-${esc(s)}">${esc(label || STATUS[s] || s)}</span>`;
const ICON = { pass: "✓", warn: "!", fail: "✕" };
function ring(value, tone, big, small, size = 128) {
  const r = 50, c = +(2 * Math.PI * r).toFixed(1), id = "rg" + Math.random().toString(36).slice(2, 8);
  const [a, b] = { good: ["#30d158", "#00c7be"], warn: ["#ff9f0a", "#ffd60a"], bad: ["#ff375f", "#ff3b30"] }[tone];
  const v = Math.max(0, Math.min(100, value));
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 120 120"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><circle cx="60" cy="60" r="${r}" class="ring-track"/><circle cx="60" cy="60" r="${r}" class="ring-prog" stroke="url(#${id})" style="--c:${c};stroke-dasharray:${c};stroke-dashoffset:${(c * (1 - v / 100)).toFixed(1)}" transform="rotate(-90 60 60)"/></svg><div class="ring-label"><b>${big}</b><span>${small}</span></div></div>`;
}

const state = { meta: null, lender: "", selected: null, tab: "verify", lastRuns: {}, persona: null, view: "home", labLender: "lender_a" };

/* ---------------- workspaces (personas) ---------------- */
const PERSONAS = [
  { key: "lender_a", type: "lender", name: "Shakti Bank", role: "Lender · Credit desk", lender_id: "lender_a", initials: "SB", color: "#4aa8ff" },
  { key: "lender_b", type: "lender", name: "Kaveri Capital", role: "Lender · NBFC", lender_id: "lender_b", initials: "KC", color: "#9a9bff" },
  { key: "acme", type: "business", name: "Acme Precision Parts", role: "Business · Supplier", gstin: "27AAACA1234F1Z5", initials: "AP", color: "#3fe0d0" },
  { key: "zenith", type: "buyer", name: "Zenith Motors", role: "Buyer · Accounts payable", gstin: "29AABCZ5678K1Z2", initials: "ZM", color: "#ffb547" },
  { key: "orbit", type: "buyer", name: "Orbit Retail", role: "Buyer · Accounts payable", gstin: "07AACCO4321M1Z8", initials: "OR", color: "#ff8a8a" },
  { key: "public", type: "public", name: "Independent verifier", role: "Auditor · no account", initials: "✓", color: "#93a6c6" },
];
const NAV = {
  lender: [["dash", "Dashboard"], ["desk", "Applications"], ["audit", "Audit"]],
  business: [["biz", "My invoices"], ["sme", "Get paid early"]],
  buyer: [["buyer", "Confirmations"]],
  public: [["verify", "Verify"]],
};
const HOME_VIEW = { lender: "dash", business: "biz", buyer: "buyer", public: "verify" };
const avatar = (p, size = 28) => `<span class="avatar" style="--c:${p.color};width:${size}px;height:${size}px">${esc(p.initials)}</span>`;

function renderWorkspace() {
  const p = state.persona;
  $("#ws-btn").innerHTML = `${avatar(p)}<span class="ws-name"><b>${esc(p.name)}</b><small>${esc(p.role)}</small></span><svg class="chev" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>`;
  const groups = [["Lenders", "lender"], ["Businesses", "business"], ["Buyers", "buyer"], ["Public", "public"]];
  $("#ws-menu").innerHTML = groups.map(([g, t]) => `<div class="ws-group">${g}</div>` + PERSONAS.filter((x) => x.type === t).map((x) =>
    `<button class="ws-item ${x.key === p.key ? "on" : ""}" data-p="${x.key}">${avatar(x, 30)}<span><b>${esc(x.name)}</b><small>${esc(x.role)}</small></span>${x.key === p.key ? '<span class="ws-check">✓</span>' : ""}</button>`).join("")).join("");
  $$("#ws-menu .ws-item").forEach((b) => (b.onclick = () => { $("#ws-menu").hidden = true; setPersona(b.dataset.p); }));
  $("#nav").innerHTML = NAV[p.type].map(([v, n]) => `<button data-view="${v}" class="${state.view === v ? "on" : ""}">${n}</button>`).join("");
  $$("#nav button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
}
function setPersona(key, view) {
  state.persona = PERSONAS.find((x) => x.key === key) || PERSONAS[0];
  try { localStorage.setItem("vf-persona", state.persona.key); } catch (e) { /* storage unavailable */ }
  state.selected = null;
  renderWorkspace();
  if (view !== false) show(view || HOME_VIEW[state.persona.type]);
}
$("#ws-btn").onclick = (e) => { e.stopPropagation(); const m = $("#ws-menu"); m.hidden = !m.hidden; $("#ws-btn").setAttribute("aria-expanded", String(!m.hidden)); };
document.addEventListener("click", (e) => { if (!e.target.closest(".ws")) $("#ws-menu").hidden = true; });

/* presenter drawer */
const drawer = (open) => { $("#drawer").hidden = !open; if (open) loadMeta(); };
$("#fab").onclick = () => drawer($("#drawer").hidden);
$("#drawer-x").onclick = () => drawer(false);
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,select,textarea")) return;
  if (e.key === "p" || e.key === "P") drawer($("#drawer").hidden);
  if (e.key === "Escape") { drawer(false); $("#modal").hidden = true; $("#ws-menu").hidden = true; }
});

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `Request failed (${r.status})`);
  return body;
}
const post = (p, data) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}
function modal(html) {
  $("#modal-body").innerHTML = html;
  $("#modal").hidden = false;
}
$("#modal-x").onclick = () => ($("#modal").hidden = true);
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };

async function busy(btn, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> Working…`;
  try { return await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.innerHTML = old; }
}

/* ---------------- navigation ---------------- */
function show(view) {
  state.view = view;
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  window.scrollTo({ top: 0 });
  const go = { desk: loadList, audit: loadAudit, dash: loadDash, biz: loadBiz, buyer: loadBuyer, home: loadMeta, sme: loadMeta };
  if (go[view]) go[view]().catch((e) => toast(e.message));
}

/* ---------------- meta / command center ---------------- */
async function loadMeta() {
  const m = (state.meta = await api("/api/meta"));
  const c = m.chain;
  $("#chips").innerHTML = `<span class="chip" title="Consortium ledger · block ${c.block ?? "?"} · InvoiceRegistry ${esc(c.contract || "")}"><span class="dot ${c.mode === "hardhat" ? "" : "off"}"></span>${c.mode === "hardhat" ? "Ledger synced" : "Ledger offline"}</span>`;

  $("#lab-lender").innerHTML = m.lenders.map((l) => `<button data-ll="${l.id}" class="${state.labLender === l.id ? "on" : ""}">${esc(l.name)}</button>`).join("");
  $$("#lab-lender button").forEach((b) => (b.onclick = () => { state.labLender = b.dataset.ll; loadMeta(); }));
  const lenderName = (id) => m.lenders.find((l) => l.id === id)?.name || id;
  $("#lab").innerHTML = Object.entries(m.scenarios).map(([key, sc], i) => {
    const lender = m.lenders.find((l) => l.id === sc.lender);
    const run = state.lastRuns[key];
    return `<article class="lab-card ${sc.attack ? "is-attack" : "is-genuine"}">
      <div class="lab-top"><span class="num">${String(i + 1).padStart(2, "0")}</span><span class="tag ${sc.attack ? "bad" : "ok"}">${esc(sc.attack || "Genuine")}</span></div>
      <h3>${esc(sc.title)}</h3>
      <p>${esc(sc.story)}</p>
      <p class="expect"><span>Expected</span>${esc(sc.expect)}</p>
      ${run ? `<div class="result">${pill(run.status)} <b>Score ${run.risk?.score ?? "—"}</b> · ${esc(firstReason(run))}<br><a data-open="${run.id}">Open application #${run.id} →</a>
        ${["AUTO_APPROVED", "APPROVED"].includes(run.status) ? `<div style="margin-top:10px"><button class="btn chain" data-disburse="${run.id}" data-key="${key}">Disburse &amp; register on-chain</button></div>` : ""}</div>` : ""}
      <button class="btn ${run ? "secondary" : "primary"}" data-run="${key}">${run ? "Run again" : sc.requires ? (key === "02_double_pledge" ? "Submit to the other lender" : "Submit to 01's lender") : "Submit to " + esc(lenderName(state.labLender))}</button>
    </article>`;
  }).join("");
  $$("[data-run]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const q = m.scenarios[b.dataset.run].requires ? "" : `?lender_id=${state.labLender}`;
    const d = await post(`/api/scenarios/${b.dataset.run}/run${q}`);
    state.lastRuns[b.dataset.run] = d;
    if (d.prep?.length) toast(d.prep[0]);
    await loadMeta();
  })));
  $$("[data-open]").forEach((a) => (a.onclick = () => openApp(+a.dataset.open)));
  $$("[data-disburse]").forEach((b) => (b.onclick = () => busy(b, async () => {
    state.lastRuns[b.dataset.key] = await post(`/api/applications/${b.dataset.disburse}/disburse`);
    toast("Funded. The invoice fingerprint is now in the on-chain registry, so every other lender is blocked.");
    await loadMeta();
  })));
  $("#sme-lender").innerHTML = m.lenders.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  $("#sample-links").innerHTML = Object.entries(m.scenarios).map(([k, sc]) =>
    `<div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line)"><span>${esc(sc.title)}</span><span class="row">${["invoice", "po", "grn", "bank", "soa"].filter((d) => d !== "bank" && d !== "soa" || ["01_clean", "06_already_paid"].includes(k)).map((d) => `<a class="mono" href="/api/samples/${k}/${d}">${d}</a>`).join(" ")}</span></div>`).join("");
}

function firstReason(d) {
  if (d.status === "FUNDED") return `Funded ${inr(d.risk?.offer?.net_disbursal)} · fingerprint registered on-chain`;
  if (d.risk?.hard_stops?.length) return d.risk.hard_stops[0];
  const f = (d.checks || []).find((c) => c.status === "fail");
  if (f) return f.title + ": " + f.detail;
  if (d.status === "MANUAL_REVIEW") return "Needs a credit officer: " + (d.risk.factors.filter((x) => x.points < 0).map((x) => x.label).join(", ") || "borderline score");
  return d.risk?.offer ? `${Math.round(d.risk.offer.advance_rate * 100)}% advance offered (${inr(d.risk.offer.advance)})` : "";
}

$("#reset").onclick = (e) => busy(e.currentTarget, async () => {
  await post("/api/demo/reset");
  state.lastRuns = {};
  state.selected = null;
  $("#rt-result").innerHTML = "";
  toast("Data reset: fresh database and a newly deployed contract");
  await loadMeta();
  show(state.view);
});

/* red team */
$$("[data-rt]").forEach((b) => (b.onclick = () => busy(b, async () => {
  const a = b.dataset.rt;
  if (a === "verify") return renderVerify(await api("/api/audit/verify"), $("#rt-result"));
  if (a === "restore") { const r = await post("/api/redteam/restore"); toast(`Restored ${r.restored.length} item(s)`); return renderVerify(await api("/api/audit/verify"), $("#rt-result")); }
  const r = await post(`/api/redteam/${a}`);
  $("#rt-result").innerHTML = `<div class="result">${a === "tamper-document"
    ? `Insider modified stored file <b>${esc(r.filename)}</b> (application #${r.app_id}). The file still decrypts and opens normally.`
    : `Insider rewrote audit event <b>#${r.tampered_event}</b> → decision <b>${esc(r.new_payload.decision)}</b>, advance ${inr(r.new_payload.advance)}. Nothing looks wrong in the database.`} Now click <b>Verify now</b>.</div>`;
})));

/* ---------------- lender desk ---------------- */
async function loadList() {
  const m = state.meta || (await loadMeta(), state.meta);
  const lid = state.persona?.lender_id;
  const apps = await api("/api/applications" + (lid ? `?lender_id=${lid}` : ""));
  $("#list-count").textContent = `${apps.length} total`;
  $("#app-list").innerHTML = apps.length ? apps.map((a) => `
    <button class="item ${state.selected === a.id ? "sel" : ""}" data-id="${a.id}">
      <span class="inv">#${a.id} · ${esc(a.invoice_no || "unreadable")}</span>${pill(a.status)}
      <span class="sub">${esc(a.seller_name || "?")} → ${esc(a.buyer_name || "?")}</span>
      <span class="sub">${esc(a.invoice_date || "")}${a.ms ? ` · decided in ${(a.ms / 1000).toFixed(1)} s` : ""}</span>
      <span class="amt">${inr(a.amount)}</span><span class="mono">${a.score != null ? "score " + a.score : ""}</span>
    </button>`).join("") : `<div class="empty"><b>No applications yet</b>New requests from businesses appear here, already verified.</div>`;
  $$("#app-list .item").forEach((b) => (b.onclick = () => openApp(+b.dataset.id)));
}

async function openApp(id) {
  const d = await api(`/api/applications/${id}`);
  drawer(false);
  if (state.persona?.lender_id !== d.lender_id) setPersona(d.lender_id, false);
  state.selected = id;
  if ($("#view-desk").hidden) show("desk");
  else loadList();
  state.tab = d.dup?.verdict === "duplicate" ? "dup" : (d.checks || []).some((c) => c.status === "fail") ? "verify" : "pack";
  renderDetail(d);
}

function renderDetail(d) {
  const r = d.risk || {};
  const score = r.score ?? 0;
  const blocked = (r.hard_stops || []).length > 0;
  const g = blocked ? "var(--bad)" : score >= 75 ? "var(--accent)" : score >= 50 ? "var(--warn)" : "var(--bad)";
  const o = r.offer;
  const fails = (d.checks || []).filter((c) => c.status === "fail").length;
  const warns = (d.checks || []).filter((c) => c.status === "warn").length;
  const actions = [];
  if (d.status === "MANUAL_REVIEW") actions.push(`<button class="btn primary" data-act="approve">Approve</button>`, `<button class="btn danger" data-act="reject">Reject</button>`);
  if (["AUTO_APPROVED", "APPROVED"].includes(d.status)) actions.push(`<button class="btn chain" data-act="disburse">Disburse &amp; register on-chain</button>`, `<button class="btn danger" data-act="reject">Reject</button>`);
  if (d.status === "FUNDED") actions.push(`<button class="btn" data-act="repay">Buyer paid → release on-chain</button>`);
  const requested = d.events.some((e) => e.type === "BUYER_CONFIRMATION_REQUESTED");
  if (d.fingerprint && !d.onchain?.confirmed && !["REJECTED", "REPAID", "DISPUTED"].includes(d.status))
    actions.push(requested ? `<span class="tag warn">Awaiting ${esc(d.buyer_name)}'s confirmation</span>` : `<button class="btn" data-act="request-confirmation">Request buyer confirmation</button>`);
  if (d.status === "DISPUTED") actions.push(`<span class="tag bad">Disputed by ${esc(d.buyer_name)}: ${esc(d.events.filter((e) => e.type === "BUYER_DISPUTED").pop()?.payload?.reason || "")}</span>`);

  $("#detail").innerHTML = `
  <div class="card">
    <div class="hero">
      <div>
        <div class="row">${pill(d.status)} ${d.onchain?.status === "financed" ? `<span class="tag chain">On-chain: financed${d.onchain.lender && d.onchain.lender !== d.lender_id ? " by another lender" : ""}</span>` : ""} ${d.onchain?.confirmed ? `<span class="tag ok">Buyer-confirmed</span>` : ""}</div>
        <h2 style="margin-top:6px">${esc(d.invoice_no)} · ${inr(d.amount)}</h2>
        <p class="meta">${esc(d.seller_name)} → ${esc(d.buyer_name)} · applied to ${esc(d.lender?.name)} · due ${esc(d.due_date)}</p>
      </div>
      ${blocked ? ring(100, "bad", `<span style="font-size:1rem;color:var(--bad);letter-spacing:0">Blocked</span>`, `score ${score}`) : ring(score, score >= 75 ? "good" : score >= 50 ? "warn" : "bad", score, "Grade " + esc(r.grade || "-"))}
    </div>
    <p class="memo ${esc(d.status)}">${esc(r.memo || d.decision?.memo || "")}</p>
    ${o ? `<div class="offer">
      <div><span>Advance rate</span><b>${Math.round(o.advance_rate * 100)}%</b></div>
      <div><span>Advance</span><b>${inr(o.advance)}</b></div>
      <div><span>Discount rate</span><b>${(o.annual_rate * 100).toFixed(1)}% p.a.</b></div>
      <div><span>Tenor</span><b>${o.tenor_days} days</b></div>
      <div><span>Fees</span><b>${inr(o.discount_fee + o.processing_fee)}</b></div>
      <div><span>Net to SME</span><b>${inr(o.net_disbursal)}</b></div></div>` : ""}
    ${actions.length ? `<div class="row">${actions.join("")}</div>` : ""}
  </div>
  <div class="card">
    <div class="tabs" id="dtabs">
      ${[["pack", "Credit pack"], ["verify", "Cross-checks", fails ? "fail" : warns ? "warn" : "pass", `${(d.checks || []).length - fails - warns}/${(d.checks || []).length}`],
         ["dup", "Duplicate shield", d.dup?.verdict === "duplicate" ? "fail" : d.dup?.verdict === "suspect" ? "warn" : "pass", d.dup?.verdict],
         ["forensics", "Forensics", d.forensics?.verdict === "tampered" ? "fail" : d.forensics?.verdict === "suspicious" ? "warn" : "pass", d.forensics?.verdict],
         ["risk", "Risk score", null, score], ["data", "Extracted data"], ["audit", "Audit trail", null, d.events.length], ["privacy", "Privacy proof"], ["record", "Verification record"]]
        .map(([k, n, s, c]) => `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}">${n}${c != null ? `<span class="cnt s-${s || "SUBMITTED"}">${esc(c)}</span>` : ""}</button>`).join("")}
    </div>
    <div id="tabbody"></div>
  </div>`;
  $$("#dtabs button").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderDetail(d); }));
  $$("[data-act]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const res = await post(`/api/applications/${d.id}/${b.dataset.act}`);
    if (res.rescore) toast(`Buyer confirmed on-chain. Score ${res.rescore.from} → ${res.rescore.to} (grade ${res.rescore.from_grade} → ${res.rescore.to_grade})`);
    if (b.dataset.act === "disburse") toast("Disbursed. The invoice is registered on the consortium ledger, so no other lender can finance it.");
    if (b.dataset.act === "request-confirmation") toast(`Confirmation request sent to ${d.buyer_name}'s accounts-payable team`);
    renderDetail(res);
    loadList();
  })));
  renderTab(d);
}

function renderTab(d) {
  const el = $("#tabbody");
  const t = state.tab;
  if (t === "pack") return renderPack(d, el);
  if (t === "record") return renderRecord(d, el);
  if (t === "verify") {
    el.innerHTML = (d.checks || []).map((c) => `<div class="check">
      <span class="ic ${c.status}">${ICON[c.status]}</span>
      <div class="ttl">${esc(c.title)} ${pill(c.status, c.status.toUpperCase())}
        ${c.discrepancy_inr ? `<span class="pill s-fail">${inr(c.discrepancy_inr)} discrepancy</span>` : ""}
        <span class="conf" title="${esc(c.rule?.definition)}">${esc(c.rule?.id)} v${esc(c.rule?.version)} · confidence ${Math.round((c.confidence ?? 0) * 100)}% · sources: ${esc((c.sources || []).join(", "))}</span></div>
      <div class="ev">${esc(c.detail)}</div>
      <div>${(c.evidence || []).map((e) => typeof e === "string" ? `<ul><li>${esc(e)}</li></ul>` : evidenceTable(e.table, e.headers)).join("")}</div>
    </div>`).join("") || `<p class="muted">No checks ran.</p>`;
  } else if (t === "dup") {
    const dup = d.dup || {};
    el.innerHTML = `<p class="muted" style="margin:10px 0">Fingerprint = HMAC(consortium key, ${esc(dup.canonical_fields)})</p>
      <p class="hash">${esc(dup.fingerprint)}</p>
      <div class="layers">${(dup.layers || []).map((l, i) => `<div class="layer"><span class="n">L${i + 1}</span>
        <div><b>${esc(l.title)}</b> <span class="scope">· ${esc(l.scope)}</span><div class="ev muted">${esc(l.detail)}</div>
        ${(l.evidence || []).length ? `<ul class="muted">${l.evidence.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>${pill(l.status, l.status.toUpperCase())}</div>`).join("")}</div>
      <p class="muted" style="margin-top:10px">Layers 1–3 only see this lender's own books. Layer 4 queries the shared smart contract, which stores keyed hashes only: no amounts, names or documents.</p>`;
  } else if (t === "forensics") {
    const f = d.forensics || {};
    el.innerHTML = `<div style="margin:12px 0">${pill(f.verdict, (f.verdict || "").toUpperCase())}</div>
      ${(f.flags || []).map((x) => `<div class="check"><span class="ic ${x.severity === "high" ? "fail" : "warn"}">!</span><div class="ttl">${esc(x.title)}</div><div class="ev">${esc(x.detail)}</div><div></div></div>`).join("") || `<p>No signs of post-creation editing.</p>`}
      <dl class="kv" style="margin-top:12px">${Object.entries(f.facts || {}).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd class="mono">${esc(v ?? "—")}</dd>`).join("")}</dl>`;
  } else if (t === "risk") {
    const r = d.risk || {};
    const max = Math.max(10, ...(r.factors || []).map((f) => Math.abs(f.points)));
    el.innerHTML = `<p class="muted" style="margin:10px 0">Base ${r.base} + factors = <b>${r.score}</b> (grade ${esc(r.grade)}). Every point is traceable to data.</p>
      ${(r.factors || []).map((f) => `<div class="factor"><span>${esc(f.label)}</span>
        <div class="bar"><i class="${f.points >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(f.points) / max) * 50}%"></i></div>
        <span class="pts" style="color:${f.points >= 0 ? "var(--accent)" : "var(--bad)"}">${f.points > 0 ? "+" : ""}${f.points}</span><small>${esc(f.group)} · ${esc(f.detail)}</small></div>`).join("")}
      <div class="grid2" style="margin-top:14px">
        <div><h3>Buyer payment history</h3><dl class="kv">${kvList(r.buyer_profile, { avg_days_late: "days", late_ratio: "%", outstanding: "₹", defaulted_amount: "₹" })}</dl></div>
        <div><h3>Seller receivables</h3><dl class="kv">${kvList(r.seller_profile, { avg_invoice_to_buyer: "₹", open_receivables: "₹", buyer_concentration: "%" })}</dl></div>
      </div>`;
  } else if (t === "data") {
    const ex = d.extracted || {};
    el.innerHTML = Object.entries(ex).map(([k, v]) => `<h3 style="margin-top:12px">${k.toUpperCase()} <span class="mono muted">${esc(v.method || "")} · confidence ${Math.round((v.confidence || 0) * 100)}%</span></h3>
      <dl class="kv">${Object.entries(v).filter(([kk]) => !["items", "method", "confidence", "doc_type"].includes(kk)).map(([kk, vv]) => `<dt>${esc(kk)}</dt><dd>${esc(vv)}</dd>`).join("")}</dl>
      <div class="tbl"><table><tr>${Object.keys((v.items || [])[0] || {}).map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${(v.items || []).map((it) => `<tr>${Object.values(it).map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table></div>`).join("") +
      `<h3 style="margin-top:14px">Documents in encrypted vault</h3><div class="tbl"><table><tr><th>Kind</th><th>File</th><th>SHA-256</th><th>Size</th></tr>${d.documents.map((x) => `<tr><td>${x.kind}</td><td>${esc(x.filename)}</td><td class="hash">${x.sha256}</td><td>${x.size} B</td></tr>`).join("")}</table></div>`;
  } else if (t === "audit") {
    el.innerHTML = `<div class="timeline">${d.events.map((e) => `<div class="tl"><span class="t">#${e.id}</span>
      <div><b>${esc(e.type)}</b> <span class="muted">by ${esc(e.actor)} · ${esc(e.ts)}</span><div class="hash">${e.hash.slice(0, 32)}…</div></div>
      <button data-proof="${e.id}">${e.anchor_id ? "anchor #" + e.anchor_id + " · proof" : "pending"}</button></div>`).join("")}</div>`;
    $$("[data-proof]").forEach((b) => (b.onclick = () => showProof(+b.dataset.proof)));
  } else if (t === "privacy") {
    const fields = ["invoice_no", "invoice_date", "due_date", "po_number", "seller_name", "seller_gstin", "buyer_name", "buyer_gstin", "subtotal", "tax", "total", "items"];
    const def = ["total", "due_date", "buyer_name"];
    el.innerHTML = `<div class="discl" style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
      <p class="muted">Every field was salted, hashed and combined into a Merkle root (<span class="hash">${short(d.commitment, 16)}</span>). That root is stored on-chain at disbursal. Choose what to reveal to an auditor or second lender; everything else stays hidden but provably part of the same invoice.</p>
      <div class="fields">${fields.map((f) => `<label><input type="checkbox" value="${f}" ${def.includes(f) ? "checked" : ""}> ${f.replace(/_/g, " ")}</label>`).join("")}</div>
      <div class="row"><button class="btn primary" id="mk-disc">Generate proof card</button></div>
      <div id="disc-out"></div></div>`;
    $("#mk-disc").onclick = (e) => busy(e.currentTarget, async () => {
      const chosen = $$(".discl input:checked").map((i) => i.value);
      const pkg = await post(`/api/applications/${d.id}/disclose`, { fields: chosen });
      $("#disc-out").innerHTML = `<p><b>Proof card</b>: reveals ${chosen.length} of ${fields.length} fields. Hidden: ${esc(pkg.hidden_fields.join(", "))}.</p>
        <pre class="pkg">${esc(JSON.stringify(pkg, null, 1))}</pre>
        <div class="row" style="margin-top:8px"><button class="btn" id="vf-disc">Verify as the recipient</button><button class="btn ghost" id="forge-disc">Try forging the amount</button></div><div id="vf-out"></div>`;
      const verifyPkg = async (p, forged) => {
        const v = await post("/api/disclosure/verify", p);
        $("#vf-out").innerHTML = `<div class="result" style="margin-top:8px">${v.fields.map((f) => `${pill(f.ok ? "pass" : "fail", f.ok ? "VALID" : "INVALID")} <b>${esc(f.field)}</b> = ${esc(f.value)}`).join("<br>")}
          <br>${v.root_on_chain ? pill("FUNDED", "ROOT MATCHES ON-CHAIN RECORD") : v.root_anchored_in_audit ? pill("FUNDED", "ROOT ANCHORED ON-CHAIN (audit batch, block " + v.anchor.block + ")") : pill("fail", "ROOT NOT FOUND ON-CHAIN")}
          ${forged ? "<br><b>Changing one value breaks its Merkle proof.</b>" : ""}</div>`;
      };
      $("#vf-disc").onclick = () => verifyPkg(pkg, false);
      $("#forge-disc").onclick = () => {
        const p = JSON.parse(JSON.stringify(pkg));
        const t = p.revealed.find((r) => r.field === "total") || p.revealed[0];
        if (t) t.value = t.field === "total" ? "950000.0" : t.value + "X";
        verifyPkg(p, true);
      };
    });
  }
}

async function renderPack(d, el) {
  el.innerHTML = `<p class="muted" style="margin:12px 0">Building lender evidence pack…</p>`;
  const p = await api(`/api/applications/${d.id}/pack`);
  const cls = p.eligibility === "NOT ELIGIBLE" ? "badx" : p.eligibility === "ELIGIBLE" ? "good" : "warnx";
  const item = (x, kind) => `<li><b>${esc(x.what)}</b>${x.points ? ` <span class="mono" style="color:${x.points > 0 ? "var(--accent)" : "var(--bad)"}">${x.points > 0 ? "+" : ""}${x.points}</span>` : ""}${x.rule ? ` <span class="conf">${esc(x.rule)} · ${Math.round(x.confidence * 100)}%</span>` : ""}<div class="muted">${esc(x.evidence)}</div>${kind === "review" && x.action ? `<div class="act">→ ${esc(x.action)}</div>` : ""}</li>`;
  const inv = p.invoice, bp = p.payment_history, rc = p.receivables, t = p.terms;
  el.innerHTML = `<div class="pack">
    <div class="ok-big ${cls}"><b>${esc(p.eligibility)}</b><span>${p.supports.length} facts support eligibility · ${p.needs_review.length} item${p.needs_review.length === 1 ? "" : "s"} for lender review · ${p.blocking.length} blocking</span></div>
    <div class="facts">
      <div><span>Invoice status</span><b>${esc(STATUS[inv.status] || inv.status)}</b><small>${esc(inv.registry_note)}</small></div>
      <div><span>Buyer acceptance</span><b>${p.buyer_acceptance.confirmed ? "Confirmed on-chain" : "Pending"}</b><small>${p.buyer_acceptance.confirmed ? "Buyer acknowledged the debt" : "Not yet acknowledged"}</small></div>
      <div><span>Buyer pays</span><b>${bp.avg_days_late ?? "—"} days late avg</b><small>${bp.paid} paid · ${Math.round((bp.late_ratio || 0) * 100)}% late · ${bp.defaults} defaults</small></div>
      <div><span>Seller open receivables</span><b>${inr(rc.open_receivables)}</b><small>${Math.round((rc.buyer_concentration || 0) * 100)}% with this buyer</small></div>
      <div><span>Proposed terms</span><b>${t ? Math.round(t.advance_rate * 100) + "% · " + inr(t.advance) : "None"}</b><small>${t ? (t.annual_rate * 100).toFixed(1) + "% p.a. · " + t.tenor_days + " days" : "No financing offered"}</small></div>
    </div>
    ${p.blocking.length ? `<div class="col bad"><h3>Blocking issues (${p.blocking.length})</h3><ul>${p.blocking.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
    <div class="grid2">
      <div class="col good"><h3>What supports eligibility (${p.supports.length})</h3><ul>${p.supports.map((x) => item(x)).join("")}</ul></div>
      <div class="col warn"><h3>What still needs lender review (${p.needs_review.length})</h3><ul>${p.needs_review.map((x) => item(x, "review")).join("") || "<li>Nothing outstanding.</li>"}</ul></div>
    </div>
    ${p.conditions.length ? `<div class="col"><h3>Conditions before disbursal</h3><ol>${p.conditions.map((c) => `<li>${esc(c)}</li>`).join("")}</ol></div>` : ""}
    <div class="grid2">
      <div><h3>Buyer's recent payments</h3><div class="tbl"><table><tr><th>Invoice</th><th>Amount</th><th>Due</th><th>Paid</th><th>Days late</th></tr>${bp.recent.map((h) => `<tr><td>${esc(h.invoice_no)}</td><td class="num">${inr(h.amount)}</td><td>${esc(h.due_date)}</td><td>${esc(h.paid_date)}</td><td class="num" style="color:${h.days_late > 7 ? "var(--bad)" : "inherit"}">${h.days_late}</td></tr>`).join("")}</table></div></div>
      <div><h3>Seller's outstanding receivables</h3><div class="tbl"><table><tr><th>Invoice</th><th>Buyer</th><th>Amount</th><th>Due</th></tr>${rc.open_invoices.map((h) => `<tr><td>${esc(h.invoice_no)}</td><td>${esc(h.buyer)}</td><td class="num">${inr(h.amount)}</td><td>${esc(h.due_date)}</td></tr>`).join("")}</table></div></div>
    </div></div>`;
}

function renderRecord(d, el) {
  el.innerHTML = `<div style="margin-top:12px;display:flex;flex-direction:column;gap:12px">
    <p class="muted">A portable record any authorised party (buyer, auditor, another lender) can check <b>without trusting or even contacting Verbil</b>. It lists the documents submitted (as hashes), every rule applied and its result, the discrepancies found and the decision. It's signed with Verbil's Ed25519 key and anchored on-chain. Shaped like a W3C Verifiable Credential so other systems can ingest it.</p>
    <div class="row"><button class="btn primary" id="issue-rec">Issue signed record</button></div>
    <div id="rec-out"></div>
    <div class="card" style="background:var(--sunk)"><h3>Check a record (as the recipient)</h3>
      <label for="rec-file">Record (.json)</label><input type="file" id="rec-file" accept=".json">
      <label for="rec-docs">Documents you hold (optional, to detect changes since verification)</label><input type="file" id="rec-docs" multiple>
      <div class="row"><button class="btn" id="rec-verify">Verify record</button></div><div id="rec-vout"></div>
      <p class="muted">Offline, without our server: <span class="mono">python tools/verify_record.py record.json invoice.pdf</span>. It reads the root straight from the smart contract.</p></div></div>`;
  $("#issue-rec").onclick = (e) => busy(e.currentTarget, async () => {
    const rec = await post(`/api/applications/${d.id}/record`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" }));
    const cs = rec.credentialSubject;
    $("#rec-out").innerHTML = `<div class="ok-big good"><b>✓ Record issued</b><span>${esc(rec.id)} · signed · anchored in block ${rec.anchorProof.block}</span></div>
      <div class="tbl"><table><tr><th>Rule</th><th>Check</th><th>Result</th><th>Confidence</th><th>Finding</th></tr>${cs.rulesApplied.map((r) => `<tr class="${r.result === "fail" ? "bad" : ""}"><td class="mono">${r.rule} v${r.version}</td><td>${esc(r.check)}</td><td>${pill(r.result, r.result.toUpperCase())}</td><td>${Math.round(r.confidence * 100)}%</td><td>${esc(r.finding)}</td></tr>`).join("")}</table></div>
      <div class="row"><a class="btn" href="${url}" download="verbil-record-${d.id}.json">Download record (.json)</a><button class="btn ghost" id="rec-self">Verify this record now</button><button class="btn ghost" id="rec-forge">Forge it (change decision) and verify</button></div>
      <div id="rec-inline"></div>
      <pre class="pkg">${esc(JSON.stringify(rec, null, 1))}</pre>`;
    $("#rec-self").onclick = () => verifyRecord(rec, [], false, $("#rec-inline"));
    $("#rec-forge").onclick = () => {
      const f = JSON.parse(JSON.stringify(rec));
      f.credentialSubject.decision.outcome = "AUTO_APPROVED";
      f.credentialSubject.decision.riskScore = 99;
      verifyRecord(f, [], true, $("#rec-inline"));
    };
  });
  $("#rec-verify").onclick = async () => {
    const f = $("#rec-file").files[0];
    if (!f) return toast("Choose a record file first");
    verifyRecord(JSON.parse(await f.text()), [...$("#rec-docs").files], false, $("#rec-vout"));
  };
}

async function verifyRecord(rec, docs, forged, target) {
  const fd = new FormData();
  fd.append("record", new Blob([JSON.stringify(rec)], { type: "application/json" }), "record.json");
  docs.forEach((f) => fd.append("files", f));
  const v = await (await fetch("/api/records/verify", { method: "POST", body: fd })).json();
  const st = v.anchored.steps || {};
  const good = v.signature_valid && v.anchored.verified && (!v.documents || v.documents.every((x) => x.status === "unchanged"));
  target.innerHTML = `<div class="result" style="margin-top:8px">
    <div class="ok-big ${good ? "good" : "badx"}" style="padding:8px 12px"><b>${good ? "✓ Record verified" : "✕ Record not verified"}</b><span>${forged ? "The decision was changed after signing, so the signature no longer matches." : ""}</span></div>
    ${pill(v.signature_valid ? "pass" : "fail", v.signature_valid ? "SIGNATURE VALID" : "SIGNATURE INVALID")} ${pill(v.issuer_trusted ? "pass" : "warn", v.issuer_trusted ? "TRUSTED ISSUER KEY" : "UNKNOWN ISSUER")}<br>
    ${Object.entries(st).map(([k, ok]) => `${ok ? "✓" : "✕"} ${k.replace(/_/g, " ")}`).join(" · ")}${v.anchored.block ? ` · block ${v.anchored.block}` : ""}<br>
    ${v.documents ? v.documents.map((x) => `${pill(x.status === "unchanged" ? "pass" : "fail", x.status.toUpperCase())} ${esc(x.kind)} ${esc(x.file || "")}`).join("<br>") + "<br>" : ""}
    <b>Live on-chain status:</b> ${esc(v.live_registry_status)}${v.live_buyer_confirmed ? " · buyer-confirmed" : ""} (record says: ${esc(v.recorded_outcome)})</div>`;
}

function evidenceTable(rows, headers) {
  if (!rows?.length) return "";
  const h = headers || ["Line", "Invoice", "Reference", ""];
  return `<div class="tbl"><table><tr>${h.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${rows.map((r) =>
    `<tr class="${r.status === "fail" ? "bad" : ""}"><td>${esc(r.line)}</td><td>${esc(r.invoice)}</td><td>${esc(r.reference)}</td><td>${r.note ? `<b style="color:var(--bad)">${esc(r.note)}</b>` : ICON[r.status]}</td></tr>`).join("")}</table></div>`;
}
function kvList(obj, units) {
  return Object.entries(obj || {}).map(([k, v]) => {
    let s = v;
    if (units[k] === "₹") s = inr(v);
    else if (units[k] === "%" && v != null) s = Math.round(v * 100) + "%";
    else if (units[k] && v != null) s = v + " " + units[k];
    return `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(s ?? "—")}</dd>`;
  }).join("");
}

async function showProof(eventId) {
  const p = await api(`/api/audit/events/${eventId}/proof`);
  if (!p.anchored) return modal(`<h3>Event #${eventId}</h3><p>Not anchored yet.</p>`);
  modal(`<h2>On-chain proof for event #${eventId}</h2>
    <div class="ok-big ${p.verified ? "good" : "badx"}"><b>${p.verified ? "✓ Verified" : "✕ Failed"}</b><span>${p.verified ? "This event is exactly as it was when anchored on-chain." : p.content_intact ? "Proof does not reach the on-chain root." : "The record's content was changed after it was written."}</span></div>
    <dl class="kv"><dt>Event hash (stored)</dt><dd class="hash">${p.event_hash}</dd><dt>Recomputed from content</dt><dd class="hash">${p.recomputed_hash}</dd>
    <dt>Batch</dt><dd>events ${p.anchor.from_event}–${p.anchor.to_event} (anchor #${p.anchor.id})</dd>
    <dt>Transaction</dt><dd class="hash">${short(p.anchor.tx_hash, 40)} · block ${p.anchor.block}</dd></dl>
    <h3>Merkle path (${p.proof.length} steps)</h3>
    <div class="proof-path">${p.proof.map((s, i) => `<div>${i + 1}. hash with ${s.side} sibling ${s.hash}</div>`).join("") || "<div>Single-event batch: the event hash is the root.</div>"}</div>
    <dl class="kv"><dt>Root (local record)</dt><dd class="hash">${p.root}</dd><dt>Root read from contract</dt><dd class="hash">${p.onchain_root}</dd></dl>`);
}

/* ---------------- SME portal ---------------- */
$("#sme-form").onsubmit = (e) => {
  e.preventDefault();
  busy($("#sme-submit"), async () => {
    const fd = new FormData(e.target);
    for (const k of ["po", "grn", "bank", "soa"]) if (!fd.get(k)?.size) fd.delete(k);
    const r = await fetch("/api/applications", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Upload failed");
    $("#sme-msg").innerHTML = `<div class="result">${pill(d.status)} ${esc(d.risk?.memo || "")}<br><a id="to-biz">Track it in My invoices →</a></div>`;
    $("#to-biz").onclick = () => show("biz");
  });
};

/* ---------------- audit view ---------------- */
async function loadAudit() {
  const { events, anchors } = await api("/api/audit/events");
  $("#anchors").innerHTML = anchors.length ? `<table><tr><th>#</th><th>Events</th><th>Merkle root</th><th>Tx · block</th></tr>${anchors.map((a) =>
    `<tr><td>${a.id}</td><td>${a.from_event}–${a.to_event}</td><td class="hash">${short(a.root, 14)}</td><td class="hash">${short(a.tx_hash, 8)} · ${a.block}</td></tr>`).join("")}</table>` : `<p class="muted">No anchors yet.</p>`;
  $("#events").innerHTML = `<table><tr><th>#</th><th>Type</th><th>Actor</th><th>App</th><th>prev → hash</th><th>Anchor</th></tr>${events.map((e) =>
    `<tr class="ev-row" data-ev="${e.id}"><td>${e.id}</td><td><b>${esc(e.type)}</b></td><td>${esc(e.actor)}</td><td>${e.app_id ?? ""}</td><td class="hash">${e.prev_hash.slice(0, 8)}… → ${e.hash.slice(0, 8)}…</td><td>${e.anchor_id ?? "pending"}</td></tr>`).join("")}</table>`;
  $$("[data-ev]").forEach((r) => (r.onclick = () => showProof(+r.dataset.ev)));
}
$("#verify-all").onclick = (e) => busy(e.currentTarget, async () => renderVerify(await api("/api/audit/verify"), $("#verify-out")));

function renderVerify(v, target) {
  const badAnchors = v.anchors.filter((a) => !a.ok);
  const badDocs = v.documents.filter((d) => !d.ok);
  target.innerHTML = `<div class="card">
    <div class="ok-big ${v.ok ? "good" : "badx"}"><b>${v.ok ? "✓ All records intact" : "✕ Tampering detected"}</b>
      <span>${v.events_checked} events, ${v.anchors.length} on-chain anchors and ${v.documents.length} documents checked at ${esc(v.checked_at)}</span></div>
    ${v.broken_events.length ? `<h3>Altered audit records</h3><div class="tbl"><table><tr><th>Event</th><th>Type</th><th>App</th><th>Problem</th></tr>${v.broken_events.map((b) => `<tr class="bad"><td>#${b.event_id}</td><td>${esc(b.type)}</td><td>${b.app_id ?? ""}</td><td>${esc(b.problems.join("; "))}</td></tr>`).join("")}</table></div>` : ""}
    ${badAnchors.length ? `<h3>On-chain root mismatch</h3><div class="tbl"><table><tr><th>Anchor</th><th>Events</th><th>Root on blockchain</th><th>Recomputed from database</th></tr>${badAnchors.map((a) => `<tr class="bad"><td>#${a.anchor_id}</td><td>${a.events}</td><td class="hash">${short(a.onchain_root, 20)}</td><td class="hash">${short(a.recomputed_root, 20)}</td></tr>`).join("")}</table></div><p class="muted">Even if an insider recomputed every hash in the database, they cannot change the root already written to the blockchain.</p>` : ""}
    ${badDocs.length ? `<h3>Altered documents</h3><div class="tbl"><table><tr><th>Doc</th><th>App</th><th>File</th><th>Recorded SHA-256</th><th>Actual</th><th>Finding</th></tr>${badDocs.map((d) => `<tr class="bad"><td>#${d.doc_id}</td><td>${d.app_id}</td><td>${esc(d.filename)}</td><td class="hash">${short(d.recorded_sha256, 12)}</td><td class="hash">${short(d.actual_sha256, 12)}</td><td>${esc(d.reason)}</td></tr>`).join("")}</table></div>` : ""}
    ${v.ok ? `<p class="muted">Every event hash recomputes, every link holds, every Merkle root matches the one stored in the smart contract, and every vault file matches its recorded SHA-256.</p>` : ""}
  </div>`;
}

$("#doc-check").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  const r = await (await fetch("/api/audit/verify-document", { method: "POST", body: fd })).json();
  $("#doc-check-out").innerHTML = r.found
    ? `<div class="ok-big ${r.proof?.verified ? "good" : "badx"}"><b>${r.proof?.verified ? "✓ Authentic" : "✕ Proof failed"}</b><span>Submitted as the ${esc(r.document.kind)} of application #${r.document.app_id} on ${esc(r.document.created_at)}. Its hash is in audit event #${r.event_id}, anchored in block ${r.proof?.anchor?.block}.</span></div><p class="hash">${r.sha256}</p><button class="btn" onclick="showProof(${r.event_id})">See Merkle proof</button>`
    : `<div class="ok-big badx"><b>✕ Unknown file</b><span>${esc(r.message)}</span></div><p class="hash">${r.sha256}</p>`;
};

/* ---------------- lender dashboard ---------------- */
async function loadDash() {
  const lid = state.persona.lender_id;
  const [d] = await Promise.all([api(`/api/lenders/${lid}/dashboard`), loadMeta()]);
  const k = d.kpis;
  $("#dash-eyebrow").textContent = `${d.lender.name} · Credit desk`;
  $("#dash-title").textContent = "Portfolio overview";
  $("#dash-kpis").innerHTML = [
    ["Disbursed to SMEs", inr(k.disbursed)], ["Live exposure", inr(k.exposure)],
    ["Approval rate", k.approval_rate == null ? "—" : Math.round(k.approval_rate * 100) + "%"],
    ["Fraud & risk blocked", inr(k.blocked_value)], ["Avg. decision time", k.avg_decision_ms ? (k.avg_decision_ms / 1000).toFixed(1) + " s" : "—"],
    ["Applications", k.applications],
  ].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  const row = (a, right) => `<button class="mini" data-open="${a.id}"><span><b>${esc(a.invoice_no)}</b><small>${esc(a.seller_name)} → ${esc(a.buyer_name)}</small></span><span class="mini-r">${right}</span></button>`;
  $("#dash-attention").innerHTML = d.attention.length ? d.attention.map((a) => row(a, `${pill(a.status)}<b>${inr(a.amount)}</b>`)).join("")
    : `<p class="muted">You're all caught up. New verified applications land here.</p>`;
  $("#dash-blocked").innerHTML = d.blocked.length ? d.blocked.map((a) => row(a, `<b class="bad-t">${inr(a.amount)}</b>`).replace("</small></span>", `</small><small class="bad-t">${esc((a.stop || "Declined on risk").split(":")[0])}</small></span>`)).join("")
    : `<p class="muted">Nothing blocked yet.</p>`;
  const max = Math.max(1, ...d.exposure_by_buyer.map((x) => x.amount));
  $("#dash-exposure").innerHTML = d.exposure_by_buyer.length ? d.exposure_by_buyer.map((x) =>
    `<div class="xbar"><span>${esc(x.buyer)}</span><div><i style="width:${(x.amount / max) * 100}%"></i></div><b>${inr(x.amount)}</b></div>`).join("")
    : `<p class="muted">No live exposure. Disbursed invoices appear here until the buyer pays.</p>`;
  const c = state.meta.chain;
  $("#dash-network").innerHTML = `<dl class="kv">
    <dt>Status</dt><dd><span class="dot ${c.mode === "hardhat" ? "" : "off"}" style="display:inline-block;margin-right:6px"></span>${c.mode === "hardhat" ? "Synced" : "Offline"}</dd>
    <dt>Network</dt><dd>${esc(c.network)}</dd><dt>Registry contract</dt><dd class="hash">${esc(c.contract)}</dd>
    <dt>Latest block</dt><dd>${c.block}</dd><dt>Audit anchors</dt><dd>${c.anchors}</dd>
    <dt>Lenders in network</dt><dd>${state.meta.lenders.map((l) => esc(l.name)).join(", ")}</dd></dl>`;
  $$("#view-dash [data-open]").forEach((b) => (b.onclick = () => openApp(+b.dataset.open)));
}

/* ---------------- business: my invoices ---------------- */
const STAGES = ["Submitted", "Verified", "Offer", "Funded", "Repaid"];
function stageOf(s) {
  return { SUBMITTED: 0, MANUAL_REVIEW: 1, AUTO_APPROVED: 2, APPROVED: 2, FUNDED: 3, REPAID: 4 }[s] ?? -1;
}
async function loadBiz() {
  const p = state.persona;
  $("#biz-eyebrow").textContent = p.name;
  const apps = await api(`/api/applications?seller_gstin=${p.gstin}`);
  const funded = apps.filter((a) => ["FUNDED", "REPAID"].includes(a.status));
  const open = apps.filter((a) => ["MANUAL_REVIEW", "AUTO_APPROVED", "APPROVED"].includes(a.status));
  $("#biz-kpis").innerHTML = [
    ["Received early", inr(funded.reduce((t, a) => t + (a.net || 0), 0))], ["Offers & reviews open", open.length],
    ["Requests", apps.length], ["Fastest decision", apps.some((a) => a.ms) ? (Math.min(...apps.filter((a) => a.ms).map((a) => a.ms)) / 1000).toFixed(1) + " s" : "—"],
  ].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  $("#biz-list").innerHTML = apps.length ? apps.map((a) => {
    const st = stageOf(a.status);
    const declined = ["REJECTED", "DISPUTED"].includes(a.status);
    return `<article class="biz-card">
      <div class="biz-top"><div><b>${esc(a.invoice_no)}</b><small>${esc(a.buyer_name)} · applied to ${esc(a.lender_name)}</small></div><div class="biz-amt">${inr(a.amount)}</div></div>
      ${declined ? `<div class="declined">${pill(a.status, a.status === "DISPUTED" ? "Disputed by buyer" : "Declined")}<span>${esc(a.stop || "The lender declined this request based on its risk assessment.")}</span></div>`
        : `<ol class="stages">${STAGES.map((n, i) => `<li class="${i < st ? "done" : i === st ? "cur" : ""}"><span></span>${n}</li>`).join("")}</ol>
           <div class="biz-note">${a.status === "MANUAL_REVIEW" ? `Under review by ${esc(a.lender_name)}. Asking ${esc(a.buyer_name)} to confirm the invoice can speed this up.`
             : ["AUTO_APPROVED", "APPROVED"].includes(a.status) ? `Offer: <b>${inr(a.net)}</b> today (${Math.round((a.adv || 0) * 100)}% advance). Awaiting disbursal by ${esc(a.lender_name)}.`
             : a.status === "FUNDED" ? `<b>${inr(a.net)}</b> received. ${esc(a.buyer_name)} pays ${esc(a.lender_name)} on ${esc(a.due_date)}.`
             : a.status === "REPAID" ? "Closed. The buyer paid in full." : ""}</div>`}
    </article>`;
  }).join("") : `<div class="empty"><b>No invoices yet</b>Upload an unpaid invoice to get an offer in seconds.</div>`;
}

/* ---------------- buyer: confirmations ---------------- */
async function loadBuyer() {
  const p = state.persona;
  $("#buyer-eyebrow").textContent = `${p.name} · Accounts payable`;
  const rows = await api(`/api/buyers/${p.gstin}/invoices`);
  const pending = rows.filter((r) => !r.confirmed && r.status !== "DISPUTED");
  $("#buyer-list").innerHTML = rows.length ? `
    <div class="buyer-sum"><b>${pending.length}</b> awaiting your confirmation · ${rows.length - pending.length} handled</div>` + rows.map((r) => `
    <article class="buyer-row ${r.confirmed ? "is-done" : ""}">
      <div class="br-main"><b>${esc(r.invoice_no)}</b><small>${esc(r.seller_name)} · PO matched · due ${esc(r.due_date)}</small>
        <div class="row" style="margin-top:6px">${r.requested && !r.confirmed ? `<span class="tag warn">Requested by ${esc(r.lender_name)}</span>` : ""}${r.financed_onchain ? `<span class="tag chain">Financed by ${esc(r.lender_name)}: pay into their escrow</span>` : ""}</div></div>
      <div class="br-amt">${inr(r.amount)}</div>
      <div class="br-act">${r.confirmed ? `<span class="tag ok">✓ Confirmed on-chain</span>` : r.status === "DISPUTED" ? `<span class="tag bad">Disputed</span>`
        : `<button class="btn primary" data-confirm="${r.id}">Confirm</button><button class="btn danger" data-dispute="${r.id}">Dispute</button>`}</div>
    </article>`).join("") : `<div class="empty"><b>Nothing to confirm</b>Invoices your suppliers finance through Verbil appear here.</div>`;
  $$("[data-confirm]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const res = await post(`/api/applications/${b.dataset.confirm}/buyer-confirm`);
    toast(`Confirmed and signed on-chain. ${res.seller_name}'s risk score improved ${res.rescore.from} → ${res.rescore.to}.`);
    loadBuyer();
  })));
  $$("[data-dispute]").forEach((b) => (b.onclick = () => {
    modal(`<h2>Dispute this invoice</h2><p class="muted">Tell the supplier and lender what's wrong. This is recorded in the audit trail.</p>
      <div class="discl fields" style="display:grid;gap:8px">${["Goods not received", "Quantity or price doesn't match our PO", "Already paid", "Duplicate invoice"].map((x, i) =>
        `<label><input type="radio" name="reason" value="${esc(x)}" ${i ? "" : "checked"}> ${esc(x)}</label>`).join("")}</div>
      <div class="row"><button class="btn danger" id="do-dispute">Submit dispute</button></div>`);
    $("#do-dispute").onclick = (e) => busy(e.currentTarget, async () => {
      await post(`/api/applications/${b.dataset.dispute}/buyer-dispute`, { reason: $("input[name=reason]:checked").value });
      $("#modal").hidden = true;
      toast("Dispute recorded. The lender has been notified and financing is on hold.");
      loadBuyer();
    });
  }));
}

/* ---------------- public verify ---------------- */
$("#pv-go").onclick = async () => {
  const f = $("#pv-record").files[0];
  if (!f) return toast("Choose a record file first");
  let rec;
  try { rec = JSON.parse(await f.text()); } catch (e) { return toast("That file isn't a valid Verbil record"); }
  verifyRecord(rec, [...$("#pv-docs").files], false, $("#pv-out"));
};

/* ---------------- boot ---------------- */
let saved = null;
try { saved = localStorage.getItem("vf-persona"); } catch (e) { /* storage unavailable */ }
setPersona(saved || "lender_a", false);
show("home");

setInterval(() => { loadMeta().catch(() => {}); }, 20000);
