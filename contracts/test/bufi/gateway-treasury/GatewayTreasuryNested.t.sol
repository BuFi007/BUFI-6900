// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../../src/bufi/gateway-treasury/GatewayTreasury.sol";
import "forge-std/src/Test.sol";

import {CircleStackHarness} from "../../harness/CircleStackHarness.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

contract NestedMockGateway {
    function deposit(address, uint256) external {}
    function depositWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata) external {}
    function initiateWithdrawal(address, uint256) external {}
    function withdraw(address) external {}
}

interface INestedERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @dev A one-key smart-account owner (Safe-like): valid iff `signature` is its key's ECDSA signature over `hash`.
contract MiniSafeOwner {
    address public immutable key;

    constructor(address key_) {
        key = key_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(hash, v, r, s) == key ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev Misbehaving contract owners.
contract BadOwner {
    enum Mode {
        WrongMagic,
        Reverts,
        BurnsGas,
        ReturnsBombGarbage,
        ReturnsShort,
        ReturnsDirtyMagic,
        CallsBack
    }

    Mode public mode;
    address public treasury;
    bytes public payload;

    constructor(Mode mode_) {
        mode = mode_;
    }

    function setTreasury(address t) external {
        treasury = t;
    }

    function setPayload(bytes calldata p) external {
        payload = p;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        Mode m = mode;
        if (m == Mode.WrongMagic) return 0x20c13b0b; // the legacy ERC-1271 magic, not the bytes32 one
        if (m == Mode.Reverts) revert("nope");
        if (m == Mode.BurnsGas) {
            uint256 x;
            while (true) {
                x = uint256(keccak256(abi.encode(x)));
            }
        }
        if (m == Mode.ReturnsBombGarbage) {
            assembly {
                return(0, 100000)
            }
        }
        if (m == Mode.ReturnsShort) {
            assembly {
                mstore(0, shl(224, 0x1626ba7e))
                return(0, 4)
            }
        }
        if (m == Mode.ReturnsDirtyMagic) {
            assembly {
                mstore(0, or(shl(224, 0x1626ba7e), 1))
                return(0, 32)
            }
        }
        // CallsBack: re-enters the treasury with the full outer signature (mutual nesting), so every level asks
        // this contract again.
        signature;
        return INestedERC1271(treasury).isValidSignature(hash, payload);
    }
}

/// @dev FiatToken-style ERC-3009 receiver that asks a contract `from` via ERC-1271 (staticcall, like USDC).
contract NestedFiatToken {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function digest(address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 ds =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USDC"), keccak256("2"), block.chainid, address(this)));
        return keccak256(
            abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(RWA_TYPEHASH, from, to, value, va, vb, nonce)))
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 va,
        uint256 vb,
        bytes32 nonce,
        bytes calldata sig
    ) external view returns (bool) {
        bytes32 d = digest(from, to, value, va, vb, nonce);
        (bool ok, bytes memory ret) = from.staticcall(abi.encodeCall(INestedERC1271.isValidSignature, (d, sig)));
        return ok && ret.length == 32 && bytes4(ret) == bytes4(0x1626ba7e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

abstract contract NestedSigBuilder is Test {
    bytes32 internal constant DEST_RECIPIENT =
        bytes32(uint256(0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA11));
    bytes32 internal constant DEST_TOKEN =
        bytes32(uint256(0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB11));
    // DEST_RECIPIENT / DEST_TOKEN are 32-byte (Solana-shaped) words, so the destination is Solana (domain 5).
    uint32 internal constant DEST_DOMAIN = 5;
    bytes32 internal constant DEST_MINTER =
        bytes32(uint256(0x6d696e7465726d696e7465726d696e7465726d696e7465726d696e746572aaaa));
    uint256 internal constant EXPIRY = 1_250_000;
    uint32 internal constant TIMELOCK = 1 hours;

    /// @dev One owner's contribution to an ownerSigs blob.
    struct Part {
        address owner;
        bool isContract;
        bytes sig; // 65-byte ECDSA for an EOA, arbitrary bytes for a contract owner
    }

    /// @dev Sorts by owner address and encodes the Safe-style blob GatewayTreasury._checkWeightedSigs expects.
    function _encode(Part[] memory parts) internal pure returns (bytes memory blob) {
        for (uint256 i = 1; i < parts.length; i++) {
            Part memory p = parts[i];
            uint256 j = i;
            while (j > 0 && parts[j - 1].owner > p.owner) {
                parts[j] = parts[j - 1];
                j--;
            }
            parts[j] = p;
        }
        uint256 offset = parts.length * 65;
        bytes memory statics;
        bytes memory dynamics;
        for (uint256 i = 0; i < parts.length; i++) {
            if (parts[i].isContract) {
                statics = bytes.concat(
                    statics, abi.encodePacked(bytes32(uint256(uint160(parts[i].owner))), bytes32(offset), uint8(0))
                );
                bytes memory dyn = abi.encodePacked(uint256(parts[i].sig.length), parts[i].sig);
                dynamics = bytes.concat(dynamics, dyn);
                offset += dyn.length;
            } else {
                statics = bytes.concat(statics, parts[i].sig);
            }
        }
        blob = bytes.concat(statics, dynamics);
    }

    function _eoa(uint256 pk, bytes32 hash) internal pure returns (Part memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return Part(vm.addr(pk), false, abi.encodePacked(r, s, v));
    }

    function _contract(address owner, bytes memory sig) internal pure returns (Part memory) {
        return Part(owner, true, sig);
    }

    function _parts1(Part memory a) internal pure returns (Part[] memory p) {
        p = new Part[](1);
        p[0] = a;
    }

    function _parts2(Part memory a, Part memory b) internal pure returns (Part[] memory p) {
        p = new Part[](2);
        p[0] = a;
        p[1] = b;
    }

    function _parts3(Part memory a, Part memory b, Part memory c) internal pure returns (Part[] memory p) {
        p = new Part[](3);
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }

    function _deploy(address gw, address token, address[] memory owners, uint16[] memory weights, uint256 threshold)
        internal
        returns (GatewayTreasury)
    {
        bytes32[] memory recipients = new bytes32[](1);
        recipients[0] = DEST_RECIPIENT;
        uint32[] memory domains = new uint32[](1);
        domains[0] = DEST_DOMAIN;
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        string[] memory names = new string[](1);
        names[0] = "USDC";
        string[] memory versions = new string[](1);
        versions[0] = "2";
        bytes32[] memory destTokens = new bytes32[](1);
        destTokens[0] = DEST_TOKEN;
        return new GatewayTreasury(
            SignerParams({owners: owners, weights: weights, thresholdWeight: threshold, gatewayWallet: gw}),
            PolicyParams({
                allowedRecipients: recipients,
                allowedDestinationDomains: domains,
                tokenAddresses: tokens,
                tokenNames: names,
                tokenVersions: versions,
                allowedDestinationTokens: destTokens,
                perIntentCap: 2e6,
                maxFeeCap: 2.01e6,
                adminTimelock: TIMELOCK,
                maxExpiryBlocks: EXPIRY,
                localDomain: 26,
                destinationMinters: _one(DEST_MINTER),
                allowedDestinationCallers: new bytes32[](0)
            })
        );
    }

    function _one(bytes32 v) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = v;
    }

    function _intent(GatewayTreasury t, address gw, address token)
        internal
        view
        returns (bytes32 hash, BurnIntent memory intent)
    {
        intent = BurnIntent({
            maxBlockHeight: block.number + 1_211_599,
            maxFee: 2.01e6,
            spec: TransferSpec({
                version: 1,
                sourceDomain: 26,
                destinationDomain: DEST_DOMAIN,
                sourceContract: bytes32(uint256(uint160(gw))),
                destinationContract: DEST_MINTER,
                sourceToken: bytes32(uint256(uint160(token))),
                destinationToken: DEST_TOKEN,
                sourceDepositor: bytes32(uint256(uint160(address(t)))),
                destinationRecipient: DEST_RECIPIENT,
                sourceSigner: bytes32(uint256(uint160(address(t)))),
                destinationCaller: bytes32(0),
                value: 1e6,
                salt: keccak256("nested"),
                hookData: ""
            })
        });
        hash = GatewayIntentPolicy.burnIntentDigest(intent);
    }

    function _wrap(BurnIntent memory intent, bytes memory ownerSigs) internal pure returns (bytes memory) {
        return abi.encode(uint8(0), abi.encode(intent), ownerSigs);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// § Nested contract owners: mocks
// ─────────────────────────────────────────────────────────────────────────────

contract GatewayTreasuryNestedOwnersTest is NestedSigBuilder {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    uint256 internal constant PK_A = 0xA11CE; // EOA owner, weight 2
    uint256 internal constant PK_B = 0xB0B; // EOA owner, weight 1
    uint256 internal constant PK_SAFE = 0x5AFE; // key behind the MiniSafe contract owner

    NestedMockGateway internal gw;
    address internal token = address(0x3600000000000000000000000000000000000000);
    MiniSafeOwner internal safeOwner;
    GatewayTreasury internal t; // owners: A=2, B=1, Safe=1, threshold 3

    function setUp() public {
        gw = new NestedMockGateway();
        safeOwner = new MiniSafeOwner(vm.addr(PK_SAFE));
        address[] memory owners = new address[](3);
        uint16[] memory w = new uint16[](3);
        owners[0] = vm.addr(PK_A);
        owners[1] = vm.addr(PK_B);
        owners[2] = address(safeOwner);
        w[0] = 2;
        w[1] = 1;
        w[2] = 1;
        t = _deploy(address(gw), token, owners, w, 3);
    }

    function _safeSig(bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_SAFE, hash);
        return abi.encodePacked(r, s, v);
    }

    // ── Mixed quorum
    // ──────────────────────────────────────────────────────────

    function test_nested_mixedEoaAndContract_reachesThreshold() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(safeOwner), _safeSig(h))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), MAGIC);
    }

    function test_nested_allThreeOwners_valid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts3(_eoa(PK_A, h), _eoa(PK_B, h), _contract(address(safeOwner), _safeSig(h))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), MAGIC);
    }

    function test_nested_contractPlusB_belowThreshold() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_B, h), _contract(address(safeOwner), _safeSig(h))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID); // weight 2 < 3
    }

    function test_nested_contractOwnerWrongInnerSig_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob =
            _encode(_parts2(_eoa(PK_A, h), _contract(address(safeOwner), _safeSig(bytes32(uint256(1))))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_policyStillApplies_recipientNotAllowed() public view {
        (, BurnIntent memory intent) = _intent(t, address(gw), token);
        intent.spec.destinationRecipient = bytes32(uint256(0xBEEF));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(intent);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(safeOwner), _safeSig(h))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_contractSlotOutOfOrder_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        // Hand-build with the two owners in DESCENDING order.
        Part memory a = _eoa(PK_A, h);
        Part memory c = _contract(address(safeOwner), _safeSig(h));
        (Part memory lo, Part memory hi) = a.owner < c.owner ? (a, c) : (c, a);
        bytes memory blob = _rawTwo(hi, lo);
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
        // Sanity: the ascending order of the same parts is valid.
        assertEq(t.isValidSignature(h, _wrap(intent, _rawTwo(lo, hi))), MAGIC);
    }

    /// @dev Two slots in the given order, dynamic part (if any) appended.
    function _rawTwo(Part memory first, Part memory second) internal pure returns (bytes memory) {
        bytes memory statics;
        bytes memory dyn;
        Part[2] memory ps = [first, second];
        for (uint256 i = 0; i < 2; i++) {
            if (ps[i].isContract) {
                statics = bytes.concat(
                    statics,
                    abi.encodePacked(
                        bytes32(uint256(uint160(ps[i].owner))), bytes32(uint256(130 + dyn.length)), uint8(0)
                    )
                );
                dyn = bytes.concat(dyn, abi.encodePacked(uint256(ps[i].sig.length), ps[i].sig));
            } else {
                statics = bytes.concat(statics, ps[i].sig);
            }
        }
        return bytes.concat(statics, dyn);
    }

    function test_nested_kind1_receiveWithAuthorization_viaContractOwner() public {
        NestedFiatToken fiat = new NestedFiatToken();
        address[] memory owners = new address[](2);
        uint16[] memory w = new uint16[](2);
        owners[0] = vm.addr(PK_A);
        owners[1] = address(safeOwner);
        w[0] = 2;
        w[1] = 1;
        GatewayTreasury t2 = _deploy(address(gw), address(fiat), owners, w, 3);

        uint256 va = 0;
        uint256 vb = block.timestamp + 1 days;
        bytes32 nonce = keccak256("rwa");
        bytes32 d = fiat.digest(address(t2), address(gw), 1e6, va, vb, nonce);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, d), _contract(address(safeOwner), _safeSig(d))));
        bytes memory sig = abi.encode(uint8(1), abi.encode(address(t2), address(gw), uint256(1e6), va, vb, nonce), blob);
        assertTrue(fiat.receiveWithAuthorization(address(t2), address(gw), 1e6, va, vb, nonce, sig));

        // Contract owner's inner signature over a different digest -> refused by the token.
        bytes memory bad = _encode(_parts2(_eoa(PK_A, d), _contract(address(safeOwner), _safeSig(bytes32(0)))));
        bytes memory badSig =
            abi.encode(uint8(1), abi.encode(address(t2), address(gw), uint256(1e6), va, vb, nonce), bad);
        assertFalse(fiat.receiveWithAuthorization(address(t2), address(gw), 1e6, va, vb, nonce, badSig));
    }

    function test_nested_adminQueue_acceptsContractOwnerSignature() public {
        bytes memory call_ = abi.encodeWithSignature("setPerIntentCap(uint256)", 3e6);
        bytes32 digest = _adminDigest(t, keccak256(call_), 7);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, digest), _contract(address(safeOwner), _safeSig(digest))));
        t.queueAdmin(call_, 7, type(uint256).max, blob);
        vm.warp(block.timestamp + TIMELOCK + 1);
        t.executeAdmin(call_, 7);
        assertEq(t.perIntentCap(), 3e6);
    }

    // ── Misbehaving contract owners
    // ───────────────────────────────────────────

    function _treasuryWithBadOwner(BadOwner.Mode mode) internal returns (GatewayTreasury t2, BadOwner bad) {
        bad = new BadOwner(mode);
        address[] memory owners = new address[](2);
        uint16[] memory w = new uint16[](2);
        owners[0] = vm.addr(PK_A);
        owners[1] = address(bad);
        w[0] = 2;
        w[1] = 1;
        t2 = _deploy(address(gw), token, owners, w, 3);
        bad.setTreasury(address(t2));
    }

    function _assertBadOwnerInvalid(BadOwner.Mode mode) internal {
        (GatewayTreasury t2, BadOwner bad) = _treasuryWithBadOwner(mode);
        (bytes32 h, BurnIntent memory intent) = _intent(t2, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(bad), hex"c0ffee")));
        if (mode == BadOwner.Mode.CallsBack) bad.setPayload(_wrap(intent, blob));
        uint256 g = gasleft();
        bytes4 ret = t2.isValidSignature(h, _wrap(intent, blob));
        uint256 used = g - gasleft();
        assertEq(ret, INVALID);
        // Bounded by the nested gas cap (1,000,000) plus the treasury's own work.
        assertLt(used, 1_300_000);
    }

    function test_nested_wrongMagic_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.WrongMagic);
    }

    function test_nested_reverting_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.Reverts);
    }

    function test_nested_outOfGas_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.BurnsGas);
    }

    function test_nested_returnBomb_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.ReturnsBombGarbage);
    }

    function test_nested_shortReturn_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.ReturnsShort);
    }

    function test_nested_dirtyMagicWord_invalid() public {
        _assertBadOwnerInvalid(BadOwner.Mode.ReturnsDirtyMagic);
    }

    function test_nested_eoaInContractSlot_invalid() public {
        // v = 0 slot naming an address with no code (here: EOA owner B, weight 1) is invalid.
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_B, h);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(vm.addr(PK_B), abi.encodePacked(r, s, v))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    // ── Recursion
    // ────────────────────────────────────────────────────────────

    function test_nested_selfAsOwner_refusedAtConstruction() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address[] memory owners = new address[](2);
        uint16[] memory w = new uint16[](2);
        owners[0] = vm.addr(PK_A);
        owners[1] = predicted;
        w[0] = 2;
        w[1] = 1;
        vm.expectRevert(GatewayTreasury.InvalidOwnerSet.selector);
        this.deployExternal(owners, w);
    }

    function deployExternal(address[] memory owners, uint16[] memory w) external returns (GatewayTreasury) {
        // The test contract's nonce is what the prediction used, so deploy from `address(this)` via a plain call.
        return _deploy(address(gw), token, owners, w, 3);
    }

    function test_nested_selfAsOwner_refusedBySetOwners() public {
        address[] memory owners = new address[](2);
        uint16[] memory w = new uint16[](2);
        owners[0] = vm.addr(PK_A);
        owners[1] = address(t);
        w[0] = 2;
        w[1] = 1;
        bytes memory call_ = abi.encodeCall(GatewayTreasury.setOwners, (owners, w, 3));
        bytes32 digest = _adminDigest(t, keccak256(call_), 9);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, digest), _eoa(PK_B, digest)));
        t.queueAdmin(call_, 9, type(uint256).max, blob);
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatewayTreasury.SelfCallFailed.selector,
                abi.encodeWithSelector(GatewayTreasury.InvalidOwnerSet.selector)
            )
        );
        t.executeAdmin(call_, 9);
    }

    function test_nested_selfSlot_invalid() public view {
        // A v = 0 slot naming the treasury itself never recurses: refused before any call.
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(t), hex"01")));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_mutualRecursion_terminatesInvalid() public {
        // Owner contract re-enters the treasury with the same blob; the cycle is cut by gas, never reverts.
        _assertBadOwnerInvalid(BadOwner.Mode.CallsBack);
    }

    // ── Malformed encodings (deterministic)
    // ──────────────────────────────────

    function _validParts(bytes32 h) internal view returns (bytes memory blob, uint256 contractSlot) {
        blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(safeOwner), _safeSig(h))));
        contractSlot = vm.addr(PK_A) < address(safeOwner) ? 1 : 0;
    }

    function _setWord(bytes memory b, uint256 pos, bytes32 word) internal pure {
        assembly {
            mstore(add(add(b, 0x20), pos), word)
        }
    }

    function test_nested_malformed_offsetIntoStaticPart_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob, uint256 cs) = _validParts(h);
        _setWord(blob, cs * 65 + 32, bytes32(uint256(0))); // offset 0: inside the static part
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
        _setWord(blob, cs * 65 + 32, bytes32(uint256(64))); // offset 64 < 130
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_malformed_offsetPastEnd_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob, uint256 cs) = _validParts(h);
        _setWord(blob, cs * 65 + 32, bytes32(blob.length));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
        _setWord(blob, cs * 65 + 32, bytes32(type(uint256).max));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
        _setWord(blob, cs * 65 + 32, bytes32(type(uint256).max - 31));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_malformed_lengthPastEnd_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob,) = _validParts(h);
        _setWord(blob, 130, bytes32(uint256(66))); // claims one byte more than present
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
        _setWord(blob, 130, bytes32(type(uint256).max));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_malformed_misalignedOffset_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob, uint256 cs) = _validParts(h);
        // Shift the dynamic part one byte later: offset 131 leaves a 1-byte gap after the static slots.
        bytes memory shifted = bytes.concat(_head(blob, 130), hex"00", _tail(blob, 130));
        _setWord(shifted, cs * 65 + 32, bytes32(uint256(131)));
        assertEq(t.isValidSignature(h, _wrap(intent, shifted)), INVALID);
    }

    function test_nested_malformed_dirtyOwnerWord_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob, uint256 cs) = _validParts(h);
        _setWord(blob, cs * 65, bytes32(uint256(uint160(address(safeOwner))) | (uint256(1) << 200)));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function test_nested_malformed_trailingBytesAfterEoaSlots_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = bytes.concat(_encode(_parts2(_eoa(PK_A, h), _eoa(PK_B, h))), hex"00");
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), INVALID);
    }

    function _head(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
    }

    function _tail(bytes memory b, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(b.length - from);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = b[from + i];
        }
    }

    // ── Fuzz: never revert
    // ────────────────────────────────────────────────────

    function testFuzz_nested_contractSlotWords_neverRevert(bytes32 ownerWord, bytes32 offsetWord, bytes32 lenWord)
        public
        view
    {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        (bytes memory blob, uint256 cs) = _validParts(h);
        _setWord(blob, cs * 65, ownerWord);
        _setWord(blob, cs * 65 + 32, offsetWord);
        _setWord(blob, 130, lenWord);
        // Must return one of the two values and never revert.
        bytes4 ret = t.isValidSignature(h, _wrap(intent, blob));
        assertTrue(ret == MAGIC || ret == INVALID);
        if (ownerWord != bytes32(uint256(uint160(address(safeOwner))))) assertEq(ret, INVALID);
    }

    function testFuzz_nested_arbitraryOwnerSigs_neverRevert(bytes calldata ownerSigs) public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes4 ret = t.isValidSignature(h, _wrap(intent, ownerSigs));
        assertEq(ret, INVALID);
    }

    function testFuzz_nested_arbitraryV0Slots_neverRevert(uint256 offset, uint256 dynLen, bytes calldata tail)
        public
        view
    {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = bytes.concat(
            abi.encodePacked(bytes32(uint256(uint160(address(safeOwner)))), bytes32(offset), uint8(0)),
            abi.encodePacked(dynLen),
            tail
        );
        bytes4 ret = t.isValidSignature(h, _wrap(intent, blob));
        assertEq(ret, INVALID); // weight 1 < 3 at best
    }

    // ── Admin digest helper
    // ──────────────────────────────────────────────────

    function _adminDigest(GatewayTreasury tr, bytes32 callHash, uint256 nonce) internal view returns (bytes32) {
        bytes32 domSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("GatewayTreasury"),
                keccak256("1"),
                block.chainid,
                address(tr)
            )
        );
        bytes32 structHash =
            keccak256(
                abi.encode(
                    keccak256("AdminOp(bytes32 callHash,uint256 nonce,uint256 deadline,uint256 epoch)"),
                    callHash,
                    nonce,
                    type(uint256).max,
                    tr.adminEpoch()
                )
            );
        return keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// § Nested owner = a REAL Circle ERC-6900 v0.7 MSCA (canonical bytecode, weighted multisig)
