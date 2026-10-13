"""Seed KYC'd companies, buyer payment histories, and generate the demo scenario PDFs."""
import io
import random
from datetime import datetime, timedelta

from pypdf import PdfWriter
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from core import SAMPLES, db, fmt_inr, today

ACME = ("27AAACA1234F1Z5", "Acme Precision Parts Pvt Ltd", "Pune, Maharashtra", "TallyPrime 4.1")
GANESH = ("24AAFCS5678K1Z3", "Shree Ganesh Textiles", "Surat, Gujarat", "Zoho Books")
ZENITH = ("29AABCZ5678K1Z2", "Zenith Motors Ltd", "Bengaluru, Karnataka", None)
ORBIT = ("07AACCO4321M1Z8", "Orbit Retail Ltd", "New Delhi", None)
NOVA = ("33AAGCN9876P1Z1", "Nova Electronics Ltd", "Chennai, Tamil Nadu", None)

COMPANIES = [(*ACME, "seller", None), (*GANESH, "seller", None), (*ZENITH, "buyer", 3), (*ORBIT, "buyer", 4), (*NOVA, "buyer", 5)]


def seed_db():
    rnd = random.Random(42)
    t = today()
    with db() as c:
        c.execute("DELETE FROM companies")
        c.execute("DELETE FROM payment_history")
        for g, name, city, prod, role, acct in COMPANIES:
            c.execute("INSERT INTO companies VALUES(?,?,?,?,?,?)", (g, name, role, city, prod, acct))
        profiles = [  # seller, buyer, count, amount range, delay range, defaults, open
            (ACME, ZENITH, 18, (380000, 720000), (0, 7), 0, [400000, 500000]),
            (ACME, ORBIT, 14, (250000, 450000), (18, 62), 0, [300000, 350000]),
            (ACME, NOVA, 7, (150000, 300000), (5, 40), 1, [200000]),
            (GANESH, ORBIT, 10, (90000, 200000), (25, 55), 0, []),
        ]
        n = 1
        for seller, buyer, count, (lo, hi), (dlo, dhi), defaults, open_amts in profiles:
            for i in range(count):
                inv_date = t - timedelta(days=540 - i * (480 // count) - rnd.randint(0, 10))
                due = inv_date + timedelta(days=60)
                paid = due + timedelta(days=rnd.randint(dlo, dhi))
                amt = round(rnd.uniform(lo, hi), -3)
                is_default = i >= count - defaults
                c.execute("INSERT INTO payment_history(seller_gstin,buyer_gstin,invoice_no,amount,invoice_date,due_date,paid_date) VALUES(?,?,?,?,?,?,?)",
                          (seller[0], buyer[0], f"HIST-{n:04d}", amt, inv_date.isoformat(), due.isoformat(),
                           None if is_default else paid.isoformat()))
                if is_default:  # push default far enough into the past
                    c.execute("UPDATE payment_history SET due_date=? WHERE invoice_no=?", ((t - timedelta(days=150)).isoformat(), f"HIST-{n:04d}"))
                n += 1
            for amt in open_amts:
                d = t - timedelta(days=rnd.randint(10, 40))
                c.execute("INSERT INTO payment_history(seller_gstin,buyer_gstin,invoice_no,amount,invoice_date,due_date,paid_date) VALUES(?,?,?,?,?,?,?)",
                          (seller[0], buyer[0], f"HIST-{n:04d}", amt, d.isoformat(), (d + timedelta(days=60)).isoformat(), None))
                n += 1


# ---------------- PDF generation ----------------
INK = HexColor("#122330")
ACCENT = HexColor("#0b6e5f")


def _pdf_date(d: datetime):
    return d.strftime("D:%Y%m%d%H%M%S+05'30'")


def render(doc_type, f, style=1):
    buf = io.BytesIO()
    cv = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    font, bold = ("Helvetica", "Helvetica-Bold") if style == 1 else ("Times-Roman", "Times-Bold")
    band = ACCENT if style == 1 else INK
    issuer = f["seller_name"] if doc_type == "invoice" else f["buyer_name"]
    title = {"invoice": "TAX INVOICE", "po": "PURCHASE ORDER", "grn": "GOODS RECEIPT NOTE"}[doc_type]
    cv.setFillColor(band)
    cv.rect(0, H - 90, W, 90, fill=1, stroke=0)
    cv.setFillColor(HexColor("#ffffff"))
    cv.setFont(bold, 16)
    cv.drawString(40, H - 45, issuer.upper())
    cv.setFont(font, 9)
    cv.drawString(40, H - 62, f.get("issuer_city", ""))
    cv.setFont(bold, 13)
    cv.drawRightString(W - 40, H - 45, title)
    cv.setFillColor(INK)

    y = H - 125
    def kv(k, v):
        nonlocal y
        cv.setFont(bold, 10)
        cv.drawString(50, y, f"{k}:")
        cv.setFont(font, 10)
        cv.drawString(170, y, str(v))
        y -= 17

    if doc_type == "invoice":
        kv("Invoice No", f["invoice_no"]); kv("Invoice Date", f["invoice_date"]); kv("Due Date", f["due_date"])
        kv("PO Number", f["po_number"]); kv("Seller", f["seller_name"]); kv("Seller GSTIN", f["seller_gstin"])
        kv("Buyer", f["buyer_name"]); kv("Buyer GSTIN", f["buyer_gstin"]); kv("Payment Terms", "Net 60 days")
    elif doc_type == "po":
        kv("PO Number", f["po_number"]); kv("PO Date", f["po_date"]); kv("Buyer", f["buyer_name"])
        kv("Buyer GSTIN", f["buyer_gstin"]); kv("Supplier", f["seller_name"]); kv("Supplier GSTIN", f["seller_gstin"])
        kv("Payment Terms", "Net 60 days")
    else:
        kv("GRN No", f["grn_no"]); kv("GRN Date", f["grn_date"]); kv("PO Number", f["po_number"])
        kv("Buyer", f["buyer_name"]); kv("Buyer GSTIN", f["buyer_gstin"]); kv("Supplier", f["seller_name"])
        kv("Supplier GSTIN", f["seller_gstin"])

    y -= 12
    cv.setStrokeColor(HexColor("#c9d3d8"))
    cv.line(50, y + 12, W - 50, y + 12)
    cv.setFont(bold, 10)
    cv.drawString(50, y, "Description")
    if doc_type == "grn":
        cv.drawRightString(400, y, "Ordered"); cv.drawRightString(500, y, "Received")
    else:
        cv.drawRightString(330, y, "Qty"); cv.drawRightString(430, y, "Unit Price"); cv.drawRightString(545, y, "Amount")
    y -= 6
    cv.line(50, y, W - 50, y)
    y -= 16
    cv.setFont(font, 10)
    for it in f["items"]:
        cv.drawString(50, y, it["description"])
        if doc_type == "grn":
            cv.drawRightString(400, y, str(it["ordered_qty"])); cv.drawRightString(500, y, str(it["received_qty"]))
        else:
            cv.drawRightString(330, y, str(it["qty"]))
            cv.drawRightString(430, y, fmt_inr(it["unit_price"]))
            cv.drawRightString(545, y, fmt_inr(it["qty"] * it["unit_price"]))
        y -= 17
    cv.line(50, y + 8, W - 50, y + 8)
    y -= 10
    if doc_type == "grn":
        kv("Received By", f["received_by"]); kv("Condition", "Accepted, no damage"); kv("Remarks", "Quantity verified at stores")
    else:
        sub = sum(it["qty"] * it["unit_price"] for it in f["items"])
        kv("Subtotal", fmt_inr(sub)); kv("GST @ 18%", fmt_inr(sub * 0.18)); kv("Total", fmt_inr(sub * 1.18))
    cv.setFont(font, 8)
    cv.setFillColor(HexColor("#566673"))
    cv.drawString(50, 60, "This is a computer generated document." if style == 1 else "Re-issued copy for records.")
    cv.showPage()
    cv.save()
    return buf.getvalue()


def render_ledger(doc_type, f):
    """Bank account statement (via Account Aggregator) or seller's statement of account."""
    buf = io.BytesIO()
    cv = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    bank = doc_type == "bank"
    cv.setFillColor(HexColor("#3b4fb8") if bank else ACCENT)
    cv.rect(0, H - 90, W, 90, fill=1, stroke=0)
    cv.setFillColor(HexColor("#ffffff"))
    cv.setFont("Helvetica-Bold", 16)
    cv.drawString(40, H - 45, (f["bank_name"] if bank else f["seller_name"]).upper())
    cv.setFont("Helvetica-Bold", 13)
    cv.drawRightString(W - 40, H - 45, "BANK ACCOUNT STATEMENT" if bank else "STATEMENT OF ACCOUNT")
    cv.setFillColor(INK)
    y = H - 125

    def kv(k, v):
        nonlocal y
        cv.setFont("Helvetica-Bold", 10)
        cv.drawString(50, y, f"{k}:")
        cv.setFont("Helvetica", 10)
        cv.drawString(190, y, str(v))
        y -= 17

    if bank:
        kv("Account Holder", f["seller_name"]); kv("Account No", "XXXXXXXX4521"); kv("Source", f["source"])
    else:
        kv("Supplier", f["seller_name"]); kv("Supplier GSTIN", f["seller_gstin"])
        kv("Customer", f["buyer_name"]); kv("Customer GSTIN", f["buyer_gstin"])
    kv("Period", f["period"]); kv("Opening Balance", fmt_inr(f["opening"]))
    y -= 10
    cv.setStrokeColor(HexColor("#c9d3d8"))
    cv.line(50, y + 12, W - 50, y + 12)
    cv.setFont("Helvetica-Bold", 10)
    cv.drawString(50, y, "Date"); cv.drawString(118, y, "Narration" if bank else "Particulars")
    cols = (395, 470, 545) if bank else (440, 545)
    for x, h in zip(cols, ("Debit", "Credit", "Balance") if bank else ("Debit", "Credit")):
        cv.drawRightString(x, y, h)
    y -= 20
    bal = f["opening"]
    for d, text, debit, credit in f["rows"]:
        cv.setFont("Helvetica", 9)
        cv.drawString(50, y, d); cv.drawString(118, y, text)
        cv.drawRightString(cols[0], y, fmt_inr(debit) if debit else "-")
        cv.drawRightString(cols[1], y, fmt_inr(credit) if credit else "-")
        if bank:
            bal = bal - debit + credit
            cv.drawRightString(cols[2], y, fmt_inr(bal))
        else:
            bal = bal + debit - credit
        y -= 16
    cv.line(50, y + 8, W - 50, y + 8)
    y -= 10
    kv("Closing Balance" if bank else "Closing Balance Outstanding", fmt_inr(f.get("claimed", bal)))
    cv.setFont("Helvetica", 8)
    cv.setFillColor(HexColor("#566673"))
    cv.drawString(50, 60, "Fetched with customer consent via the RBI Account Aggregator framework." if bank else "Balance confirmed as per our books.")
    cv.showPage()
    cv.save()
    return buf.getvalue()


def finalize(pdf: bytes, producer: str, created: datetime) -> bytes:
    w = PdfWriter(clone_from=io.BytesIO(pdf))
    w.add_metadata({"/Producer": producer, "/Creator": producer, "/CreationDate": _pdf_date(created), "/ModDate": _pdf_date(created)})
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def tamper_incremental(pdf: bytes, tool: str, modified: datetime) -> bytes:
    """Simulate a fraudster saving the file in an online PDF editor: appends an incremental update."""
    try:
        w = PdfWriter(io.BytesIO(pdf), incremental=True)
        w.add_metadata({"/Producer": tool, "/ModDate": _pdf_date(modified)})
        out = io.BytesIO()
        w.write(out)
        data = out.getvalue()
        if data.count(b"%%EOF") > 1:
            return data
    except Exception:  # noqa: BLE001
        pass
    # fallback: rewrite metadata, then append an incremental trailer section by hand
    w = PdfWriter(clone_from=io.BytesIO(pdf))
    w.add_metadata({"/Producer": tool, "/ModDate": _pdf_date(modified)})
    out = io.BytesIO()
    w.write(out)
    data = out.getvalue()
    start = data.rfind(b"startxref")
    return data + b"\n% incremental update\n" + data[start:]


def scenario_docs():
    t = today()
    d = lambda n: (t - timedelta(days=n)).isoformat()  # noqa: E731
    base = {"seller_name": ACME[1], "seller_gstin": ACME[0], "issuer_city": ACME[2]}
    zen = {"buyer_name": ZENITH[1], "buyer_gstin": ZENITH[0]}
    orb = {"buyer_name": ORBIT[1], "buyer_gstin": ORBIT[0]}
    po1_items = [{"description": "Brake Caliper Assembly BC-220", "qty": 200, "unit_price": 1250.0},
                 {"description": "Ventilated Disc Rotor 300mm", "qty": 250, "unit_price": 1000.0}]
    po3_items = [{"description": "Brake Caliper Assembly BC-220", "qty": 100, "unit_price": 1250.0},
                 {"description": "Ceramic Brake Pad Set", "qty": 300, "unit_price": 400.0}]
    po4_items = [{"description": "Steel Shelving Unit SR-5", "qty": 120, "unit_price": 1800.0},
                 {"description": "Checkout Counter Frame", "qty": 15, "unit_price": 5600.0}]

    def grn_items(items, received=None):
        return [{"description": it["description"], "ordered_qty": it["qty"], "received_qty": (received or {}).get(i, it["qty"])}
                for i, it in enumerate(items)]

    period = f"{d(60)} to {d(1)}"
    bank_meta = {"bank_name": "Bharat Commerce Bank", "source": "Account Aggregator (consent AA-7F3K-2291)", "period": period}
    soa_meta = {"period": period}
    created = lambda days: datetime.combine(t - timedelta(days=days), datetime.min.time()) + timedelta(hours=11)  # noqa: E731
    S = {}
    # 1 clean
    S["01_clean"] = {
        "title": "Genuine invoice", "attack": None, "lender": "lender_a", "buyer": "Zenith Motors",
        "story": "Acme delivered brake parts to Zenith Motors (a reliable payer). Invoice, PO and delivery receipt all agree.",
        "expect": "Auto-approved with a 90% advance. Disburse to register it on-chain.",
        "docs": {
            "po": ("po", {**base, **zen, "po_number": "PO-ZM-7781", "po_date": d(20), "items": po1_items}, 1, created(20)),
            "grn": ("grn", {**base, **zen, "grn_no": "GRN-ZM-4410", "grn_date": d(8), "po_number": "PO-ZM-7781",
                            "items": grn_items(po1_items), "received_by": "R. Iyer, Stores In-charge"}, 1, created(8)),
            "invoice": ("invoice", {**base, **zen, "invoice_no": "INV-2026-1001", "invoice_date": d(7), "due_date": (t + timedelta(days=53)).isoformat(),
                                    "po_number": "PO-ZM-7781", "items": po1_items}, 1, created(7)),
            "bank": ("bank", {**base, **bank_meta, "opening": 1250000, "rows": [
                (d(50), "NEFT DR STEEL INDIA CORP", 210000, 0), (d(40), "NEFT CR ZENITH MOTORS LTD INV-2026-0870", 0, 400000),
                (d(25), "SALARY PAYOUT SEP", 380000, 0), (d(12), "NEFT CR ZENITH MOTORS LTD INV-2026-0912", 0, 472000),
                (d(3), "GST PAYMENT GSTR-3B", 85000, 0)]}, 1, created(1)),
            "soa": ("soa", {**base, **zen, **soa_meta, "opening": 400000, "rows": [
                (d(55), "Invoice INV-2026-0912", 472000, 0), (d(40), "Payment received NEFT", 0, 400000),
                (d(12), "Payment received NEFT", 0, 472000), (d(7), "Invoice INV-2026-1001", 590000, 0)]}, 1, created(1)),
        }}
    # 2 double pledge (same invoice, re-issued file, different lender)
    S["02_double_pledge"] = {
        "title": "Double-pledge to a second lender", "attack": "Duplicate financing", "lender": "lender_b", "buyer": "Zenith Motors",
        "requires": "01_clean",
        "story": "After one lender funds scenario 01, Acme re-issues the same invoice from a different template (number written INV/2026/1001) and takes it to the other lender.",
        "expect": "The second lender's own records are clean, but the shared on-chain registry blocks it. Needs 01 disbursed first.",
        "docs": {
            "po": ("po", {**base, **zen, "po_number": "PO-ZM-7781", "po_date": d(20), "items": po1_items}, 2, created(20)),
            "grn": ("grn", {**base, **zen, "grn_no": "GRN-ZM-4410", "grn_date": d(8), "po_number": "PO-ZM-7781",
                            "items": grn_items(po1_items), "received_by": "R. Iyer, Stores In-charge"}, 2, created(8)),
            "invoice": ("invoice", {**base, **zen, "invoice_no": "INV/2026/1001", "invoice_date": d(7), "due_date": (t + timedelta(days=53)).isoformat(),
                                    "po_number": "PO-ZM-7781", "items": po1_items}, 2, created(2)),
        }}
    # 3 inflated
    inflated = [{"description": "Brake Caliper Assembly BC-220", "qty": 150, "unit_price": 1250.0},
                {"description": "Ceramic Brake Pad Set", "qty": 300, "unit_price": 450.0}]
    S["03_inflated"] = {
        "title": "Inflated invoice, edited PDF", "attack": "Document manipulation", "lender": "lender_a", "buyer": "Zenith Motors",
        "story": "Zenith ordered and received 100 calipers. The invoice was edited in an online PDF editor to bill 150, and the pad price was raised from ₹400 to ₹450.",
        "expect": "3-way match fails line by line; forensics shows the PDF was edited. Rejected.",
        "docs": {
            "po": ("po", {**base, **zen, "po_number": "PO-ZM-7790", "po_date": d(18), "items": po3_items}, 1, created(18)),
            "grn": ("grn", {**base, **zen, "grn_no": "GRN-ZM-4432", "grn_date": d(6), "po_number": "PO-ZM-7790",
                            "items": grn_items(po3_items), "received_by": "R. Iyer, Stores In-charge"}, 1, created(6)),
            "invoice": ("invoice", {**base, **zen, "invoice_no": "INV-2026-1002", "invoice_date": d(5), "due_date": (t + timedelta(days=55)).isoformat(),
                                    "po_number": "PO-ZM-7790", "items": inflated}, 1, created(5), ("iLovePDF Online Editor", created(1))),
        }}
    # 4 slow buyer
    S["04_slow_buyer"] = {
        "title": "Genuine invoice, slow-paying buyer", "attack": None, "lender": "lender_a", "buyer": "Orbit Retail",
        "story": "Clean documents, but Orbit Retail pays about 40 days late on average.",
        "expect": "Manual review at 75% advance. Request buyer confirmation, then confirm as Orbit Retail: grade C becomes B.",
        "docs": {
            "po": ("po", {**base, **orb, "po_number": "PO-OR-2210", "po_date": d(22), "items": po4_items}, 1, created(22)),
            "grn": ("grn", {**base, **orb, "grn_no": "GRN-OR-0981", "grn_date": d(9), "po_number": "PO-OR-2210",
                            "items": grn_items(po4_items), "received_by": "S. Malhotra, Warehouse Lead"}, 1, created(9)),
            "invoice": ("invoice", {**base, **orb, "invoice_no": "INV-2026-1003", "invoice_date": d(8), "due_date": (t + timedelta(days=52)).isoformat(),
                                    "po_number": "PO-OR-2210", "items": po4_items}, 1, created(8)),
        }}
    # 5 re-billed PO with a new invoice number
    S["05_rebilled_po"] = {
        "title": "Same delivery billed twice", "attack": "Renumbered duplicate", "lender": "lender_a", "buyer": "Zenith Motors",
        "requires": "01_clean",
        "story": "A new invoice number (INV-2026-1009) billing the same PO and delivery as INV-2026-1001, sent to the same bank. The fingerprint is different, so a hash check alone misses it.",
        "expect": "Goes to the lender that took scenario 01. The PO billing ledger shows the PO billed at 200%. Rejected.",
        "docs": {
            "po": ("po", {**base, **zen, "po_number": "PO-ZM-7781", "po_date": d(20), "items": po1_items}, 1, created(20)),
            "grn": ("grn", {**base, **zen, "grn_no": "GRN-ZM-4410", "grn_date": d(8), "po_number": "PO-ZM-7781",
                            "items": grn_items(po1_items), "received_by": "R. Iyer, Stores In-charge"}, 1, created(8)),
            "invoice": ("invoice", {**base, **zen, "invoice_no": "INV-2026-1009", "invoice_date": d(3), "due_date": (t + timedelta(days=57)).isoformat(),
                                    "po_number": "PO-ZM-7781", "items": po1_items}, 1, created(3)),
        }}
    # 6 already-paid invoice pledged
    fluid = [{"description": "Brake Fluid DOT4 1L", "qty": 400, "unit_price": 500.0}]
    S["06_already_paid"] = {
        "title": "Invoice the buyer already paid", "attack": "Paid invoice pledged", "lender": "lender_a", "buyer": "Zenith Motors",
        "story": "Zenith paid INV-2026-1004 five days ago. Acme pledges it anyway, with a statement of account that leaves the payment out.",
        "expect": "Bank statement (via Account Aggregator) shows the payment; the statement of account is overstated by ₹2,36,000. Rejected.",
        "docs": {
            "po": ("po", {**base, **zen, "po_number": "PO-ZM-7805", "po_date": d(40), "items": fluid}, 1, created(40)),
            "grn": ("grn", {**base, **zen, "grn_no": "GRN-ZM-4398", "grn_date": d(33), "po_number": "PO-ZM-7805",
                            "items": grn_items(fluid), "received_by": "R. Iyer, Stores In-charge"}, 1, created(33)),
            "invoice": ("invoice", {**base, **zen, "invoice_no": "INV-2026-1004", "invoice_date": d(32), "due_date": (t + timedelta(days=28)).isoformat(),
                                    "po_number": "PO-ZM-7805", "items": fluid}, 1, created(32)),
            "bank": ("bank", {**base, **bank_meta, "opening": 980000, "rows": [
                (d(28), "NEFT DR STEEL INDIA CORP", 150000, 0), (d(12), "NEFT CR ZENITH MOTORS LTD INV-2026-0912", 0, 472000),
                (d(5), "NEFT CR ZENITH MOTORS LTD INV-2026-1004", 0, 236000), (d(2), "GST PAYMENT GSTR-3B", 42000, 0)]}, 1, created(1)),
            "soa": ("soa", {**base, **zen, **soa_meta, "opening": 472000, "rows": [
                (d(32), "Invoice INV-2026-1004", 236000, 0), (d(12), "Payment received NEFT", 0, 472000)]}, 1, created(1)),
        }}
    return S


def generate_samples():
    scenarios = scenario_docs()
    for name, sc in scenarios.items():
        folder = SAMPLES / name
        folder.mkdir(parents=True, exist_ok=True)
        for kind, spec in sc["docs"].items():
            target = folder / f"{kind}.pdf"
            if target.exists() and datetime.fromtimestamp(target.stat().st_mtime).date() == today():
                continue  # keep byte-identical files for the day, so hashes of earlier submissions still match
            doc_type, fields, style, created = spec[:4]
            raw = render_ledger(doc_type, fields) if doc_type in ("bank", "soa") else render(doc_type, fields, style)
            pdf = finalize(raw, "Bharat Commerce Bank e-Statement" if doc_type == "bank" else ACME[3], created)
            if len(spec) > 4:
                tool, when = spec[4]
                pdf = tamper_incremental(pdf, tool, when)
            target.write_bytes(pdf)
    return {k: {kk: vv for kk, vv in v.items() if kk != "docs"} for k, v in scenarios.items()}


if __name__ == "__main__":
    from core import init_db

    init_db()
    seed_db()
    print(generate_samples().keys())
