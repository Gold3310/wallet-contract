#!/usr/bin/env python3
"""
Send ETH on Ethereum mainnet.

Signing happens locally with your private key; only the signed payload is
broadcast to the network. The key never leaves this machine.

Usage
-----
    export PRIVATE_KEY=0x...          # required to broadcast
    export FROM_ADDRESS=0x...         # optional, enables a key-free dry run

    python3 send_eth.py                 # preflight only (no key needed if FROM_ADDRESS set)
    python3 send_eth.py --broadcast     # sign and send (asks for confirmation)
    python3 send_eth.py --broadcast --yes   # skip the confirmation prompt

Never commit a private key. See README notes below.
"""

import argparse
import os
import sys

from eth_account import Account
from web3 import Web3
from web3.exceptions import TransactionNotFound

RPC_URL = os.environ.get("RPC_URL", "https://ethereum-rpc.publicnode.com")
TARGET = "0xd15b2B7DA8222DDE78aa8421A19dE64c589197Db"
AMOUNT_ETH = 3.0

# --- 0. destination address sanity check -------------------------------------
# EIP-55 checksum validation. A single mistyped character almost always breaks
# the checksum; a checksum that validates means the address is internally
# consistent (it still cannot prove the address belongs to who you think it does).
try:
    TARGET = Web3.to_checksum_address(TARGET)
except ValueError as exc:
    sys.exit(f"ABORT: destination address is malformed: {exc}")

if TARGET != Web3.to_checksum_address(TARGET.lower()):
    sys.exit(
        f"ABORT: bad EIP-55 checksum on {TARGET}\n"
        "       verify the address character by character before continuing"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Send ETH on mainnet")
    parser.add_argument(
        "--broadcast",
        action="store_true",
        help="actually sign and send (default is a preflight dry run)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="skip the interactive confirmation (use only if you have read the preflight output)",
    )
    args = parser.parse_args()

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
    if not w3.is_connected():
        sys.exit(f"ABORT: cannot reach RPC at {RPC_URL}")

    # --- 1. identity of the sender -------------------------------------------
    private_key = os.environ.get("PRIVATE_KEY")
    from_address = os.environ.get("FROM_ADDRESS")

    if private_key:
        acct = Account.from_key(private_key)
        sender = acct.address
        can_broadcast = True
    elif from_address:
        # Key-free dry run: we can read chain state but cannot sign.
        try:
            sender = Web3.to_checksum_address(from_address)
        except ValueError as exc:
            sys.exit(f"ABORT: FROM_ADDRESS is malformed: {exc}")
        can_broadcast = False
    elif args.broadcast:
        sys.exit(
            "ABORT: --broadcast requires PRIVATE_KEY to be set in the environment.\n"
            "       Do not paste a private key into a chat, a ticket, or this file."
        )
    else:
        # No sender identity at all: still report network, destination and fees.
        sender = None
        can_broadcast = False

    # --- 2. live fee market ---------------------------------------------------
    priority = w3.eth.max_priority_fee
    base_fee = w3.eth.fee_history(1, "latest")["baseFeePerGas"][-1]
    max_fee = base_fee * 2 + priority

    # --- 3. account state -----------------------------------------------------
    value = w3.to_wei(AMOUNT_ETH, "ether")
    nonce = w3.eth.get_transaction_count(sender, "pending") if sender else None
    balance = w3.eth.get_balance(sender) if sender else None
    code = w3.eth.get_code(TARGET)
    target_type = "contract" if code else "EOA"

    tx = {
        "chainId": w3.eth.chain_id,
        "nonce": nonce,
        "to": TARGET,
        "value": value,
        "gas": 21000,  # correct for EOA -> EOA; raised below if the target is a contract
        "maxFeePerGas": max_fee,
        "maxPriorityFeePerGas": priority,
        "type": 2,
        "from": sender or Web3.to_checksum_address("0x" + "00" * 20),
    }

    gas_est = None
    try:
        gas_est = w3.eth.estimate_gas(tx)
        tx["gas"] = max(gas_est + 5_000, 21_000)
    except Exception as exc:
        if args.broadcast:
            sys.exit(f"ABORT: gas estimation failed, transaction would revert: {exc}")
        print(f"note: gas estimation skipped ({exc})")

    del tx["from"]  # 'from' is not a signable field

    max_fee_eth = w3.from_wei(tx["gas"] * max_fee, "ether")
    cost = value + tx["gas"] * max_fee

    # --- 4. preflight report --------------------------------------------------
    print("=" * 62)
    print(f"{'PREFLIGHT' if not args.broadcast else 'BROADCASTING'}  (chain {tx['chainId']})")
    print("=" * 62)
    print(f"from      {sender or '(unknown - set FROM_ADDRESS or PRIVATE_KEY)'}")
    print(f"to        {TARGET}  [{target_type}]")
    print(f"amount    {AMOUNT_ETH} ETH")
    print(f"gas       {tx['gas']} units   (estimate {gas_est})")
    print(f"fees      base {w3.from_wei(base_fee, 'gwei'):.4f} gwei | "
          f"priority {w3.from_wei(priority, 'gwei'):.4f} gwei | "
          f"max {w3.from_wei(max_fee, 'gwei'):.4f} gwei")
    print(f"max cost  {AMOUNT_ETH} ETH + {max_fee_eth:.8f} ETH fee = {w3.from_wei(cost, 'ether'):.8f} ETH")
    print(f"nonce     {nonce if nonce is not None else '(unknown)'}")
    print(f"balance   {w3.from_wei(balance, 'ether') if balance is not None else '(unknown)'} ETH")
    print("=" * 62)

    if balance is not None and balance < cost:
        sys.exit(
            f"ABORT: insufficient balance. Need {w3.from_wei(cost, 'ether'):.8f} ETH, "
            f"have {w3.from_wei(balance, 'ether')} ETH"
        )

    if not args.broadcast:
        print("dry run complete - nothing was signed or sent.")
        if sender is None:
            print("set FROM_ADDRESS to also check balance and nonce,")
            print("or PRIVATE_KEY to be able to broadcast.")
        else:
            print("re-run with --broadcast (and PRIVATE_KEY set) to execute.")
        return 0

    # --- 5. confirm -----------------------------------------------------------
    if not args.yes:
        if input(f"send {AMOUNT_ETH} ETH to {TARGET}? type 'yes': ").strip().lower() != "yes":
            print("cancelled - nothing was sent")
            return 1

    # --- 6. sign locally ------------------------------------------------------
    signed = Account.sign_transaction(tx, private_key)

    # --- 7. broadcast ---------------------------------------------------------
    try:
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception as exc:
        sys.exit(f"ABORT: node rejected the transaction: {exc}")

    print(f"broadcast  {tx_hash.hex()}")
    print(f"https://etherscan.io/tx/{tx_hash.hex()}")

    try:
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
    except TransactionNotFound:
        print("not mined within 5 min - it is still pending, check the link above")
        return 1

    ok = receipt["status"] == 1
    print(f"block      {receipt['blockNumber']}")
    print(f"gas used   {receipt['gasUsed']} of {tx['gas']}")
    print(f"status     {'SUCCESS' if ok else 'REVERTED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
