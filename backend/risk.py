"""Explainable risk scorecard -> decision -> risk-based pricing."""
from datetime import date

from core import fmt_inr, today


def _d(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def buyer_profile(c, buyer_gstin):
    rows = c.execute("SELECT * FROM payment_history WHERE buyer_gstin=?", (buyer_gstin,)).fetchall()
    paid = [r for r in rows if r["paid_date"]]
    delays = [(_d(r["paid_date"]) - _d(r["due_date"])).days for r in paid]
    defaults = [r for r in rows if not r["paid_date"] and _d(r["due_date"]) and (today() - _d(r["due_date"])).days > 90]
    outstanding = [r for r in rows if not r["paid_date"] and r not in defaults]
    return {"invoices": len(rows), "paid": len(paid),
            "avg_days_late": round(sum(max(d, 0) for d in delays) / len(delays), 1) if delays else None,
            "late_ratio": round(sum(1 for d in delays if d > 7) / len(delays), 2) if delays else None,
            "defaults": len(defaults), "defaulted_amount": sum(r["amount"] for r in defaults),
            "outstanding": sum(r["amount"] for r in outstanding)}


def seller_profile(c, seller_gstin, buyer_gstin):
    rows = c.execute("SELECT * FROM payment_history WHERE seller_gstin=?", (seller_gstin,)).fetchall()
    to_buyer = [r["amount"] for r in rows if r["buyer_gstin"] == buyer_gstin]
    open_all = sum(r["amount"] for r in rows if not r["paid_date"])
    open_buyer = sum(r["amount"] for r in rows if not r["paid_date"] and r["buyer_gstin"] == buyer_gstin)
    return {"avg_invoice_to_buyer": sum(to_buyer) / len(to_buyer) if to_buyer else None,
            "invoices_to_buyer": len(to_buyer), "open_receivables": open_all,
            "buyer_concentration": round(open_buyer / open_all, 2) if open_all else 0}


def score(c, inv, checks, dup, forensic, confirmed: bool, buyer_name: str):
    bp = buyer_profile(c, inv.get("buyer_gstin"))
    sp = seller_profile(c, inv.get("seller_gstin"), inv.get("buyer_gstin"))
    factors = []

    def add(group, label, pts, detail):
        factors.append({"group": group, "label": label, "points": pts, "detail": detail})

    # buyer payment behaviour
    if bp["invoices"] == 0:
        add("Buyer", "No payment history", -10, "Thin file: no past invoices from this buyer on record.")
    else:
        late = bp["avg_days_late"] or 0
        pts = 10 if late <= 3 else 4 if late <= 15 else -5 if late <= 30 else -12
        add("Buyer", "Average payment delay", pts, f"{buyer_name} pays {late:.0f} days after due date on average ({bp['paid']} paid invoices).")
        if bp["late_ratio"] is not None:
            lr = bp["late_ratio"]
            add("Buyer", "Share of late payments", 3 if lr < 0.1 else -8 if lr > 0.4 else 0, f"{lr * 100:.0f}% of invoices paid more than 7 days late.")
        if bp["defaults"]:
            add("Buyer", "Past defaults", -20, f"{bp['defaults']} invoice(s) unpaid 90+ days past due (₹{fmt_inr(bp['defaulted_amount'])}).")
        if bp["invoices"] >= 10:
            add("Buyer", "Track record", 3, f"{bp['invoices']} invoices of history.")
    # receivables
    amt = inv.get("total") or 0
    if sp["avg_invoice_to_buyer"]:
        ratio = amt / sp["avg_invoice_to_buyer"]
        add("Receivables", "Invoice size vs. history", -10 if ratio > 2.5 else 3,
            f"{ratio:.1f}× the seller's average invoice to this buyer (₹{fmt_inr(sp['avg_invoice_to_buyer'])}).")
    if sp["buyer_concentration"] > 0.6:
        add("Receivables", "Buyer concentration", -5, f"{sp['buyer_concentration'] * 100:.0f}% of seller's open receivables sit with this buyer.")
    due = _d(inv.get("due_date"))
    if due:
        tenor = (due - today()).days
        add("Receivables", "Tenor", 2 if tenor <= 60 else -5 if tenor > 90 else 0, f"{tenor} days until the buyer must pay.")
    # verification
    fails = [k for k in checks if k["status"] == "fail"]
    warns = [k for k in checks if k["status"] == "warn"]
    if fails:
        add("Verification", "Failed checks", -25, "Failed: " + ", ".join(k["title"] for k in fails) + ".")
    if warns:
        add("Verification", "Warnings", -min(15, 5 * len(warns)), "Warnings: " + ", ".join(k["title"] for k in warns) + ".")
    if not fails and not warns:
        add("Verification", "All checks passed", 5, f"{len(checks)}/{len(checks)} verification checks passed.")
    if forensic["verdict"] in ("tampered", "suspicious"):
        add("Verification", "Document forensics", -15 if forensic["verdict"] == "tampered" else -5, forensic["flags"][0]["title"] + ".")
    if dup["verdict"] == "suspect":
        add("Duplicate", "Near-duplicate pattern", -10, "Looks like a renumbered or repeated invoice.")
    if confirmed:
        add("Buyer", "Buyer confirmed invoice on-chain", 12, "The buyer cryptographically acknowledged this debt.")

    raw = 60 + sum(f["points"] for f in factors)
    s = max(0, min(100, raw))
    grade = "A" if s >= 80 else "B" if s >= 65 else "C" if s >= 50 else "D"

    # decision
    hard_stops = []
    if dup["verdict"] == "duplicate":
        hard_stops.append("Duplicate financing detected: " + next(l["detail"] for l in dup["layers"] if l["status"] == "fail"))
    paid = next((k for k in checks if k["id"] == "recon" and k.get("already_paid")), None)
    if paid:
        hard_stops.append("Invoice already paid by the buyer: " + paid["detail"].split(". ")[0].replace("Invoice already paid: ", "") + ".")
    ledger_fail = next((k for k in checks if k["id"] == "po_ledger" and k["status"] == "fail"), None)
    if ledger_fail:
        hard_stops.append("Purchase order already billed: " + ledger_fail["detail"])
    if forensic["verdict"] == "tampered" and fails:
        hard_stops.append("Document shows signs of tampering and does not match supporting documents.")
    if hard_stops:
        decision = "REJECTED"
    elif s >= 75 and not fails:
        decision = "AUTO_APPROVED"
    elif s >= 45:
        decision = "MANUAL_REVIEW"
    else:
        decision = "REJECTED"

    # pricing
    terms = {"A": (0.90, 0.110), "B": (0.85, 0.135), "C": (0.75, 0.165), "D": (0.0, 0.0)}[grade]
    tenor = max(1, (due - today()).days) if due else 60
    offer = None
    if decision != "REJECTED" and terms[0] > 0:
        advance = amt * terms[0]
        discount = advance * terms[1] * tenor / 365
        processing = advance * 0.0025
        offer = {"advance_rate": terms[0], "annual_rate": terms[1], "tenor_days": tenor, "advance": round(advance, 2),
                 "discount_fee": round(discount, 2), "processing_fee": round(processing, 2),
                 "net_disbursal": round(advance - discount - processing, 2)}

    memo = build_memo(inv, buyer_name, decision, s, grade, factors, hard_stops, offer, checks)
    return {"score": s, "grade": grade, "base": 60, "factors": factors, "buyer_profile": bp, "seller_profile": sp,
            "decision": decision, "hard_stops": hard_stops, "offer": offer, "memo": memo}


def build_memo(inv, buyer_name, decision, s, grade, factors, hard_stops, offer, checks):
    verb = {"AUTO_APPROVED": "Auto-approve", "MANUAL_REVIEW": "Send to manual review", "REJECTED": "Reject"}[decision]
    passed = sum(1 for k in checks if k["status"] == "pass")
    parts = [f"{verb}. Invoice {inv.get('invoice_no')} for ₹{fmt_inr(inv.get('total') or 0)} to {buyer_name}: "
             f"{passed} of {len(checks)} verification checks passed; risk score {s}/100 (grade {grade})."]
    if hard_stops:
        parts.append(" ".join(hard_stops))
    pos = sorted([f for f in factors if f["points"] > 0], key=lambda f: -f["points"])[:2]
    neg = sorted([f for f in factors if f["points"] < 0], key=lambda f: f["points"])[:2]
    if pos:
        parts.append("Strengths: " + " ".join(f["detail"] for f in pos))
    if neg:
        parts.append("Concerns: " + " ".join(f["detail"] for f in neg))
    if offer:
        parts.append(f"Offer: {offer['advance_rate'] * 100:.0f}% advance (₹{fmt_inr(offer['advance'])}) at {offer['annual_rate'] * 100:.1f}% p.a. "
                     f"for {offer['tenor_days']} days; net disbursal ₹{fmt_inr(offer['net_disbursal'])}.")
    return " ".join(parts)
