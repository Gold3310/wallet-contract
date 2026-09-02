// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Withdrawer
 * @notice Pre-authorised, keyless withdrawals on EVM chains.
 *
 * WHAT THIS IS
 *   A wallet owner authorises this contract ONCE. After that, funds can be
 *   pulled from that wallet to a receiver by anyone holding either the limited
 *   operator key, or -- in permissionless mode -- by anyone at all, with the
 *   destination restricted to an owner-approved allowlist.
 *
 * WHAT THIS IS NOT
 *   It cannot touch a wallet that never authorised it. For ERC-20 the pull is
 *   a plain `transferFrom`, which the ERC-20 itself gates on the owner's own
 *   `approve`. For native ETH the funds must have been deposited here by the
 *   owner. There is no path in this contract that moves value belonging to
 *   someone who did not opt in.
 *
 * TWO MODES
 *   operator != address(0)  each withdrawal carries an EIP-712 signature from
 *                           a hot key that is NOT the wallet key and can do
 *                           nothing beyond the limits below.
 *   operator == address(0)  no signature at all; anyone may trigger. The
 *                           receiver allowlist is then MANDATORY, so funds can
 *                           only ever reach an address the owner pre-approved.
 *
 * LIMITS, enforced on chain and changeable only by the owner
 *   allowance          lifetime budget, decremented on every withdrawal
 *   maxPerWithdrawal   ceiling for a single withdrawal
 *   cooldown           minimum seconds between withdrawals
 *   allowlist          permitted destinations
 *
 * Native ETH is represented by token == address(0) and is held in this
 * contract's own vault balance, because ETH has no `approve`.
 */
