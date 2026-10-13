<p align="center"><img src="docs/brand/verbil-logo-transparent.png" alt="Verbil" width="460"></p>

# Verbil: invoice financing with a hybrid audit architecture

**Verify the invoice. Establish the trust. Accelerate the financing.**

Verbil checks an invoice in seconds before a lender advances cash against it. It reads the invoice, purchase order and delivery receipt; checks the PDF for signs of editing; cross-checks invoice, PO and delivery; reconciles what was charged, paid and claimed outstanding; screens for duplicates across lenders through an on-chain registry; scores buyer risk with an explanation for every point; prices the advance; and records each step in a tamper-evident audit log anchored on a blockchain.

**User manual with screenshots:** [`docs/manual/index.html`](docs/manual/index.html) (open it in a browser).

## Setup (once per machine)

Needs Python 3.12+ and Node.js 18+ on Windows.

```
setup.bat
```
Creates `.venv`, installs the Python packages, installs Hardhat and compiles the smart contract.

## Run

```
start.bat
```
Opens two windows (the local blockchain node and the app server) and launches http://localhost:8000. Keep both windows open.

Manual start (two terminals):
```
cd chain && npx hardhat node
.venv\Scripts\python -m uvicorn main:app --app-dir backend --port 8000
```
Optional: set `ANTHROPIC_API_KEY` to enable AI extraction (Claude reads any invoice layout, including scans and images). Without a key, the offline layout parser handles the example PDFs.

## Using the app

Switch between workspaces with the button next to the logo:

| Workspace | Role | Screens |
|---|---|---|
| Shakti Bank, Kaveri Capital | Lenders | Dashboard, Applications (evidence tabs, approve, disburse), Audit |
| Acme Precision Parts | Business | My invoices (stage timeline), Get paid early (upload) |
| Zenith Motors, Orbit Retail | Buyers | Confirmations: confirm (signed on-chain) or dispute |
| Independent verifier | Anyone | Verify a signed record or a document against the chain |

Press **P** (or the ▶ in the bottom-right corner) for the presenter drawer: six ready-made scenarios, insider attacks and **Reset data**.

| # | Scenario | Result |
|---|---|---|
| 01 | Genuine invoice → Shakti Bank | Score 86 (A), auto-approved, 90% advance. **Disburse** registers it on-chain. |
| 02 | Same invoice re-issued → Kaveri Capital | Blocked by the on-chain registry. |
| 03 | Inflated invoice, edited PDF | Blocked: 150 billed vs 100 ordered, price ₹400 → ₹450, iLovePDF edit detected. |
| 04 | Slow-paying buyer | Manual review at 75%. Buyer confirms in its inbox: score 53 → 65, advance 85%. |
| 05 | Same delivery billed twice | Blocked: PO billed at 200%. |
| 06 | Invoice the buyer already paid | Blocked: payment found in bank statement, statement of account overstated by ₹2,36,000. |

## Architecture

```
Business uploads invoice + PO + GRN (+ bank statement, statement of account)
  │
  ├─ Encrypted vault (Fernet/AES) ── SHA-256 of each file → audit log
  ├─ Extraction ── layout parser │ Claude (claude-opus-5-5) for any layout
  ├─ Forensics ── incremental saves, editor producer, timestamps
  ├─ Cross-checks ── lines, qty, price, parties, dates, PO billing ledger
  ├─ Reconciliation ── charged (invoice) vs paid (bank) vs claimed (statement of account)
  ├─ Duplicate shield ── L1 file hash · L2 HMAC fingerprint · L3 fuzzy · L4 on-chain registry
  ├─ Risk scorecard ── buyer delay/defaults, concentration, size, tenor, verification → offer
  └─ Audit ── hash-chained events → Merkle root per batch → InvoiceRegistry.anchor()

On-chain (InvoiceRegistry.sol): fingerprints + status, buyer confirmations,
audit Merkle roots, selective-disclosure commitment roots. No PII, amounts or files.
```

| Path | What it does |
|---|---|
| `chain/contracts/InvoiceRegistry.sol` | Registry: `register` (reverts `DUPLICATE_FINANCING`), `release`, `confirm`, `anchor` |
| `backend/main.py` | FastAPI app, pipeline, workflow, dashboards, buyer inbox, presenter endpoints |
| `backend/extract.py` | PDF layout parser + Claude structured extraction |
| `backend/forensics.py` | PDF tamper forensics |
| `backend/verify.py` | Cross-checks with rule IDs, confidence and ₹ discrepancies |
| `backend/reconcile.py` | Invoice ↔ bank statement ↔ statement of account |
| `backend/dupes.py` | Four-layer duplicate shield |
| `backend/risk.py` | Explainable scorecard, decision, pricing, memo |
| `backend/evidence.py` | Lender credit pack + signed portable Verification Record |
| `backend/audit.py` | Hash chain, Merkle trees, anchoring, integrity verification |
| `backend/disclosure.py` | Salted field-level Merkle commitments (selective disclosure) |
| `backend/seed.py` | Example companies, payment histories, scenario PDFs |
| `tools/verify_record.py` | Independent offline verifier (reads the chain directly) |
| `frontend/` | Single-page app (no build step) |
| `docs/` | User manual, team explainer, build log |

All companies, GSTINs and payment histories are fictional example data, and the risk weights are hand-set.

Production path: a permissioned EVM network run by the lender consortium (e.g. Hyperledger Besu) instead of a local node; bank statements via the Account Aggregator framework; GST e-invoice IRN and e-way bill lookups; buyer confirmations signed from the buyer's AP system.
