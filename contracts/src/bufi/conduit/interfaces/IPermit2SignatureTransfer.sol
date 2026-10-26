// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ABI subset of Uniswap's canonical ISignatureTransfer.
/// @dev https://github.com/Uniswap/permit2/blob/main/src/interfaces/ISignatureTransfer.sol
interface IPermit2SignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
