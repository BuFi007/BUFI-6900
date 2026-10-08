// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TreasuryRedeemConduit
 * @notice Exit rail for a treasury Earn position. Plan 354: `TreasuryConduit.execute`
 * can only pull ERC-3009 `tokenIn`. Vault shares have no 3009, and an MSCA cannot
 * produce an ecrecover ERC-2612 permit. This contract has NO arbitrary-call path
 * and NEVER lives on `TreasuryConduit` — that contract's permissionless `execute`
 * must never hold share allowances (cross-tenant `transferFrom` theft).
 *
 * Sequence:
 *   1. The treasury MSCA `approve`s this contract for `shares` (AddressBook
 *      admits `approve` once this address is allowlisted).
 *   2. The quorum signs the EIP-712 `Redeem` struct (Circle 1271 / replay-safe
 *      hash, same envelope as ERC-3009).
 *   3. Anyone (the agent DCW as gas payer today) calls `redeem`. Shares burn
 *      from the treasury; assets return to the treasury. A floor miss reverts
 *      the whole call; the nonce stays unused.
 */
contract TreasuryRedeemConduit is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant REDEEM_TYPEHASH = keccak256(
        "Redeem(address treasury,address vault,uint256 shares,uint256 minAssets,uint256 deadline,uint256 nonce)"
    );

    mapping(address vault => bool allowed) public vaults;
    mapping(address treasury => mapping(uint256 nonce => bool used)) public usedNonces;

    event VaultSet(address indexed vault, bool allowed);
    event Redeemed(
        address indexed treasury, address indexed vault, uint256 shares, uint256 assets, uint256 nonce
    );

    error ZeroAddress();
    error VaultNotRegistered(address vault);
    error ZeroShares();
    error RedeemExpired(uint256 deadline, uint256 now_);
    error NonceUsed(uint256 nonce);
    error InvalidQuorumSignature();
    error BelowFloor(uint256 gained, uint256 minAssets);

    constructor(address initialOwner) Ownable(initialOwner) EIP712("TreasuryRedeemConduit", "1") {}

    function setVault(address vault, bool allowed) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        vaults[vault] = allowed;
        emit VaultSet(vault, allowed);
    }

    function redeemHash(
        address treasury,
        address vault,
        uint256 shares,
        uint256 minAssets,
        uint256 deadline,
        uint256 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(REDEEM_TYPEHASH, treasury, vault, shares, minAssets, deadline, nonce))
        );
    }

    function redeem(
        address treasury,
        address vault,
        uint256 shares,
        uint256 minAssets,
        uint256 deadline,
        uint256 nonce,
        bytes calldata quorumSig
    ) external nonReentrant {
        if (!vaults[vault]) revert VaultNotRegistered(vault);
        if (shares == 0) revert ZeroShares();
        if (block.timestamp > deadline) revert RedeemExpired(deadline, block.timestamp);
        if (usedNonces[treasury][nonce]) revert NonceUsed(nonce);

        bytes32 digest = redeemHash(treasury, vault, shares, minAssets, deadline, nonce);
        if (IERC1271(treasury).isValidSignature(digest, quorumSig) != IERC1271.isValidSignature.selector) {
            revert InvalidQuorumSignature();
        }

        usedNonces[treasury][nonce] = true;

        address asset = IERC4626(vault).asset();
        uint256 before = IERC20(asset).balanceOf(treasury);
        IERC4626(vault).redeem(shares, treasury, treasury);
        uint256 gained = IERC20(asset).balanceOf(treasury) - before;
        if (gained < minAssets) revert BelowFloor(gained, minAssets);

        emit Redeemed(treasury, vault, shares, gained, nonce);
    }
}