contract Withdrawer is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Sentinel for native ETH.
    address public constant NATIVE = address(0);

    struct Policy {
        address operator; // address(0) => permissionless
        uint256 allowance; // remaining lifetime budget
        uint256 maxPerWithdrawal;
        uint64 cooldown;
        uint64 lastWithdrawal;
        bool allowlistOnly;
        bool exists;
        /**
         * Ceiling, in wei, on what a single withdrawal may reimburse to whoever
         * broadcast it. Zero disables reimbursement entirely (the caller then
         * eats the gas). This cap is what stops a hostile relayer from
         * emptying the gas tank by broadcasting at an absurd gas price.
         */
        uint256 maxGasReimbursement;
    }

    /// owner => token => policy
    mapping(address => mapping(address => Policy)) private _policies;
    /// owner => token => receiver => allowed
    mapping(address => mapping(address => mapping(address => bool))) public allowlisted;
    /// owner => token => nonce (replay protection, monotonic)
    mapping(address => mapping(address => uint256)) public nonces;
    /// owner => ETH held in the vault, spendable as NATIVE withdrawals
    mapping(address => uint256) public ethVault;
    /// owner => ETH set aside purely to reimburse whoever broadcasts a withdrawal
    mapping(address => uint256) public gasTank;

    /**
     * Gas consumed outside the metered region: the 21k intrinsic cost, calldata,
     * and the reimbursement transfer itself. Deliberately a slight
     * under-estimate, so the sender wallet can never be charged for more gas
     * than the transaction actually burned.
     */
    uint256 public constant GAS_OVERHEAD = 38_000;

    bytes32 private constant WITHDRAW_TYPEHASH =
        keccak256(
            "Withdraw(address owner,address token,uint256 amount,address receiver,uint256 nonce,uint256 deadline)"
        );

    event Authorized(
        address indexed owner,
        address indexed token,
        address operator,
        uint256 allowance,
        uint256 maxPerWithdrawal,
        uint64 cooldown,
        bool allowlistOnly
    );
    event LimitsChanged(
        address indexed owner,
        address indexed token,
        uint256 allowance,
        uint256 maxPerWithdrawal,
        uint64 cooldown
    );
    event ReceiverSet(address indexed owner, address indexed token, address receiver, bool allowed);
    event OperatorChanged(address indexed owner, address indexed token, address operator);
    event Withdrawn(
        address indexed owner,
        address indexed token,
        address indexed receiver,
        uint256 amount,
        uint256 nonce,
        address triggeredBy
    );
    event Revoked(address indexed owner, address indexed token);
    event EthDeposited(address indexed owner, uint256 amount);
    event GasDeposited(address indexed owner, uint256 amount);
    event GasWithdrawnByOwner(address indexed owner, uint256 amount);
    event GasReimbursed(address indexed owner, address indexed relayer, uint256 amount);
    event GasReimbursementChanged(address indexed owner, address indexed token, uint256 maxGasReimbursement);
    event EthWithdrawnByOwner(address indexed owner, uint256 amount);

    error NoPolicy();
    error PolicyExists();
    error ZeroAmount();
    error OverPerWithdrawalCap();
    error OverAllowance();
    error CooldownActive();
    error ReceiverNotAllowed();
    error BadSignature();
    error Expired();
    error BadNonce();
    error PermissionlessNeedsAllowlist();
    error InsufficientVault();
    error EthTransferFailed();
    error CapAboveAllowance();
    error GasReimbursementFailed();
    error GasTankEmpty();

    constructor() EIP712("Withdrawer", "1") {}

    // ---------------------------------------------------------------- views

    function policyOf(address owner, address token) external view returns (Policy memory) {
        return _policies[owner][token];
    }

    /// @notice Mirrors every on-chain check so a client can dry-run for free.
    function canWithdraw(
        address owner,
        address token,
        uint256 amount,
        address receiver
    ) external view returns (bool ok, string memory reason) {
        Policy storage p = _policies[owner][token];
        if (!p.exists) return (false, "no authorisation on record for this wallet");
        if (amount == 0) return (false, "amount is zero");
        if (amount > p.maxPerWithdrawal) return (false, "amount exceeds the per-withdrawal cap");
        if (amount > p.allowance) return (false, "amount exceeds the remaining allowance");
        if (block.timestamp < uint256(p.lastWithdrawal) + p.cooldown) {
            return (false, "cooldown still active");
        }
        if (p.allowlistOnly && !allowlisted[owner][token][receiver]) {
            return (false, "receiver is not on the allowlist");
        }
        if (token == NATIVE) {
            if (ethVault[owner] < amount) return (false, "owner's ETH vault balance is too low");
        } else {
            if (IERC20(token).balanceOf(owner) < amount) return (false, "owner's token balance is too low");
            if (IERC20(token).allowance(owner, address(this)) < amount) {
                return (false, "ERC-20 approve() to this contract is too low");
            }
        }
        return (true, "");
    }

    /// @notice What a withdrawal would currently reimburse its broadcaster.
    function reimbursementPreview(
        address owner,
        address token,
        uint256 gasPrice,
        uint256 gasUsed
    ) external view returns (uint256) {
        Policy storage p = _policies[owner][token];
        if (!p.exists || p.maxGasReimbursement == 0) return 0;
        uint256 spent = (gasUsed + GAS_OVERHEAD) * gasPrice;
        if (spent > p.maxGasReimbursement) spent = p.maxGasReimbursement;
        if (spent > gasTank[owner]) spent = gasTank[owner];
        return spent;
    }

    function digestFor(
        address owner,
        address token,
        uint256 amount,
        address receiver,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(WITHDRAW_TYPEHASH, owner, token, amount, receiver, nonce, deadline))
            );
    }

    // ------------------------------------------------- step 1: authorise once

    /**
     * @notice The single owner-signed step. Everything after this is keyless.
     * @param token             ERC-20 address, or address(0) for native ETH.
     * @param operator          hot key allowed to trigger pulls; address(0) for
     *                          permissionless, which then requires receivers.
     * @param receivers         destination allowlist; empty means "anywhere",
     *                          which is only permitted alongside an operator.
     */
    function authorize(
        address token,
        address operator,
        uint256 allowance,
        uint256 maxPerWithdrawal,
        uint64 cooldown,
        address[] calldata receivers,
        uint256 maxGasReimbursement
    ) external payable {
        Policy storage p = _policies[msg.sender][token];
        if (p.exists) revert PolicyExists();
        if (maxPerWithdrawal > allowance) revert CapAboveAllowance();
        if (operator == address(0) && receivers.length == 0) revert PermissionlessNeedsAllowlist();

        p.operator = operator;
        p.allowance = allowance;
        p.maxPerWithdrawal = maxPerWithdrawal;
        p.cooldown = cooldown;
        p.lastWithdrawal = 0;
        p.allowlistOnly = receivers.length > 0;
        p.maxGasReimbursement = maxGasReimbursement;
        p.exists = true;

        for (uint256 i = 0; i < receivers.length; i++) {
            allowlisted[msg.sender][token][receivers[i]] = true;
            emit ReceiverSet(msg.sender, token, receivers[i], true);
        }

        // For an ETH policy the deposit is the principal being made available;
        // for a token policy the only reason to send ETH is to fund gas.
        if (msg.value > 0) {
            if (token == NATIVE) {
                ethVault[msg.sender] += msg.value;
                emit EthDeposited(msg.sender, msg.value);
            } else {
                gasTank[msg.sender] += msg.value;
                emit GasDeposited(msg.sender, msg.value);
            }
        }

        emit Authorized(msg.sender, token, operator, allowance, maxPerWithdrawal, cooldown, p.allowlistOnly);
    }

    // ------------------------------------------ step 2: keyless withdrawals

    /**
     * @notice THE CALL. Withdrawer, amount, receiver -- no owner key.
     * @param signature EIP-712 signature from the operator. Pass "" when the
     *                  policy is permissionless.
     */
    function withdraw(
        address owner,
        address token,
        uint256 amount,
        address receiver,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 gasStart = gasleft();
        Policy storage p = _policies[owner][token];
        if (!p.exists) revert NoPolicy();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        if (amount > p.maxPerWithdrawal) revert OverPerWithdrawalCap();
        if (amount > p.allowance) revert OverAllowance();
        if (block.timestamp < uint256(p.lastWithdrawal) + p.cooldown) revert CooldownActive();
        if (p.allowlistOnly && !allowlisted[owner][token][receiver]) revert ReceiverNotAllowed();

        uint256 nonce = nonces[owner][token];

        if (p.operator != address(0)) {
            bytes32 digest = digestFor(owner, token, amount, receiver, nonce, deadline);
            address signer = ECDSA.recover(digest, signature);
            if (signer != p.operator) revert BadSignature();
        }

        // effects before interactions
        nonces[owner][token] = nonce + 1;
        p.allowance -= amount;
        p.lastWithdrawal = uint64(block.timestamp);

        if (token == NATIVE) {
            uint256 vault = ethVault[owner];
            if (vault < amount) revert InsufficientVault();
            ethVault[owner] = vault - amount;
            (bool sent, ) = receiver.call{value: amount}("");
            if (!sent) revert EthTransferFailed();
        } else {
            // Gated by the owner's own ERC-20 approve(). Nothing else is reachable.
            IERC20(token).safeTransferFrom(owner, receiver, amount);
        }

        emit Withdrawn(owner, token, receiver, amount, nonce, msg.sender);

        // THE SENDER WALLET PAYS THE GAS.
        // Whoever broadcast this is refunded, in ETH, out of the owner's gas
        // tank -- so a relayer is only ever fronting the fee, never bearing it.
        _reimburse(owner, p.maxGasReimbursement, gasStart);
    }

    /**
     * @dev Refunds `msg.sender` for the gas this transaction burned, bounded by
     *      three independent limits: the owner's per-withdrawal cap, the actual
     *      measured gas, and the balance of the gas tank. Runs last, after every
     *      state change, and under the reentrancy guard.
     */
    function _reimburse(address owner, uint256 cap, uint256 gasStart) private {
        if (cap == 0) return; // reimbursement disabled for this policy

        uint256 tank = gasTank[owner];
        if (tank == 0) return; // nothing to pay from; the caller absorbs it

        uint256 spent = (gasStart - gasleft() + GAS_OVERHEAD) * tx.gasprice;
        if (spent > cap) spent = cap;
        if (spent > tank) spent = tank;
        if (spent == 0) return;

        gasTank[owner] = tank - spent;
        (bool sent, ) = msg.sender.call{value: spent}("");
        if (!sent) revert GasReimbursementFailed();

        emit GasReimbursed(owner, msg.sender, spent);
    }

    // -------------------------------------------------- owner administration

    function setLimits(
        address token,
        uint256 allowance,
        uint256 maxPerWithdrawal,
        uint64 cooldown
    ) external {
        Policy storage p = _policies[msg.sender][token];
        if (!p.exists) revert NoPolicy();
        if (maxPerWithdrawal > allowance) revert CapAboveAllowance();
        p.allowance = allowance;
        p.maxPerWithdrawal = maxPerWithdrawal;
        p.cooldown = cooldown;
        emit LimitsChanged(msg.sender, token, allowance, maxPerWithdrawal, cooldown);
    }

    function setReceiver(address token, address receiver, bool allowed) external {
        Policy storage p = _policies[msg.sender][token];
        if (!p.exists) revert NoPolicy();
        allowlisted[msg.sender][token][receiver] = allowed;
        if (allowed) p.allowlistOnly = true;
        emit ReceiverSet(msg.sender, token, receiver, allowed);
    }

    function setGasReimbursement(address token, uint256 maxGasReimbursement) external {
        Policy storage p = _policies[msg.sender][token];
        if (!p.exists) revert NoPolicy();
        p.maxGasReimbursement = maxGasReimbursement;
        emit GasReimbursementChanged(msg.sender, token, maxGasReimbursement);
    }

    function setOperator(address token, address operator) external {
        Policy storage p = _policies[msg.sender][token];
        if (!p.exists) revert NoPolicy();
        if (operator == address(0) && !p.allowlistOnly) revert PermissionlessNeedsAllowlist();
        p.operator = operator;
        emit OperatorChanged(msg.sender, token, operator);
    }

    /// @notice Kill switch. The allowance is zeroed and the policy deleted.
    function revoke(address token) external {
        Policy storage p = _policies[msg.sender][token];
        if (!p.exists) revert NoPolicy();
        delete _policies[msg.sender][token];
        emit Revoked(msg.sender, token);
    }

    // --------------------------------------------------------- ETH vault

    /// @notice Top up the ETH used to reimburse whoever broadcasts withdrawals.
    function depositGas() external payable {
        gasTank[msg.sender] += msg.value;
        emit GasDeposited(msg.sender, msg.value);
    }

    /// @notice The owner can always reclaim unspent gas money.
    function withdrawGas(uint256 amount) external nonReentrant {
        uint256 tank = gasTank[msg.sender];
        if (tank < amount) revert InsufficientVault();
        gasTank[msg.sender] = tank - amount;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert EthTransferFailed();
        emit GasWithdrawnByOwner(msg.sender, amount);
    }

    function depositEth() external payable {
        ethVault[msg.sender] += msg.value;
        emit EthDeposited(msg.sender, msg.value);
    }

    /// @notice The owner can always pull their own ETH back out.
    function withdrawEth(uint256 amount) external nonReentrant {
        uint256 vault = ethVault[msg.sender];
        if (vault < amount) revert InsufficientVault();
        ethVault[msg.sender] = vault - amount;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert EthTransferFailed();
        emit EthWithdrawnByOwner(msg.sender, amount);
    }

    receive() external payable {
        ethVault[msg.sender] += msg.value;
        emit EthDeposited(msg.sender, msg.value);
    }
}
