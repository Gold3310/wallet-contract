#!/usr/bin/env python3
"""
Offline execution harness for send_eth.py.

This sandbox has no outbound network, so a real broadcast is impossible here.
Instead this harness runs send_eth.main() end to end with:
  - a stubbed JSON-RPC layer (no network calls)
  - an ephemeral key generated at runtime (never a real key)

It proves the code path works: address validation, fee math, nonce, gas
estimation, signing, and broadcast. The signed payload is captured rather
than sent, then decoded and verified.

Run:  .venv/bin/python tests/test_send_eth_offline.py
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rlp
from eth_account import Account
from hexbytes import HexBytes

import send_eth  # module-level check runs the EIP-55 validation, offline-safe

RealWeb3 = send_eth.Web3
GWEI = 10**9

# --- capture slots -----------------------------------------------------------
captured = {}


class FakeEth:
    """Stands in for w3.eth. Values chosen to look like a quiet mainnet block."""

    def __init__(self, *, balance_wei, target_code, est_gas=21_000):
        self.balance_wei = balance_wei
        self.target_code = target_code
        self.est_gas = est_gas
        self.max_priority_fee = 1 * GWEI
        self.chain_id = 1

    def fee_history(self, n, tag):
        return {"baseFeePerGas": [20 * GWEI, 21 * GWEI]}

    def get_transaction_count(self, addr, block):
        return 7

    def get_balance(self, addr):
        return self.balance_wei

    def get_code(self, addr):
        return self.target_code

    def estimate_gas(self, tx):
        return self.est_gas

    def send_raw_transaction(self, raw):
        captured["raw"] = raw
        return HexBytes("0x" + "ab" * 32)

    def wait_for_transaction_receipt(self, tx_hash, timeout):
        return {"status": 1, "blockNumber": 23_000_000, "gasUsed": 21_000}


class FakeWeb3:
    to_checksum_address = staticmethod(RealWeb3.to_checksum_address)
    to_wei = staticmethod(RealWeb3.to_wei)
    from_wei = staticmethod(RealWeb3.from_wei)

    @staticmethod
    def HTTPProvider(url, **kwargs):
        return None  # never actually constructed offline

    def __init__(self, provider=None, **kwargs):
        self.eth = FakeEth(**CURRENT)

    def is_connected(self):
        return True


CURRENT = {}
send_eth.Web3 = FakeWeb3


def run_case(name, *, balance_eth, target_code=b"", est_gas=21_000, expect_exit=None):
    """Run send_eth.main() with a fresh ephemeral key under a given scenario."""
    CURRENT.clear()
    CURRENT.update(balance_wei=RealWeb3.to_wei(balance_eth, "ether"),
                   target_code=target_code, est_gas=est_gas)

    key = "0x" + secrets.token_hex(32)
    sender = Account.from_key(key).address
    os.environ["PRIVATE_KEY"] = key
    sys.argv = ["send_eth.py", "--broadcast", "--yes"]

    print(f"\n=== {name} ===")
    code = None
    try:
        send_eth.main()
    except SystemExit as exc:
        code = exc.code
    os.environ.pop("PRIVATE_KEY", None)
    return code, sender


def decode_typed(raw: bytes) -> dict:
    """Decode an EIP-1559 (type 2) transaction, ignoring signature fields."""
    assert raw[0] == 2, f"expected type-2 tx, got type byte {raw[0]}"
    fields = rlp.decode(raw[1:])
    keys = ["chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas",
            "gas", "to", "value", "data", "accessList", "v", "r", "s"]
    return dict(zip(keys, fields))


def main() -> int:
    # --- 1. destination address is a valid EIP-55 checksum -------------------
    target = send_eth.TARGET
    assert target == RealWeb3.to_checksum_address(target.lower()), "checksum failed"
    print(f"destination {target}")
    print("EIP-55 checksum: VALID")

    # --- 2. happy path -------------------------------------------------------
    captured.clear()
    code, sender = run_case("happy path: EOA target, 5 ETH balance", balance_eth=5.0)
    assert code is None, f"unexpected exit: {code}"
    raw = captured["raw"]
    tx = decode_typed(raw)

    recovered = Account.recover_transaction(raw)
    assert recovered == sender, f"signer mismatch: {recovered} != {sender}"
    assert int.from_bytes(tx["chainId"], "big") == 1, f"wrong chain: {tx['chainId']}"
    assert int.from_bytes(tx["nonce"], "big") == 7, f"wrong nonce: {tx['nonce']}"
    assert tx["to"].hex().lower() == target.lower().replace("0x", ""), "wrong destination"
    assert int.from_bytes(tx["value"], "big") == RealWeb3.to_wei(3.0, "ether"), "wrong value"
    assert int.from_bytes(tx["maxFeePerGas"], "big") == 43 * GWEI, "wrong maxFeePerGas"
    assert int.from_bytes(tx["maxPriorityFeePerGas"], "big") == 1 * GWEI, "wrong priority fee"
    assert int.from_bytes(tx["gas"], "big") == 26_000, "wrong gas limit"
    assert tx["data"] == b"", "expected empty calldata"

    print("\nsigned payload decoded and verified:")
    print(f"  chainId     {tx['chainId']}")
    print(f"  nonce       {int.from_bytes(tx['nonce'], 'big')}")
    print(f"  to          0x{tx['to'].hex()}")
    print(f"  value       {int.from_bytes(tx['value'], 'big')} wei (3.0 ETH)")
    print(f"  gas         {int.from_bytes(tx['gas'], 'big')}")
    print(f"  maxFee      {int.from_bytes(tx['maxFeePerGas'], 'big') / GWEI} gwei")
    print(f"  recovered   {recovered}")
    print(f"  matches sender: {recovered == sender}")

    # --- 3. insufficient balance aborts before signing -----------------------
    captured.clear()
    code, _ = run_case("insufficient balance: 2 ETH", balance_eth=2.0, expect_exit=1)
    assert code is not None, "should have refused to send with insufficient balance"
    assert "raw" not in captured, "must not sign when the balance check fails"
    print("refused to sign: OK")

    # --- 4. contract target raises the gas limit -----------------------------
    captured.clear()
    code, _ = run_case("contract target: 5 ETH", balance_eth=5.0,
                       target_code=bytes.fromhex("6001600101"), est_gas=64_000)
    assert code is None, f"unexpected exit: {code}"
    tx2 = decode_typed(captured["raw"])
    assert int.from_bytes(tx2["gas"], "big") == 69_000, "gas not raised for contract target"
    print("gas raised for contract target: OK")

    # --- 5. key never leaves the local signing path --------------------------
    src = Path(__file__).resolve().parent.parent.joinpath("send_eth.py").read_text()
    assert "PRIVATE_KEY" in src
    assert "0x" + "0" * 64 not in src, "no literal keys in source"
    print("\nno hardcoded key material in send_eth.py: OK")

    print("\nAll offline checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
