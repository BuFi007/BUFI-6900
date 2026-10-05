// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Circle Gateway TransferSpec (EIP-712 typed struct).
struct TransferSpec {
    uint32 version;
    uint32 sourceDomain;
    uint32 destinationDomain;
    bytes32 sourceContract;
    bytes32 destinationContract;
    bytes32 sourceToken;
    bytes32 destinationToken;
    bytes32 sourceDepositor;
    bytes32 destinationRecipient;
    bytes32 sourceSigner;
    bytes32 destinationCaller;
    uint256 value;
    bytes32 salt;
    bytes hookData;
}

/// @dev Circle Gateway BurnIntent (EIP-712 typed struct).
struct BurnIntent {
    uint256 maxBlockHeight;
    uint256 maxFee;
    TransferSpec spec;
}

/// @dev The scalar limits one burn intent is checked against. Set-membership checks (source token, destination
///      token, destination domain, recipient, destination caller) stay with the caller, because each integration
///      keeps its sets in its own storage layout (contract-global for GatewayTreasury, per-account for the ERC-6900
///      guard).
struct IntentLimits {
    /// The GatewayWallet the intent must burn from (TransferSpec.sourceContract).
    address gatewayWallet;
    /// This chain's Gateway domain (TransferSpec.sourceDomain). Pinned so a signed intent cannot name another chain.
    uint32 sourceDomain;
    /// The account whose Gateway balance is burned; must be both sourceDepositor AND sourceSigner.
    address depositor;
    /// Furthest maxBlockHeight may sit above block.number.
    uint256 maxExpiryBlocks;
    /// Upper bound on TransferSpec.value (inclusive). Zero value is always refused.
    uint256 perIntentCap;
    /// Upper bound on BurnIntent.maxFee (inclusive). NOTE: Gateway debits `value + fee` (fee <= maxFee) from the
    /// depositor's balance, so ONE approved intent can take up to `perIntentCap + maxFeeCap`, not `perIntentCap`.
    /// The fee is not bounded relative to value: Gateway's per-transfer fee floor on Arc (~2 USDC) exceeds small
    /// transfer values, so a ratio bound would refuse every small transfer there.
    uint256 maxFeeCap;
}

