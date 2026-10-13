"""Independent verifier for a Verbil Verification Record. Does NOT call the Verbil server.

Checks:
  1. Ed25519 signature over the record (issuer public key, pinned with --issuer-key)
  2. The record hash is inside an audit event whose hash recomputes
  3. The Merkle path from that event reaches the batch root
  4. That root is the one stored on-chain in InvoiceRegistry.anchors(i)  (reads the chain directly)
  5. Optional: the documents you hold are byte-identical to the ones verified

Usage:
  python verify_record.py record.json [--issuer-key BASE64] [--rpc http://127.0.0.1:8545] [docs...]
"""
import argparse
import base64
import hashlib
import json
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ANCHORS_ABI = [{"inputs": [{"name": "", "type": "uint256"}], "name": "anchors", "stateMutability": "view", "type": "function",
                "outputs": [{"name": "root", "type": "bytes32"}, {"name": "fromEvent", "type": "uint64"},
                            {"name": "toEvent", "type": "uint64"}, {"name": "timestamp", "type": "uint64"}]},
               {"inputs": [{"name": "", "type": "bytes32"}], "name": "records", "stateMutability": "view", "type": "function",
                "outputs": [{"name": "lender", "type": "address"}, {"name": "registeredAt", "type": "uint64"},
                            {"name": "status", "type": "uint8"}, {"name": "commitment", "type": "bytes32"}]}]


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), default=str)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def pair(a, b):
    return sha(bytes.fromhex(a) + bytes.fromhex(b))


def ok(label, passed, extra=""):
    print(f"  [{'PASS' if passed else 'FAIL'}] {label}{(' - ' + extra) if extra else ''}")
    return passed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("record")
    ap.add_argument("docs", nargs="*")
    ap.add_argument("--issuer-key", help="pinned issuer public key (base64). Defaults to the key inside the record.")
    ap.add_argument("--rpc", default=None)
    a = ap.parse_args()
    rec = json.load(open(a.record, encoding="utf-8"))
    print(f"Record {rec['id']}\nIssuer {rec['issuer']['name']} ({rec['issuer']['id']})")
    results = []

    key = a.issuer_key or rec["issuer"]["publicKeyEd25519"]
    body = {k: v for k, v in rec.items() if k not in ("proof", "anchorProof")}
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(key)).verify(base64.b64decode(rec["proof"]["proofValue"]), canonical(body).encode())
        results.append(ok("Issuer signature", True, "pinned key" if a.issuer_key else "key from record (pin it with --issuer-key)"))
    except InvalidSignature:
        results.append(ok("Issuer signature", False, "record was modified after signing"))

    p = rec["anchorProof"]
    rh = sha(canonical({k: v for k, v in rec.items() if k != "anchorProof"}).encode())
    results.append(ok("Record hash is in the audit event", p["event"]["payload"].get("record_sha256") == rh))
    e = p["event"]
    eh = sha(canonical({"app_id": e["app_id"], "type": e["type"], "actor": e["actor"], "payload": e["payload"], "ts": e["ts"], "prev": e["prev"]}).encode())
    results.append(ok("Audit event hash recomputes", eh == p["eventHash"]))
    h = eh
    for s in p["merklePath"]:
        h = pair(s["hash"], h) if s["side"] == "left" else pair(h, s["hash"])
    results.append(ok("Merkle path reaches batch root", h == p["merkleRoot"], f"{len(p['merklePath'])} steps"))

    try:
        from web3 import Web3
        w3 = Web3(Web3.HTTPProvider(a.rpc or p["rpc"]))
        c = w3.eth.contract(address=p["contract"], abi=ANCHORS_ABI)
        root = c.functions.anchors(p["chainIndex"]).call()[0].hex().removeprefix("0x")
        results.append(ok("Root matches the smart contract", root == p["merkleRoot"], f"anchor #{p['chainIndex']}, block {p['block']}"))
        st = c.functions.records(bytes.fromhex(rec["credentialSubject"]["invoiceFingerprint"])).call()[2]
        print(f"  [INFO] Live registry status of this invoice: {['not financed', 'FINANCED', 'released (repaid)'][st]}")
    except Exception as ex:  # noqa: BLE001
        results.append(ok("Root matches the smart contract", False, f"could not read chain: {ex}"))

    if a.docs:
        recorded = {d["sha256"]: d["kind"] for d in rec["credentialSubject"]["documents"]}
        for path in a.docs:
            dh = sha(open(path, "rb").read())
            results.append(ok(f"Document {path}", dh in recorded, f"matches recorded {recorded[dh]}" if dh in recorded else "NOT the document that was verified"))

    print("\nVERIFIED" if all(results) else "\nNOT VERIFIED")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
