"""Invoice <-> payment evidence <-> statement of account.
  Invoice:            what was charged
  Bank statement:     what was actually paid  (in production: pulled via the Account Aggregator framework)
  Statement of account: what the seller claims is still outstanding
"""
import re
from datetime import date

from core import fmt_inr

BANK_ROW = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([\d,]+\.\d{2}|-)\s+([\d,]+\.\d{2}|-)\s+([\d,]+\.\d{2})$")
SOA_ROW = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([\d,]+\.\d{2}|-)\s+([\d,]+\.\d{2}|-)$")
KV = re.compile(r"^([A-Za-z][A-Za-z0-9 .%@/]*?)\s*:\s*(.+)$")


def _n(s):
    return 0.0 if s in (None, "-", "") else float(str(s).replace(",", ""))


def _norm(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _d(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def parse_ledger(text: str, doc_type: str) -> dict:
    rows, kv, in_rows = [], {}, False
    for line in (l.strip() for l in text.splitlines() if l.strip()):
        low = line.lower()
        if low.startswith("date "):
            in_rows = True
            continue
        if low.startswith("closing balance"):
            in_rows = False
        if in_rows:
            m = (BANK_ROW if doc_type == "bank" else SOA_ROW).match(line)
            if m:
                g = m.groups()
                rows.append({"date": g[0], "narration": g[1].strip(), "debit": _n(g[2]), "credit": _n(g[3]),
                             **({"balance": _n(g[4])} if doc_type == "bank" else {})})
            continue
        m = KV.match(line)
        if m:
            kv.setdefault(m.group(1).strip().lower(), m.group(2).strip())
    out = {"doc_type": doc_type, "items": rows, "period": kv.get("period"),
           "opening_balance": _n(kv.get("opening balance"))}
    if doc_type == "bank":
        out.update(account_holder=kv.get("account holder"), account_no=kv.get("account no"), source=kv.get("source"),
                   closing_balance=_n(kv.get("closing balance")))
    else:
        out.update(supplier=kv.get("supplier"), supplier_gstin=(kv.get("supplier gstin") or "").upper(),
                   customer=kv.get("customer"), customer_gstin=(kv.get("customer gstin") or "").upper(),
                   closing_outstanding=_n(kv.get("closing balance outstanding")))
    req = ["items", "period", "closing_balance" if doc_type == "bank" else "closing_outstanding"]
    out["confidence"] = round(sum(1 for k in req if out.get(k)) / len(req), 2)
    return out


def check(inv: dict, bank: dict | None, soa: dict | None, buyer_name: str):
    """Returns a check dict (same shape as verify._check) or None when no payment evidence was supplied."""
    from verify import _check, _conf

    if not bank and not soa:
        return None
    issues, ev, rows = [], [], []
    already_paid = None
    inv_no, total = inv.get("invoice_no"), float(inv.get("total") or 0)
    buyer_key = _norm((buyer_name or "").split()[0]) if buyer_name else ""
    inv_d = _d(inv.get("invoice_date"))

    buyer_credits = [t for t in (bank or {}).get("items", []) if t["credit"] and buyer_key and buyer_key in _norm(t["narration"])]

    # 1. has this invoice already been paid?
    if bank:
        for t in buyer_credits:
            ref_match = _norm(inv_no) and _norm(inv_no) in _norm(t["narration"])
            amt_match = abs(t["credit"] - total) <= 1 and inv_d and _d(t["date"]) and _d(t["date"]) >= inv_d
            if ref_match or amt_match:
                already_paid = t
                issues.append(f"Invoice already paid: ₹{fmt_inr(t['credit'])} credited on {t['date']} from {buyer_name} "
                              f"({'narration cites ' + inv_no if ref_match else 'exact amount after invoice date'}).")
                break
        if not already_paid:
            ev.append(f"No payment of this invoice in the bank statement ({bank.get('period')}); {len(buyer_credits)} other credit(s) from {buyer_name}.")

    # 2. statement of account: internal arithmetic
    if soa:
        deb = sum(r["debit"] for r in soa["items"])
        cred = sum(r["credit"] for r in soa["items"])
        computed = soa["opening_balance"] + deb - cred
        if abs(computed - soa["closing_outstanding"]) > 1:
            issues.append(f"Statement of account doesn't add up: opening ₹{fmt_inr(soa['opening_balance'])} + invoices ₹{fmt_inr(deb)} − payments ₹{fmt_inr(cred)} = ₹{fmt_inr(computed)}, "
                          f"but it claims ₹{fmt_inr(soa['closing_outstanding'])} outstanding.")
        listed = any(_norm(inv_no) in _norm(r["narration"]) for r in soa["items"] if r["debit"])
        if not listed:
            issues.append(f"Invoice {inv_no} does not appear on the seller's own statement of account.")
        else:
            ev.append(f"Invoice {inv_no} is listed on the statement of account as outstanding.")

    # 3. payments: bank vs statement
    if bank and soa:
        soa_pay = [r for r in soa["items"] if r["credit"]]
        used = set()
        for t in buyer_credits:
            m = next((i for i, r in enumerate(soa_pay) if i not in used and abs(r["credit"] - t["credit"]) <= 1
                      and _d(r["date"]) and abs((_d(r["date"]) - _d(t["date"])).days) <= 3), None)
            if m is None:
                rows.append({"line": f"{t['date']} bank credit", "invoice": f"₹{fmt_inr(t['credit'])}", "reference": "missing from statement",
                             "status": "fail", "note": t["narration"]})
            else:
                used.add(m)
                rows.append({"line": f"{t['date']} bank credit", "invoice": f"₹{fmt_inr(t['credit'])}", "reference": f"on statement {soa_pay[m]['date']}",
                             "status": "pass", "note": ""})
        for i, r in enumerate(soa_pay):
            if i not in used:
                rows.append({"line": f"{r['date']} statement payment", "invoice": f"₹{fmt_inr(r['credit'])}", "reference": "not found in bank",
                             "status": "fail", "note": r["narration"]})
        omitted = [r for r in rows if r["reference"] == "missing from statement"]
        if omitted:
            issues.append(f"Statement of account omits {len(omitted)} payment(s) the bank shows were received: " +
                          ", ".join(f"{r['invoice']} on {r['line'].split()[0]}" for r in omitted) + ".")
        # 4. claimed vs evidenced outstanding
        evidenced = soa["opening_balance"] + sum(r["debit"] for r in soa["items"]) - sum(t["credit"] for t in buyer_credits)
        overstated = soa["closing_outstanding"] - evidenced
        if overstated > 1:
            issues.append(f"Seller claims ₹{fmt_inr(soa['closing_outstanding'])} outstanding; invoices minus payments in the bank statement = ₹{fmt_inr(evidenced)}. "
                          f"Overstated by ₹{fmt_inr(overstated)}.")
        else:
            ev.append(f"Claimed outstanding ₹{fmt_inr(soa['closing_outstanding'])} reconciles to invoices minus bank-evidenced payments.")
    else:
        overstated = 0.0

    status = "fail" if issues else "pass"
    if status == "pass":
        detail = f"Charged, paid and claimed amounts reconcile: invoice unpaid, every payment from {buyer_name} in the bank appears on the statement, and the claimed outstanding is supported."
    else:
        detail = " ".join(issues)
    sources = [s for s, d in (("invoice", inv), ("bank statement", bank), ("statement of account", soa)) if d]
    c = _check("recon", "Payment & statement reconciliation", status, detail,
               ev + ([{"table": rows, "headers": ["Entry", "Amount", "Matched to", "Narration"]}] if rows else []),
               _conf(inv, bank, soa), sources, max(already_paid["credit"] if already_paid else 0, overstated))
    c["already_paid"] = bool(already_paid)
    return c
