"""On-chain layer: InvoiceRegistry on a local Hardhat node, with a simulated ledger fallback
so the demo never dies if the node is down."""
import json
import os
import time

from core import BASE, DATA, LENDERS

RPC_URL = os.environ.get("VERIFIN_RPC", "http://127.0.0.1:8545")
ARTIFACT = BASE / "chain" / "artifacts" / "contracts" / "InvoiceRegistry.sol" / "InvoiceRegistry.json"
STATE = DATA / "chain.json"
SIM = DATA / "simchain.json"
STATUS_NAMES = {0: "none", 1: "financed", 2: "released"}


def b32(hexstr: str) -> bytes:
    return bytes.fromhex(hexstr.removeprefix("0x").rjust(64, "0"))


class Chain:
    def __init__(self):
        self.mode = "simulated"
        self.w3 = None
        self.contract = None
        self.address = None
        self.fresh_deploy = False
        self.connect()

    # ---------- setup ----------
    def connect(self):
        try:
            from web3 import Web3

            w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 5}))
            if not w3.is_connected():
                raise RuntimeError("node offline")
            self.w3 = w3
            self.accounts = w3.eth.accounts
            art = json.loads(ARTIFACT.read_text())
            self.abi, self.bytecode = art["abi"], art["bytecode"]
            addr = None
            if STATE.exists():
                addr = json.loads(STATE.read_text()).get("address")
            if not addr or len(w3.eth.get_code(addr)) == 0:
                addr = self._deploy()
            self.address = addr
            self.contract = w3.eth.contract(address=addr, abi=self.abi)
            self.mode = "hardhat"
        except Exception as e:  # noqa: BLE001
            print(f"[chain] Hardhat unavailable ({e}); using simulated ledger")
            self.mode = "simulated"
            if not SIM.exists():
                self._sim_save({"block": 0, "records": {}, "confirmations": {}, "anchors": []})

    def _deploy(self):
        C = self.w3.eth.contract(abi=self.abi, bytecode=self.bytecode)
        tx = C.constructor().transact({"from": self.accounts[0]})
        rcpt = self.w3.eth.wait_for_transaction_receipt(tx)
        STATE.write_text(json.dumps({"address": rcpt.contractAddress}))
        self.fresh_deploy = True
        print(f"[chain] InvoiceRegistry deployed at {rcpt.contractAddress}")
        return rcpt.contractAddress

    def reset(self):
        if STATE.exists():
            STATE.unlink()
        if SIM.exists():
            SIM.unlink()
        self.connect()

    def _ensure(self):
        if self.mode == "hardhat":
            try:
                self.w3.eth.block_number
                return
            except Exception:  # noqa: BLE001
                pass
        self.connect()

    # ---------- account mapping ----------
    def account_for(self, actor: str, buyer_index: int | None = None):
        if self.mode != "hardhat":
            return actor
        if actor in LENDERS:
            return self.accounts[LENDERS[actor]["account"]]
        if buyer_index is not None:
            return self.accounts[buyer_index]
        return self.accounts[0]

    def lender_from_address(self, addr):
        for lid, l in LENDERS.items():
            if self.mode == "hardhat" and self.accounts[l["account"]].lower() == str(addr).lower():
                return lid
            if addr == lid:
                return lid
        return None

    # ---------- sim helpers ----------
    def _sim_load(self):
        return json.loads(SIM.read_text())

    def _sim_save(self, s):
        SIM.write_text(json.dumps(s, indent=1))

    def _sim_tx(self, s):
        s["block"] += 1
        import hashlib

        return {"tx_hash": "0x" + hashlib.sha256(f"{time.time()}{s['block']}".encode()).hexdigest(), "block": s["block"]}

    def _send(self, fn, sender):
        tx = fn.transact({"from": sender})
        rcpt = self.w3.eth.wait_for_transaction_receipt(tx)
        return {"tx_hash": rcpt.transactionHash.hex() if hasattr(rcpt.transactionHash, "hex") else str(rcpt.transactionHash),
                "block": rcpt.blockNumber, "gas_used": rcpt.gasUsed}

    # ---------- API ----------
    def status(self):
        self._ensure()
        if self.mode == "hardhat":
            return {"mode": "hardhat", "network": "Consortium EVM network · local node (chain 31337)", "rpc": RPC_URL,
                    "contract": self.address, "block": self.w3.eth.block_number,
                    "anchors": self.contract.functions.anchorCount().call()}
        s = self._sim_load()
        return {"mode": "simulated", "network": "Simulated ledger (node offline)", "contract": "n/a",
                "block": s["block"], "anchors": len(s["anchors"])}

    def lookup(self, fp_hex: str):
        self._ensure()
        if self.mode == "hardhat":
            lender, at, status, commitment = self.contract.functions.records(b32(fp_hex)).call()
            buyer, cat = self.contract.functions.confirmations(b32(fp_hex)).call()
            return {"status": STATUS_NAMES[status], "lender": self.lender_from_address(lender) if status else None,
                    "lender_address": lender if status else None, "registered_at": at or None,
                    "commitment": commitment.hex() if status else None,
                    "confirmed": cat > 0, "confirmed_by": buyer if cat else None, "confirmed_at": cat or None}
        s = self._sim_load()
        r = s["records"].get(fp_hex)
        cf = s["confirmations"].get(fp_hex)
        return {"status": r["status"] if r else "none", "lender": r["lender"] if r else None,
                "lender_address": r["lender"] if r else None, "registered_at": r["at"] if r else None,
                "commitment": r["commitment"] if r else None,
                "confirmed": bool(cf), "confirmed_by": cf["buyer"] if cf else None, "confirmed_at": cf["at"] if cf else None}

    def register(self, fp_hex, commitment_hex, lender_id):
        self._ensure()
        if self.mode == "hardhat":
            fn = self.contract.functions.register(b32(fp_hex), b32(commitment_hex))
            return self._send(fn, self.account_for(lender_id))
        s = self._sim_load()
        if s["records"].get(fp_hex, {}).get("status") == "financed":
            raise RuntimeError("DUPLICATE_FINANCING")
        tx = self._sim_tx(s)
        s["records"][fp_hex] = {"lender": lender_id, "at": int(time.time()), "status": "financed", "commitment": commitment_hex}
        self._sim_save(s)
        return tx

    def release(self, fp_hex, lender_id):
        self._ensure()
        if self.mode == "hardhat":
            return self._send(self.contract.functions.release(b32(fp_hex)), self.account_for(lender_id))
        s = self._sim_load()
        tx = self._sim_tx(s)
        s["records"][fp_hex]["status"] = "released"
        self._sim_save(s)
        return tx

    def confirm(self, fp_hex, buyer_index):
        self._ensure()
        if self.mode == "hardhat":
            return self._send(self.contract.functions.confirm(b32(fp_hex)), self.accounts[buyer_index])
        s = self._sim_load()
        tx = self._sim_tx(s)
        s["confirmations"][fp_hex] = {"buyer": f"buyer#{buyer_index}", "at": int(time.time())}
        self._sim_save(s)
        return tx

    def anchor(self, root_hex, from_event, to_event):
        self._ensure()
        if self.mode == "hardhat":
            index = self.contract.functions.anchorCount().call()
            tx = self._send(self.contract.functions.anchor(b32(root_hex), from_event, to_event), self.accounts[0])
            return {**tx, "index": index, "mode": "hardhat"}
        s = self._sim_load()
        tx = self._sim_tx(s)
        s["anchors"].append({"root": root_hex, "from": from_event, "to": to_event})
        self._sim_save(s)
        return {**tx, "index": len(s["anchors"]) - 1, "mode": "simulated"}

    def get_anchor_root(self, index):
        self._ensure()
        if self.mode == "hardhat":
            root, _f, _t, _ts = self.contract.functions.anchors(index).call()
            return root.hex().removeprefix("0x")
        return self._sim_load()["anchors"][index]["root"]


chain = Chain()
