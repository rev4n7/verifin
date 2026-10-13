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

/* ---------------- charts: hand-rolled SVG, no libraries ---------------- */
// Categorical slots validated (dark mode, all-pairs) against the chart surface #0b1633.
const VZ = { s: ["#3987e5", "#d95926", "#199e70"], good: "#0ca30c", warn: "#fab219", crit: "#d03b3b",
  surface: "#0b1633", grid: "rgba(255,255,255,.07)", axis: "rgba(255,255,255,.2)", ink: "#f2f6ff", ink2: "#c9d6ee", muted: "#93a6c6" };
const inrShort = (v) => {
  if (v == null) return "—";
  const f = (x) => String(+x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2));
  return "₹" + (v >= 1e7 ? f(v / 1e7) + " Cr" : v >= 1e5 ? f(v / 1e5) + " L" : v >= 1e3 ? f(v / 1e3) + "K" : Math.round(v));
};
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${+(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const shortName = (s) => String(s || "").replace(/ (Ltd|Limited|Pvt\.? Ltd)\.?$/i, "");
function niceScale(max, n = 4) {
  if (!(max > 0)) return { max: n, step: 1 };
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}
// bars: 4px rounded data end, square at the baseline
function hbarPath(x, y, w, h, r = 4) {
  if (w <= 0.5) return "";
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x}Z`;
}
function vbarPath(x, base, w, h, r = 4) {
  if (h <= 0.5) return "";
  r = Math.min(r, h, w / 2);
  const y = base - h;
  return `M${x},${base}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${base}Z`;
}
const svgText = (x, y, s, { fill = VZ.muted, size = 11, anchor = "start", weight = 400, halo = false, cls = "" } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="middle"${cls ? ` class="${cls}"` : ""}${halo ? ` stroke="${VZ.surface}" stroke-width="4" paint-order="stroke" stroke-linejoin="round"` : ""}>${esc(s)}</text>`;

/* tooltip: labels can come from parsed documents, so it is built with textContent only */
function tipShow(t, cx, cy) {
  const el = $("#viz-tip");
  el.replaceChildren();
  const add = (tag, cls, text, parent = el) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; parent.append(n); return n; };
  add("div", "tt-h", t.title);
  for (const r of t.rows || []) {
    const row = add("div", "tt-r");
    if (r.color) add("i", r.shape === "x" ? "x" : r.shape === "dot" ? "dot" : "", null, row).style.setProperty("--k", r.color);
    add("b", "", r.value, row);
    if (r.label) add("span", "", r.label, row);
  }
  if (t.note) add("div", "tt-n", t.note);
  el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = cx + 14, y = cy - h - 12;
  if (x + w > innerWidth - 8) x = cx - w - 14;
  if (y < 8) y = cy + 16;
  el.style.transform = `translate(${Math.round(Math.max(8, x))}px,${Math.round(y)}px)`;
}
const tipHide = () => { const el = $("#viz-tip"); if (el) el.hidden = true; };
addEventListener("scroll", tipHide, { passive: true });

const VIZ = {}; // card id -> { spec, mode }
function vizCard(id, spec) {
  VIZ[id] = { spec, mode: VIZ[id]?.mode || "chart" };
  vizRender(id);
}
function vizRender(id) {
  const el = document.getElementById(id), { spec, mode } = VIZ[id];
  const legend = spec.legend?.length && mode === "chart"
    ? `<div class="viz-legend">${spec.legend.map((l) => `<span><i class="k-${l.shape || "rect"}" style="--k:${l.color}"></i>${esc(l.label)}</span>`).join("")}</div>` : "";
  el.innerHTML = `<div class="viz-head"><div><h3>${esc(spec.title)}</h3>${spec.sub ? `<p>${esc(spec.sub)}</p>` : ""}</div>
      <div class="viz-tabs" role="group" aria-label="Show as"><button data-m="chart" class="${mode === "chart" ? "on" : ""}">Chart</button><button data-m="table" class="${mode === "table" ? "on" : ""}">Table</button></div></div>
    ${spec.figure ? `<div class="viz-fig"><b>${spec.figure}</b>${spec.figureNote ? `<span>${esc(spec.figureNote)}</span>` : ""}</div>` : ""}
    ${legend}<div class="viz-body"></div>${spec.after || ""}${spec.foot ? `<p class="viz-foot">${esc(spec.foot)}</p>` : ""}`;
  $$(".viz-after [data-open]", el).forEach((b) => (b.onclick = () => openApp(+b.dataset.open)));
  $$(".viz-tabs button", el).forEach((b) => (b.onclick = () => { VIZ[id].mode = b.dataset.m; vizRender(id); }));
  const body = $(".viz-body", el);
  if (mode === "table") {
    body.innerHTML = `<div class="tbl viz-table">${spec.table()}</div>`;
    return;
  }
  const out = spec.draw(Math.max(260, Math.floor(body.clientWidth)));
  if (out.empty) {
    body.innerHTML = `<div class="viz-empty">${esc(out.empty)}</div>`;
    return;
  }
  body.innerHTML = out.svg;
  const tips = out.tips || [];
  $$("[data-t]", body).forEach((m) => {
    const t = tips[+m.dataset.t];
    m.addEventListener("pointermove", (e) => tipShow(t, e.clientX, e.clientY));
    m.addEventListener("pointerleave", tipHide);
    m.addEventListener("focus", () => { const r = m.getBoundingClientRect(); tipShow(t, r.left + r.width / 2, r.top); });
    m.addEventListener("blur", tipHide);
    if (m.dataset.open) {
      m.addEventListener("click", () => { tipHide(); openApp(+m.dataset.open); });
      m.addEventListener("keydown", (e) => { if (e.key === "Enter") { tipHide(); openApp(+m.dataset.open); } });
    }
  });
  if (out.crosshair) wireCrosshair(body, out.crosshair);
}
let vizResizeT;
addEventListener("resize", () => {
  clearTimeout(vizResizeT);
  vizResizeT = setTimeout(() => state.view === "dash" && Object.keys(VIZ).forEach(vizRender), 160);
});

/* horizontal bars: one series, value at the tip */
function drawHBars(w, rows, { max, empty }) {
  const longest = Math.max(0, ...rows.map((r) => String(r.label).length)), valueW = 96;
  const labelW = Math.min(170, Math.max(72, Math.ceil(longest * 7.1) + 16)), x0 = labelW, span = Math.max(40, w - labelW - valueW);
  const rowH = 38, bh = 20;
  const sc = max > 0 ? span / max : 0, h = rows.length * rowH + 4;
  const g = rows.map((r, i) => {
    const y = i * rowH + 2, len = r.value * sc, by = y + (rowH - bh) / 2, cy = y + rowH / 2;
    return `<g class="vmark" data-t="${i}" tabindex="0" role="img" aria-label="${esc(r.label)}: ${esc(r.display)}"${r.open ? ` data-open="${r.open}"` : ""}>
      <rect x="0" y="${y}" width="${w}" height="${rowH}" fill="transparent"/>
      ${svgText(0, cy, r.label, { fill: VZ.ink2, size: 12.5 })}
      <rect x="${x0}" y="${cy}" width="${span}" height="1" fill="${VZ.grid}"/>
      <path class="mk" d="${hbarPath(x0, by, len, bh)}" fill="${VZ.s[0]}"/>
      ${svgText(x0 + len + (len > 0.5 ? 8 : 0), cy, r.display, { fill: r.value ? VZ.ink : VZ.muted, size: 12.5, weight: r.value ? 600 : 400, cls: "tn" })}
    </g>`;
  }).join("");
  return { svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="viz-svg">${g}</svg>`, tips: rows.map((r) => r.tip), empty };
}

/* multi-series line with crosshair */
function drawLines(w, { labels, series, threshold }) {
  const h = 250, ends = w >= 520, m = { l: 34, r: ends ? 122 : 14, t: 14, b: 30 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const vals = series.flatMap((s) => s.points.filter(Boolean).map((p) => p.avg));
  const { max, step } = niceScale(Math.max(threshold ? threshold * 1.15 : 0, ...vals, 1), 5);
  const X = (i) => m.l + 10 + (labels.length > 1 ? (i * (pw - 20)) / (labels.length - 1) : (pw - 20) / 2);
  const Y = (v) => m.t + ph - (v / max) * ph;
  let g = "";
  for (let v = 0; v <= max + 1e-9; v += step) {
    g += `<rect x="${m.l}" y="${Y(v)}" width="${pw}" height="1" fill="${v === 0 ? VZ.axis : VZ.grid}"/>` + svgText(m.l - 8, Y(v), v, { anchor: "end", cls: "tn" });
  }
  const every = Math.ceil(labels.length / Math.max(1, Math.floor(pw / 64)));
  labels.forEach((l, i) => { if (i % every === 0 || i === labels.length - 1) g += svgText(X(i), h - 12, l, { anchor: "middle" }); });
  if (threshold && threshold <= max) {
    g += `<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(threshold)}" y2="${Y(threshold)}" stroke="${VZ.muted}" stroke-opacity=".55" stroke-dasharray="4 4"/>`
      + svgText(m.l + 6, Y(threshold) - 9, `${threshold} days late: risk score penalty`, { halo: true, size: 10.5 });
  }
  const endLabels = [];
  series.forEach((s, si) => {
    const color = VZ.s[si];
    let d = "", pen = false;
    s.points.forEach((p, i) => {
      if (!p) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(p.avg).toFixed(1)}`;
      pen = true;
    });
    g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.points.forEach((p, i) => { // lone points between gaps still need a mark
      if (p && !s.points[i - 1] && !s.points[i + 1]) g += `<circle cx="${X(i)}" cy="${Y(p.avg)}" r="3" fill="${color}"/>`;
    });
    const li = s.points.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).pop();
    if (li != null) {
      g += `<circle cx="${X(li)}" cy="${Y(s.points[li].avg)}" r="4" fill="${color}" stroke="${VZ.surface}" stroke-width="2"/>`;
      endLabels.push({ y: Y(s.points[li].avg), x: X(li), text: shortName(s.buyer) });
    }
  });
  const sorted = [...endLabels].sort((a, b) => a.y - b.y);
  if (ends && sorted.every((l, i) => !i || l.y - sorted[i - 1].y >= 15)) {
    endLabels.forEach((l) => (g += svgText(l.x + 10, l.y, l.text, { fill: VZ.ink2, size: 12 })));
  }
  const xh = `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" stroke="${VZ.ink}" stroke-opacity=".35" visibility="hidden"/>
    ${series.map((s, si) => `<circle class="xd" data-s="${si}" r="4.5" fill="${VZ.s[si]}" stroke="${VZ.surface}" stroke-width="2" visibility="hidden"/>`).join("")}
    <rect class="xhit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" tabindex="0" role="img" aria-label="Average days paid late by quarter. Use arrow keys to step through quarters."/>`;
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="viz-svg">${g}${xh}</svg>`,
    crosshair: { n: labels.length, X, Y, w, series,
      tip: (i) => ({ title: `${labels[i]} · due dates in this quarter`,
        rows: series.map((s, si) => ({ color: VZ.s[si], value: s.points[i] ? `${s.points[i].avg} days` : "no invoices",
          label: `${shortName(s.buyer)}${s.points[i] ? ` · ${plural(s.points[i].n, "invoice")}` : ""}` })) }) },
  };
}
function wireCrosshair(body, c) {
  const svg = $("svg", body), hit = $(".xhit", svg), line = $(".xh", svg), dots = $$(".xd", svg);
  let cur = -1;
  const at = (i, cx, cy) => {
    cur = i;
    line.setAttribute("x1", c.X(i)); line.setAttribute("x2", c.X(i)); line.setAttribute("visibility", "visible");
    dots.forEach((d) => {
      const p = c.series[+d.dataset.s].points[i];
      d.setAttribute("visibility", p ? "visible" : "hidden");
      if (p) { d.setAttribute("cx", c.X(i)); d.setAttribute("cy", c.Y(p.avg)); }
    });
    tipShow(c.tip(i), cx, cy);
  };
  const off = () => { line.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); tipHide(); };
  const nearest = (sx) => { let b = 0; for (let i = 1; i < c.n; i++) if (Math.abs(c.X(i) - sx) < Math.abs(c.X(b) - sx)) b = i; return b; };
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    at(nearest(((e.clientX - r.left) * c.w) / r.width), e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", off);
  const kb = (i) => { const r = svg.getBoundingClientRect(); at(i, r.left + (c.X(i) * r.width) / c.w, r.top + 10); };
  hit.addEventListener("focus", () => kb(c.n - 1));
  hit.addEventListener("blur", off);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); kb(Math.max(0, Math.min(c.n - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)))); }
  });
}

