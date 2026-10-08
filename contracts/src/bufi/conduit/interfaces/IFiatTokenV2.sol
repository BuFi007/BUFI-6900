// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

/// @notice The two ERC-3009 entry points BUFI relies on, as shipped by Circle's
/// FiatTokenV2_1+ on every chain we run (Arc's NativeFiatTokenV2_2 included).
/// `receiveWithAuthorization` requires `to == msg.sender` and validates ERC-1271
/// signers through SignatureChecker, which is what lets a contract be the payee
/// of a treasury MSCA's quorum-signed authorization.
interface IFiatTokenV2 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