/// @title GatewayIntentPolicy
/// @author BUFI
/// @notice The Circle Gateway intent policy shared by `GatewayTreasury` (a standalone weighted-multisig contract) and
///         `GatewayIntentGuardPlugin` (the same policy packaged as an ERC-6900 hook for Circle MSCAs): re-derive the
///         EIP-712 digest of a carried BurnIntent / ERC-3009 ReceiveWithAuthorization, and run the scalar checks.
/// @dev New, unaudited BUFI code. Every function is `internal`, so the library is inlined into each consumer and adds
///      no deployment or DELEGATECALL surface.
library GatewayIntentPolicy {
    bytes32 internal constant TRANSFER_SPEC_TYPEHASH = keccak256(
        "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 internal constant BURN_INTENT_TYPEHASH = keccak256(
        "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH_NOCHAIN = keccak256("EIP712Domain(string name,string version)");

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH_FULL =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev Gateway's domain: name "GatewayWallet", version "1", NO chainId and NO verifyingContract (verified live,
    ///      docs/GATEWAY-TREASURY-CANARY.md). The same separator on every chain is what lets one intent be relayed.
    bytes32 internal constant GATEWAY_DOMAIN_SEPARATOR =
        keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH_NOCHAIN, keccak256(bytes("GatewayWallet")), keccak256(bytes("1"))));

    bytes4 internal constant ERC1271_MAGICVALUE = 0x1626ba7e;

    /// @dev Gateway's only non-EVM domain today. Its recipients, callers and tokens are 32-byte Solana keys.
    uint32 internal constant SOLANA_DOMAIN = 5;

    /// @notice EIP-712 digest Gateway asks the depositor to sign for `intent`.
    function burnIntentDigest(BurnIntent memory intent) internal pure returns (bytes32) {
        // abi.encode of static words is plain concatenation, so encoding the 15 words in two halves yields the
        // exact same pre-image while keeping each Yul encoder under the stack limit in every calling context.
        bytes32 specHash = keccak256(
            bytes.concat(
                abi.encode(
                    TRANSFER_SPEC_TYPEHASH,
                    intent.spec.version,
                    intent.spec.sourceDomain,
                    intent.spec.destinationDomain,
                    intent.spec.sourceContract,
                    intent.spec.destinationContract,
                    intent.spec.sourceToken,
                    intent.spec.destinationToken
                ),
                abi.encode(
                    intent.spec.sourceDepositor,
                    intent.spec.destinationRecipient,
                    intent.spec.sourceSigner,
                    intent.spec.destinationCaller,
                    intent.spec.value,
                    intent.spec.salt,
                    keccak256(intent.spec.hookData)
                )
            )
        );
        bytes32 intentHash = keccak256(abi.encode(BURN_INTENT_TYPEHASH, intent.maxBlockHeight, intent.maxFee, specHash));
        return keccak256(abi.encodePacked("\x19\x01", GATEWAY_DOMAIN_SEPARATOR, intentHash));
    }

    /// @notice EIP-712 digest of an ERC-3009 ReceiveWithAuthorization on `token` (USDC-style domain:
    ///         name/version/chainId/verifyingContract = token).
    function receiveWithAuthorizationDigest(
        string memory tokenName,
        string memory tokenVersion,
        address token,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH_FULL,
                keccak256(bytes(tokenName)),
                keccak256(bytes(tokenVersion)),
                block.chainid,
                token
            )
        );
        bytes32 structHash = keccak256(abi.encode(RWA_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @notice The scalar half of the burn-intent policy. Returns false (never reverts) on any violation.
    /// @return ok True when every scalar rule holds.
    /// @return sourceToken The (canonical) source token address, for the caller's token-set lookup.
    function checkIntentShape(BurnIntent memory intent, IntentLimits memory limits)
        internal
        view
        returns (bool ok, address sourceToken)
    {
        if (intent.spec.version != 1) return (false, address(0));
        if (intent.spec.sourceDomain != limits.sourceDomain) return (false, address(0));
        if (intent.spec.sourceContract != toBytes32(limits.gatewayWallet)) return (false, address(0));
        if (intent.spec.sourceDepositor != toBytes32(limits.depositor)) return (false, address(0));
        if (intent.spec.sourceSigner != toBytes32(limits.depositor)) return (false, address(0));

        // Bounded expiry: a signed intent is a bearer withdrawal until it expires; refuse long-lived ones.
        // Written as a subtraction so a huge maxExpiryBlocks cannot overflow block.number + window.
        if (intent.maxBlockHeight > block.number && intent.maxBlockHeight - block.number > limits.maxExpiryBlocks) {
            return (false, address(0));
        }

        // The token must be a canonical left-padded address: dirty upper bytes would truncate to an allowed token.
        if (!isCanonicalAddress(intent.spec.sourceToken)) return (false, address(0));

        if (intent.spec.hookData.length != 0) return (false, address(0));
        if (intent.spec.value == 0 || intent.spec.value > limits.perIntentCap) return (false, address(0));
        if (intent.maxFee > limits.maxFeeCap) return (false, address(0));

        return (true, address(uint160(uint256(intent.spec.sourceToken))));
    }

    /// @notice ERC-1271 check against a contract signer that never reverts and never copies more than 32 bytes of
    ///         return data (no return-bomb). `gasCap` bounds the nested call; running out of gas reads as invalid.
    function isValidERC1271(address signer, bytes32 hash, bytes memory sig, uint256 gasCap)
        internal
        view
        returns (bool valid)
    {
        if (signer.code.length == 0) return false;
        bytes memory callData = abi.encodeWithSelector(ERC1271_MAGICVALUE, hash, sig);
        assembly ("memory-safe") {
            // Scratch space (0x00..0x20) receives the first return word.
            mstore(0x00, 0)
            let success := staticcall(gasCap, signer, add(callData, 0x20), mload(callData), 0x00, 0x20)
            valid := and(and(success, iszero(lt(returndatasize(), 0x20))), eq(mload(0x00), shl(224, 0x1626ba7e)))
        }
    }

    /// @notice Whether `domain` uses 20-byte (EVM) addresses. Every domain except Solana is treated as EVM, so a
    ///         future non-EVM domain fails CLOSED (its 32-byte keys are refused) until it is added here.
    function isEvmDomain(uint32 domain) internal pure returns (bool) {
        return domain != SOLANA_DOMAIN;
    }

    /// @notice Whether `word` (a destination recipient, caller or token) has the address shape of `domain`: a
    ///         canonical non-zero left-padded address on an EVM domain, a word with its upper 96 bits set on Solana.
    ///         An EVM address on Solana is a left-padded key no one controls; a Solana key on an EVM domain is
    ///         truncated by the minter to an address no one controls. A flat allowlist holding both kinds would
    ///         otherwise admit either on either domain.
    function matchesDomainShape(uint32 domain, bytes32 word) internal pure returns (bool) {
        if (word == bytes32(0)) return false;
        return isEvmDomain(domain) ? isCanonicalAddress(word) : !isCanonicalAddress(word);
    }

    function isCanonicalAddress(bytes32 value) internal pure returns (bool) {
        return uint256(value) >> 160 == 0;
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