/* risk score strip against the decision policy */
function drawScoreStrip(w, apps) {
  const m = { l: 10, r: 10, t: 30, b: 28 }, pw = w - m.l - m.r, X = (s) => m.l + (Math.max(0, Math.min(100, s)) / 100) * pw;
  const lanes = [];
  const placed = [...apps].map((a, i) => ({ a, i })).sort((p, q) => p.a.score - q.a.score).map((p) => {
    const x = X(p.a.score);
    let l = 0;
    while ((lanes[l] || []).some((px) => Math.abs(px - x) < 16)) l++;
    (lanes[l] = lanes[l] || []).push(x);
    return { ...p, x, lane: l };
  });
  const laneH = 18, ph = Math.max(132, lanes.length * laneH + 40), h = m.t + ph + m.b, base = m.t + ph / 2 + ((lanes.length - 1) * laneH) / 2;
  const zones = [[0, 45, VZ.crit, "✕ Decline", "below 45"], [45, 75, VZ.warn, "! Manual review", "45–74"], [75, 100, VZ.good, "✓ Auto-approve", "75+"]];
  let g = zones.map(([a, b, c, name]) => `<rect x="${X(a)}" y="${m.t}" width="${X(b) - X(a)}" height="${ph}" fill="${c}" fill-opacity=".07"/>`
    + svgText(X(a) + 8, m.t - 14, name, { fill: VZ.ink2, size: 11.5, weight: 600 })).join("");
  g += [45, 75].map((v) => `<rect x="${X(v)}" y="${m.t}" width="1" height="${ph}" fill="${VZ.axis}"/>`).join("");
  g += `<rect x="${m.l}" y="${m.t + ph}" width="${pw}" height="1" fill="${VZ.axis}"/>`;
  g += [0, 45, 75, 100].map((v) => svgText(X(v), m.t + ph + 14, v, { anchor: v === 0 ? "start" : v === 100 ? "end" : "middle", cls: "tn" })).join("");
  g += placed.map(({ a, i, x, lane }) => {
    const y = base - lane * laneH;
    const mark = a.hard_stop
      ? `<path d="M${x - 5},${y - 5}L${x + 5},${y + 5}M${x + 5},${y - 5}L${x - 5},${y + 5}" stroke="${VZ.surface}" stroke-width="6" stroke-linecap="round"/><path class="mk" d="M${x - 5},${y - 5}L${x + 5},${y + 5}M${x + 5},${y - 5}L${x - 5},${y + 5}" stroke="${VZ.crit}" stroke-width="2.5" stroke-linecap="round"/>`
      : `<circle class="mk" cx="${x}" cy="${y}" r="6" fill="${VZ.s[0]}" stroke="${VZ.surface}" stroke-width="2"/>`;
    return `<g class="vmark" data-t="${i}" data-open="${a.id}" tabindex="0" role="img" aria-label="${esc(a.invoice_no)}: score ${a.score}"><circle cx="${x}" cy="${y}" r="13" fill="transparent"/>${mark}</g>`;
  }).join("");
  return { svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="viz-svg">${g}</svg>`,
    tips: apps.map((a) => ({ title: a.invoice_no, rows: [
      { color: a.hard_stop ? VZ.crit : VZ.s[0], shape: a.hard_stop ? "x" : "dot", value: `${a.score} / 100`, label: `grade ${a.grade}` },
      { value: STATUS[a.status] || a.status, label: a.hard_stop ? "hard stop overrides the score" : "" }],
      note: `${shortName(a.seller)} → ${shortName(a.buyer)} · ${inr(a.amount)} · click to open` })),
    empty: apps.length ? null : "No scored applications yet" };
}

/* columns: one per application */
function drawColumns(w, items) {
  const h = 210, m = { l: 40, r: 8, t: 14, b: 30 }, pw = w - m.l - m.r, ph = h - m.t - m.b, base = m.t + ph;
  const vals = items.map((d) => d.ms), { max, step } = niceScale(Math.max(...vals, 10), 4);
  const slot = pw / Math.max(items.length, 1), cw = Math.min(24, slot * 0.62), Y = (v) => (v / max) * ph;
  let g = "";
  for (let v = 0; v <= max + 1e-9; v += step) {
    g += `<rect x="${m.l}" y="${base - Y(v)}" width="${pw}" height="1" fill="${v === 0 ? VZ.axis : VZ.grid}"/>` + svgText(m.l - 8, base - Y(v), fmtMs(v), { anchor: "end", cls: "tn" });
  }
  const every = Math.ceil(items.length / Math.max(1, Math.floor(pw / 44)));
  const top = vals.indexOf(Math.max(...vals));
  g += items.map((d, i) => {
    const cx = m.l + slot * i + slot / 2, x = cx - cw / 2, v = vals[i];
    return `<g class="vmark" data-t="${i}" data-open="${d.id}" tabindex="0" role="img" aria-label="Application ${d.id}: ${fmtMs(v)}">
      <rect x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ph}" fill="transparent"/>
      <path class="mk" d="${vbarPath(x, base, cw, Math.max(Y(v), 2))}" fill="${VZ.s[0]}"/>
      ${i === top ? svgText(cx, base - Y(v) - 10, fmtMs(v), { fill: VZ.ink, anchor: "middle", weight: 600, cls: "tn" }) : ""}
      ${i % every === 0 ? svgText(cx, h - 12, `#${d.id}`, { anchor: "middle", cls: "tn" }) : ""}
    </g>`;
  }).join("");
  return { svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="viz-svg">${g}</svg>`,
    tips: items.map((d, i) => ({ title: d.invoice_no, rows: [{ color: VZ.s[0], value: fmtMs(vals[i]), label: "upload to decision" }, { value: STATUS[d.status] || d.status, label: `application #${d.id}` }], note: "Click to open" })),
    empty: items.length ? null : "No decisions yet" };
}
const tableHtml = (head, rows) => `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${head.length}" class="muted">No data yet</td></tr>`}</table>`;

/* ---------------- lender dashboard ---------------- */
async function loadDash() {
  const lid = state.persona.lender_id;
  $("#view-dash").classList.add("refreshing");
  const [d] = await Promise.all([api(`/api/lenders/${lid}/dashboard`), loadMeta()]).finally(() => $("#view-dash").classList.remove("refreshing"));
  const k = d.kpis, f = d.funnel;
  $("#dash-eyebrow").textContent = `${d.lender.name} · Credit desk`;
  $("#dash-title").textContent = "Portfolio overview";
  $("#dash-updated").innerHTML = `<span class="dot"></span>Live · updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
  $("#dash-kpis").innerHTML = [
    ["Disbursed to SMEs", inr(k.disbursed), `${plural(k.funded_count, "invoice")} funded`],
    ["Live exposure", inr(k.exposure), `${k.live_count} awaiting buyer payment`],
    ["Approval rate", k.approval_rate == null ? "—" : Math.round(k.approval_rate * 100) + "%", k.decided ? `${f[2].count} of ${k.decided} decided` : "No decisions yet"],
    ["Fraud & risk blocked", inr(k.blocked_value), `${plural(k.blocked, "application")} stopped`],
    ["Avg. decision time", fmtMs(k.avg_decision_ms), "upload to decision"],
    ["Applications", k.applications, "received to date"],
  ].map(([l, v, s]) => `<div class="kpi"><span>${l}</span><b>${v}</b><small>${esc(s)}</small></div>`).join("");

  const recv = f[0].count;
  vizCard("viz-funnel", {
    title: "Application funnel", sub: "Every invoice received, and how far it got",
    figure: recv ? `${Math.round((f[3].count / recv) * 100)}%` : "—", figureNote: recv ? `of ${plural(recv, "application")} reached disbursal` : "no applications yet",
    draw: (w) => drawHBars(w, f.map((s) => ({ label: s.stage, value: s.count,
      display: recv ? `${s.count} · ${Math.round((s.count / recv) * 100)}%` : "0",
      tip: { title: s.stage, rows: [{ color: VZ.s[0], value: plural(s.count, "application"), label: recv ? `${Math.round((s.count / recv) * 100)}% of received` : "" }, { value: inr(s.amount), label: "invoice value" }] } })),
      { max: recv, empty: recv ? null : "Applications appear here as SMEs submit invoices" }),
    table: () => tableHtml(["Stage", "Applications", "% of received", "Invoice value"], f.map((s) => [s.stage, s.count, recv ? Math.round((s.count / recv) * 100) + "%" : "—", inr(s.amount)])),
  });

  const br = [...d.blocked_by_reason].sort((a, b) => b.amount - a.amount);
  vizCard("viz-blocked", {
    title: "Fraud & risk blocked", sub: "Invoice value stopped before disbursal, by reason",
    figure: inr(k.blocked_value), figureNote: k.blocked ? `across ${plural(k.blocked, "application")}` : "nothing blocked yet",
    draw: (w) => drawHBars(w, br.map((r) => ({ label: r.reason, value: r.amount, display: r.amount ? `${inrShort(r.amount)} · ${r.count}` : "—",
      tip: { title: r.reason, rows: [{ color: VZ.s[0], value: inr(r.amount), label: "invoice value blocked" }, { value: plural(r.count, "application") }] } })),
      { max: Math.max(...br.map((r) => r.amount)) }),
    table: () => tableHtml(["Reason", "Applications", "Invoice value"], br.map((r) => [r.reason, r.count, inr(r.amount)])),
  });

  const t = d.payment_trend;
  vizCard("viz-trend", {
    title: "Buyer payment behaviour", sub: `Average days paid after the due date, by quarter (${t.terms_days}-day terms)`,
    legend: t.series.map((s, i) => {
      const pts = s.points.filter(Boolean), n = pts.reduce((a, p) => a + p.n, 0);
      return { label: `${shortName(s.buyer)} · ${n ? Math.round(pts.reduce((a, p) => a + p.avg * p.n, 0) / n) : "—"} days avg`, color: VZ.s[i], shape: "line" };
    }),
    draw: (w) => drawLines(w, { labels: t.quarters, series: t.series, threshold: 30 }),
    table: () => tableHtml(["Quarter", ...t.series.map((s) => shortName(s.buyer))], t.quarters.map((q, i) => [q, ...t.series.map((s) => (s.points[i] ? `${s.points[i].avg} d (${s.points[i].n})` : "—"))])),
    foot: "From the buyers' repayment records. These feed the buyer factors in every risk score.",
  });

  const ex = d.exposure_by_buyer;
  vizCard("viz-exposure", {
    title: "Exposure by buyer", sub: "Funded, awaiting buyer payment",
    figure: inr(k.exposure), figureNote: ex.length ? `largest buyer ${Math.round(ex[0].share * 100)}% of book` : "no live exposure",
    draw: (w) => drawHBars(w, ex.map((x) => ({ label: shortName(x.buyer), value: x.amount, display: `${inrShort(x.amount)} · ${Math.round(x.share * 100)}%`,
      tip: { title: x.buyer, rows: [{ color: VZ.s[0], value: inr(x.amount), label: "live exposure" }, { value: `${Math.round(x.share * 100)}%`, label: "of live book" }] } })),
      { max: Math.max(0, ...ex.map((x) => x.amount)), empty: ex.length ? null : "Disbursed invoices appear here until the buyer pays" }),
    table: () => tableHtml(["Buyer", "Live exposure", "Share"], ex.map((x) => [x.buyer, inr(x.amount), Math.round(x.share * 100) + "%"])),
    after: d.upcoming.length ? `<div class="viz-after"><h4>Repayments due</h4>${d.upcoming.slice(0, 4).map((u) => {
      const days = Math.round((new Date(u.due_date) - new Date(new Date().toDateString())) / 864e5);
      return `<button class="due-row" data-open="${u.id}"><span><b>${esc(u.invoice_no)}</b><small>${esc(shortName(u.buyer_name))} · ${esc(u.due_date)}</small></span><span class="due-r"><b>${inr(u.amount)}</b><small class="${days < 0 ? "bad-t" : ""}">${days < 0 ? `${-days} days overdue` : days === 0 ? "due today" : `in ${days} days`}</small></span></button>`;
    }).join("")}</div>` : "",
  });

  vizCard("viz-scores", {
    title: "Risk scores against policy", sub: "Each application's score, and the decision band it fell in",
    legend: [{ label: "Scored application", color: VZ.s[0], shape: "dot" }, { label: "Blocked by a hard stop", color: VZ.crit, shape: "x" }],
    draw: (w) => drawScoreStrip(w, d.scores),
    table: () => tableHtml(["Invoice", "Score", "Grade", "Decision", "Hard stop"], d.scores.map((a) => [a.invoice_no, a.score, a.grade, STATUS[a.status] || a.status, a.hard_stop ? "Yes" : "No"])),
    foot: "A hard stop (duplicate, tampering, already paid, PO over-billed) declines the invoice whatever its score.",
  });

  const dt = d.decision_times.slice(-24), sec = dt.map((x) => x.ms).sort((a, b) => a - b);
  const median = sec.length ? (sec.length % 2 ? sec[(sec.length - 1) / 2] : (sec[sec.length / 2 - 1] + sec[sec.length / 2]) / 2) : null;
  vizCard("viz-time", {
    title: "Decision time", sub: "Upload to decision, per application",
    figure: fmtMs(median), figureNote: median == null ? "no decisions yet" : "median",
    draw: (w) => drawColumns(w, dt),
    table: () => tableHtml(["Application", "Invoice", "Time", "Decision"], dt.map((x) => [`#${x.id}`, x.invoice_no, fmtMs(x.ms), STATUS[x.status] || x.status])),
    foot: "Covers reading every document, all checks, the duplicate shield and scoring.",
  });

  const row = (a, right) => `<button class="mini" data-open="${a.id}"><span><b>${esc(a.invoice_no)}</b><small>${esc(a.seller_name)} → ${esc(a.buyer_name)}</small></span><span class="mini-r">${right}</span></button>`;
  $("#dash-attention").innerHTML = d.attention.length ? d.attention.map((a) => row(a, `${pill(a.status)}<b>${inr(a.amount)}</b>`)).join("")
    : `<p class="muted">You're all caught up. New verified applications land here.</p>`;
  $("#dash-blocked").innerHTML = d.blocked.length ? d.blocked.map((a) => row(a, `<b class="bad-t">${inr(a.amount)}</b>`).replace("</small></span>", `</small><small class="bad-t">${esc((a.stop || "Declined on risk").split(":")[0])}</small></span>`)).join("")
    : `<p class="muted">Nothing blocked yet.</p>`;
  const c = state.meta.chain;
  $("#dash-network").innerHTML = `<dl class="kv kv-wide">
    <dt>Status</dt><dd><span class="dot ${c.mode === "hardhat" ? "" : "off"}" style="display:inline-block;margin-right:6px"></span>${c.mode === "hardhat" ? "Synced" : "Offline"}</dd>
    <dt>Network</dt><dd>${esc(c.network)}</dd><dt>Registry contract</dt><dd class="hash">${esc(c.contract)}</dd>
    <dt>Latest block</dt><dd>${c.block}</dd><dt>Audit anchors</dt><dd>${c.anchors}</dd>
    <dt>Lenders in network</dt><dd>${state.meta.lenders.map((l) => esc(l.name)).join(", ")}</dd></dl>`;
  $$("#view-dash .mini[data-open]").forEach((b) => (b.onclick = () => openApp(+b.dataset.open)));
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
