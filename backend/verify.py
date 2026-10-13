"""Three-way match (Invoice <-> Purchase Order <-> Goods Receipt Note) plus document sanity checks.
Every check carries: the rule applied (id + version + plain-English definition), a confidence level,
quantified findings in rupees, and the evidence behind them."""
import re
from datetime import date

from rapidfuzz import fuzz

from core import fmt_inr, today

GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")

RULES = {
    "math": ("R-ARITH", "1.2", "Each line: qty × unit price = amount. Lines sum to subtotal. Subtotal × GST rate = tax. Subtotal + tax = total (±₹1)."),
    "parties": ("R-KYC", "1.0", "Seller and buyer GSTINs are well-formed and belong to KYC-verified counterparties."),
    "po": ("R-3WM-PO", "2.1", "Invoice cites the PO; same buyer and seller; every line is on the PO (description match ≥80%); qty ≤ ordered; unit price within 0.5% of PO."),
    "grn": ("R-3WM-GRN", "2.1", "Delivery note references the PO, is signed by the receiver, and received qty ≥ invoiced qty on every line."),
    "dates": ("R-DATES", "1.1", "PO date ≤ invoice date; invoice not in the future; due date after invoice date and not yet passed; goods received before invoicing."),
    "recon": ("R-RECON", "1.0", "Invoice must not already be paid in the bank statement; statement of account must add up, include every payment the bank shows, and its claimed outstanding must equal invoices minus bank-evidenced payments."),
    "po_ledger": ("R-PO-LEDGER", "1.0", "Cumulative value invoiced against a PO (this lender's books) may not exceed the PO value."),
}