// ─────────────────────────────────────────────────────────────────────────────

contract GatewayTreasuryCircleMscaOwnerTest is CircleStackHarness, NestedSigBuilder {
    uint256 internal constant PK_A = 0xA11CE;

    NestedMockGateway internal gw;
    address internal token = address(0x3600000000000000000000000000000000000000);
    UpgradableMSCA internal msca;
    Signer[] internal mscaSigners;
    GatewayTreasury internal t; // owners: EOA A = 2, Circle MSCA = 1, threshold 3

    function setUp() public {
        _deployCircleCanonicalStack();
        gw = new NestedMockGateway();
        Signer[] memory s = _makeSigners("msca-owner", 3);
        for (uint256 i = 0; i < s.length; i++) {
            mscaSigners.push(s[i]);
        }
        msca = _createWeightedMsca(s, _uniformWeights(3, 1), 2, keccak256("nested-owner"));

        address[] memory owners = new address[](2);
        uint16[] memory w = new uint16[](2);
        owners[0] = vm.addr(PK_A);
        owners[1] = address(msca);
        w[0] = 2;
        w[1] = 1;
        t = _deploy(address(gw), token, owners, w, 3);
    }

    /// @dev The MSCA's own ERC-1271 signature: 2-of-3 EOA owners over the plugin's replay-safe hash.
    function _mscaSig(bytes32 hash, uint256 k) internal view returns (bytes memory sig) {
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(msca), hash);
        for (uint256 i = 0; i < k; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(mscaSigners[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function test_circleMscaOwner_mscaItselfValidates() public view {
        bytes32 h = keccak256("probe");
        assertEq(INestedERC1271(address(msca)).isValidSignature(h, _mscaSig(h, 2)), bytes4(0x1626ba7e));
    }

    function test_circleMscaOwner_mixedQuorum_valid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(msca), _mscaSig(h, 2))));
        uint256 g = gasleft();
        bytes4 ret = t.isValidSignature(h, _wrap(intent, blob));
        console.log("isValidSignature EOA + nested Circle MSCA (2-of-3) gas", g - gasleft());
        assertEq(ret, bytes4(0x1626ba7e));
    }

    function test_circleMscaOwner_belowInnerThreshold_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts2(_eoa(PK_A, h), _contract(address(msca), _mscaSig(h, 1))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), bytes4(0xffffffff));
    }

    function test_circleMscaOwner_aloneBelowOuterThreshold_invalid() public view {
        (bytes32 h, BurnIntent memory intent) = _intent(t, address(gw), token);
        bytes memory blob = _encode(_parts1(_contract(address(msca), _mscaSig(h, 3))));
        assertEq(t.isValidSignature(h, _wrap(intent, blob)), bytes4(0xffffffff));
    }
}