def _d(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _check(cid, title, status, detail, evidence=None, confidence=1.0, sources=None, discrepancy=0.0):
    rid, ver, text = RULES[cid]
    return {"id": cid, "title": title, "status": status, "detail": detail, "evidence": evidence or [],
            "rule": {"id": rid, "version": ver, "definition": text}, "confidence": round(confidence, 2),
            "sources": sources or [], "discrepancy_inr": round(discrepancy, 2)}


def _match_item(desc, items):
    best, score = None, 0
    for it in items:
        s = fuzz.token_set_ratio(desc.lower(), it["description"].lower())
        if s > score:
            best, score = it, s
    return (best, score) if score >= 80 else (None, score)


def _conf(*docs):
    vals = [float(d.get("confidence") or 0) for d in docs if d]
    return min(vals) if vals else 0.0


def reconcile_lines(inv, po, grn):
    """Line-by-line reconciliation of invoice vs PO vs delivery, with rupee impact."""
    rows = []
    for n, it in enumerate(inv.get("items") or [], 1):
        pm, ps = _match_item(it["description"], (po or {}).get("items") or []) if po else (None, 0)
        gm, gs = _match_item(it["description"], (grn or {}).get("items") or []) if grn else (None, 0)
        row = {"line": n, "description": it["description"], "inv_qty": it["qty"], "inv_price": it["unit_price"],
               "inv_amount": it["amount"], "po_qty": pm["qty"] if pm else None, "po_price": pm["unit_price"] if pm else None,
               "received_qty": gm["received_qty"] if gm else None, "match_score": min([s for s in (ps if po else 100, gs if grn else 100)]),
               "issues": [], "excess_inr": 0.0}
        if po and not pm:
            row["issues"].append("not on the purchase order")
            row["excess_inr"] = it["amount"]
        if pm:
            allowed_qty = min(it["qty"], pm["qty"], gm["received_qty"] if gm else pm["qty"])
            row["excess_inr"] = max(0.0, it["amount"] - allowed_qty * pm["unit_price"])
            if it["qty"] > pm["qty"]:
                row["issues"].append(f"billed {it['qty']} units, PO ordered {pm['qty']} (+₹{fmt_inr((it['qty'] - pm['qty']) * pm['unit_price'])})")
            if abs(it["unit_price"] - pm["unit_price"]) > 0.005 * pm["unit_price"]:
                delta = (it["unit_price"] - pm["unit_price"]) * min(it["qty"], pm["qty"])
                qty_note = f"delivery quantity matches ({gm['received_qty']}) but " if gm and gm["received_qty"] >= it["qty"] else ""
                row["issues"].append(f"{qty_note}unit price ₹{fmt_inr(it['unit_price'])} vs PO ₹{fmt_inr(pm['unit_price'])} ({'+' if delta >= 0 else '−'}₹{fmt_inr(abs(delta))})")
        if grn and not gm:
            row["issues"].append("no delivery recorded")
        elif gm and gm["received_qty"] < it["qty"]:
            row["issues"].append(f"only {gm['received_qty']} received, {it['qty'] - gm['received_qty']} never delivered")
        rows.append(row)
    total_excess = sum(r["excess_inr"] for r in rows)
    rate = (inv.get("tax_rate") or 0) / 100
    bad = [r for r in rows if r["issues"]]
    if bad:
        parts = [f"Line {r['line']} '{r['description']}': " + "; ".join(r["issues"]) + "." for r in bad]
        summary = (f"Invoice is ₹{fmt_inr(total_excess)} (₹{fmt_inr(total_excess * (1 + rate))} incl. GST) above what the PO and delivery support. "
                   + " ".join(parts))
    else:
        summary = f"All {len(rows)} lines reconcile to the PO and delivery note; no excess billing."
    return {"rows": rows, "excess_inr": round(total_excess, 2), "excess_incl_tax": round(total_excess * (1 + rate), 2), "summary": summary}


def three_way_match(inv: dict, po: dict | None, grn: dict | None, companies: dict, po_ledger: dict) -> list:
    checks = []
    recon = reconcile_lines(inv, po, grn)

    # 1. arithmetic
    items = inv.get("items") or []
    line_errs = [f"{it['description']}: {it['qty']} × {fmt_inr(it['unit_price'])} ≠ {fmt_inr(it['amount'])}"
                 for it in items if abs(it["qty"] * it["unit_price"] - it["amount"]) > 1]
    sub = sum(it["amount"] for it in items)
    total_ok = inv.get("subtotal") is not None and abs(sub - inv["subtotal"]) <= 1 and \
        abs((inv.get("subtotal") or 0) + (inv.get("tax") or 0) - (inv.get("total") or 0)) <= 1
    tax_ok = not inv.get("tax_rate") or abs((inv.get("subtotal") or 0) * inv["tax_rate"] / 100 - (inv.get("tax") or 0)) <= 1
    if line_errs or not total_ok or not tax_ok:
        diff = (inv.get("total") or 0) - sub * (1 + (inv.get("tax_rate") or 0) / 100)
        checks.append(_check("math", "Invoice arithmetic", "fail",
                             f"Stated total differs from the line items by ₹{fmt_inr(abs(diff))}.",
                             line_errs or [f"Lines sum to ₹{fmt_inr(sub)}, subtotal ₹{fmt_inr(inv.get('subtotal') or 0)}, total ₹{fmt_inr(inv.get('total') or 0)}"],
                             _conf(inv), ["invoice"], abs(diff)))
    else:
        checks.append(_check("math", "Invoice arithmetic", "pass",
                             f"{len(items)} lines sum to ₹{fmt_inr(sub)}; GST {inv.get('tax_rate') or 0:.0f}% = ₹{fmt_inr(inv.get('tax') or 0)}; total ₹{fmt_inr(inv.get('total') or 0)}.",
                             confidence=_conf(inv), sources=["invoice"]))

    # 2. counterparties
    ev, status = [], "pass"
    for role in ("seller", "buyer"):
        g = inv.get(f"{role}_gstin") or ""
        if not GSTIN_RE.match(g):
            status = "fail"
            ev.append(f"{role.title()} GSTIN '{g}' is not a valid GSTIN format")
        elif g not in companies:
            status = "warn" if status == "pass" else status
            ev.append(f"{role.title()} {g} is not a KYC-verified counterparty")
        else:
            ev.append(f"{role.title()}: {companies[g]['name']} ({g}), KYC verified")
    checks.append(_check("parties", "Counterparty identity (GSTIN + KYC)", status,
                         "Both parties have valid GSTINs and are KYC-verified." if status == "pass" else "Counterparty identity problem.",
                         ev, _conf(inv), ["invoice", "KYC registry"]))

    # 3. PO
    if not po:
        checks.append(_check("po", "Purchase order match", "warn", "No purchase order provided, so we can't confirm the buyer ordered these goods.",
                             confidence=_conf(inv), sources=["invoice"]))
    else:
        ev, status = [], "pass"
        if (inv.get("po_number") or "").upper() != (po.get("po_number") or "").upper():
            status = "fail"
            ev.append(f"Invoice cites PO '{inv.get('po_number')}', document is PO '{po.get('po_number')}'")
        if po.get("buyer_gstin") != inv.get("buyer_gstin") or po.get("seller_gstin") != inv.get("seller_gstin"):
            status = "fail"
            ev.append("Buyer/seller on PO differ from invoice")
        rows = []
        po_excess = 0.0
        for r in recon["rows"]:
            po_issues = [i for i in r["issues"] if "PO" in i or "purchase order" in i]
            st = "fail" if po_issues else "pass"
            if st == "fail":
                status = "fail"
                po_excess += r["excess_inr"]
            rows.append({"line": f"{r['line']}. {r['description']}", "invoice": f"{r['inv_qty']} @ {fmt_inr(r['inv_price'])}",
                         "reference": f"{r['po_qty']} @ {fmt_inr(r['po_price'])}" if r["po_qty"] is not None else "not on PO",
                         "status": st, "note": "; ".join(po_issues)})
        avg_match = sum(r["match_score"] for r in recon["rows"]) / max(1, len(recon["rows"])) / 100
        detail = (f"Every invoice line matches PO {po.get('po_number')} on item, quantity and price." if status == "pass"
                  else recon["summary"] if po_excess else "Invoice does not match the purchase order.")
        checks.append(_check("po", "Purchase order match", status, detail, ev + ([{"table": rows}] if rows else []),
                             _conf(inv, po) * avg_match, ["invoice", "purchase order"], po_excess))

    # 4. delivery
    if not grn:
        checks.append(_check("grn", "Proof of delivery (GRN)", "warn", "No goods receipt note provided, so delivery isn't confirmed.",
                             confidence=_conf(inv), sources=["invoice"]))
    else:
        ev, status, rows = [], "pass", []
        if po and (grn.get("po_number") or "").upper() != (po.get("po_number") or "").upper():
            status = "fail"
            ev.append(f"GRN references PO '{grn.get('po_number')}', not '{po.get('po_number')}'")
        if not grn.get("received_by"):
            status = "warn"
            ev.append("GRN has no receiver signature/name")
        undelivered = 0.0
        for r in recon["rows"]:
            st = "pass"
            note = ""
            if r["received_qty"] is None:
                st, note = "fail", "no delivery recorded"
                undelivered += r["inv_amount"]
            elif r["received_qty"] < r["inv_qty"]:
                st = "fail"
                missing = r["inv_qty"] - r["received_qty"]
                undelivered += missing * r["inv_price"]
                note = f"{missing} units billed but never delivered (₹{fmt_inr(missing * r['inv_price'])})"
            if st == "fail":
                status = "fail"
            rows.append({"line": f"{r['line']}. {r['description']}", "invoice": str(r["inv_qty"]),
                         "reference": f"{r['received_qty']} received" if r["received_qty"] is not None else "not received", "status": st, "note": note})
        detail = (f"Buyer's stores confirmed receipt of all invoiced goods ({grn.get('received_by')}, {grn.get('grn_no')})." if status == "pass"
                  else f"₹{fmt_inr(undelivered)} of the invoice is for goods the buyer never received." if status == "fail" and undelivered
                  else "Delivery note problem." if status == "fail" else "Delivery only partly confirmed.")
        avg_match = sum(r["match_score"] for r in recon["rows"]) / max(1, len(recon["rows"])) / 100
        checks.append(_check("grn", "Proof of delivery (GRN)", status, detail, ev + ([{"table": rows}] if rows else []),
                             _conf(inv, grn) * avg_match, ["invoice", "delivery note"], undelivered))

    # 5. dates
    ev, status = [], "pass"
    inv_d, due_d = _d(inv.get("invoice_date")), _d(inv.get("due_date"))
    if not inv_d or not due_d:
        status = "fail"
        ev.append("Invoice or due date missing/unreadable")
    else:
        if inv_d > today():
            status = "fail"
            ev.append(f"Invoice dated in the future ({inv_d})")
        if due_d <= inv_d:
            status = "fail"
            ev.append("Due date is not after invoice date")
        if due_d < today():
            status = "fail"
            ev.append(f"Invoice already overdue (due {due_d})")
        if po and _d(po.get("po_date")) and inv_d < _d(po.get("po_date")):
            status = "fail"
            ev.append("Invoice is dated before the purchase order")
        if grn and _d(grn.get("grn_date")) and inv_d < _d(grn.get("grn_date")):
            status = "warn" if status == "pass" else status
            ev.append("Invoice raised before goods were received")
        if status == "pass":
            ev.append(f"PO {po.get('po_date') if po else '—'} → delivered {grn.get('grn_date') if grn else '—'} → invoiced {inv_d} → due {due_d}")
    checks.append(_check("dates", "Date consistency", status,
                         f"Order → delivery → invoice → due date sequence is consistent; {(due_d - today()).days} days to maturity." if status == "pass" and due_d else "Date problems found.",
                         ev, _conf(inv, po, grn), ["invoice", "purchase order", "delivery note"]))

    # 6. PO ledger
    if po and po.get("subtotal"):
        billed = po_ledger.get("billed", 0)
        after = billed + (inv.get("subtotal") or 0)
        cap = po["subtotal"]
        if billed > 0 and after > cap * 1.001:
            checks.append(_check("po_ledger", "PO billing ledger", "fail",
                                 f"PO {po['po_number']} was already billed ₹{fmt_inr(billed)} of ₹{fmt_inr(cap)}. This invoice takes it to ₹{fmt_inr(after)} ({after / cap * 100:.0f}%), ₹{fmt_inr(after - cap)} over the order value.",
                                 [f"Earlier invoice(s): {', '.join(po_ledger.get('invoices', []))}"], _conf(po), ["purchase order", "lender ledger"], after - cap))
        else:
            checks.append(_check("po_ledger", "PO billing ledger", "pass",
                                 f"₹{fmt_inr(after)} of ₹{fmt_inr(cap)} billed against PO {po['po_number']} ({after / cap * 100:.0f}%).",
                                 confidence=_conf(po), sources=["purchase order", "lender ledger"]))
    return checks
