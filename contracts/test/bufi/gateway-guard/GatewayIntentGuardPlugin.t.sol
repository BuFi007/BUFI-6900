// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleStackHarness} from "../../harness/CircleStackHarness.sol";

import {GatewayIntentGuardPlugin} from "../../../src/bufi/gateway-guard/GatewayIntentGuardPlugin.sol";
import {BurnIntent, GatewayIntentPolicy, TransferSpec} from "../../../src/bufi/gateway-guard/GatewayIntentPolicy.sol";
import {GatewayGuardInit, IGatewayIntentGuard} from "../../../src/bufi/gateway-guard/IGatewayIntentGuard.sol";

import {BaseMSCA} from "@circle/msca/6900/v0.7/account/BaseMSCA.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {console} from "forge-std/src/console.sol";

/// @dev ERC-3009 receiver modelled on FiatToken: asks a contract `from` through a STATICCALL to isValidSignature.
contract GuardFiatToken {
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

    function verify(address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce, bytes calldata sig)
        external
        view
        returns (bool)
    {
        bytes32 d = digest(from, to, value, va, vb, nonce);
        (bool ok, bytes memory ret) = from.staticcall(abi.encodeCall(IERC1271.isValidSignature, (d, sig)));
        return ok && ret.length == 32 && bytes4(ret) == bytes4(0x1626ba7e);
    }
}

contract GatewayIntentGuardPluginTest is CircleStackHarness {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    /// The explicitly allowlisted recipient. EVM-shaped: the default intent goes to Base Sepolia (domain 6).
    bytes32 internal constant R_ALLOWED = bytes32(uint256(uint160(0x5555555555555555555555555555555555555555)));
    bytes32 internal constant EVM_MINTER = bytes32(uint256(uint160(0x0022222ABE238Cc2C7Bb1f21003F0a260052475B)));
    address internal constant R_EVM = 0xF7D0520C36717e25c5b77F977A89741d2974589C;
    bytes32 internal constant DEST_TOKEN = bytes32(uint256(uint160(0x036CbD53842c5426634e7929541eC2318f3dCF7e)));
    uint32 internal constant DEST_DOMAIN = 6;
    uint256 internal constant CAP = 2e6;
    uint256 internal constant FEE_CAP = 2.01e6;
    uint256 internal constant EXPIRY = 1_250_000;

    address internal gatewayWallet = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    GuardFiatToken internal usdc;
    GatewayIntentGuardPlugin internal guard;
    UpgradableMSCA internal msca;
    Signer[] internal owners; // weights 2,1,1 threshold 3

    function setUp() public {
        vm.roll(1_000_000);
        _deployCircleCanonicalStack();
        usdc = new GuardFiatToken();
        guard = new GatewayIntentGuardPlugin();
        Signer[] memory s = _makeSigners("treasury-owner", 3);
        for (uint256 i = 0; i < 3; i++) {
            owners.push(s[i]);
        }
        uint256[] memory w = new uint256[](3);
        w[0] = 2;
        w[1] = 1;
        w[2] = 1;
        msca = _createWeightedMsca(s, w, 3, keccak256("gateway-guard"));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _signers() internal view returns (Signer[] memory s) {
        s = new Signer[](owners.length);
        for (uint256 i = 0; i < owners.length; i++) {
            s[i] = owners[i];
        }
    }

    function _init(address addressBook, bool withExplicitRecipient)
        internal
        view
        returns (GatewayGuardInit memory init)
    {
        init.gatewayWallet = gatewayWallet;
        init.perIntentCap = CAP;
        init.maxFeeCap = FEE_CAP;
        init.maxExpiryBlocks = EXPIRY;
        if (withExplicitRecipient) {
            init.recipients = new bytes32[](1);
            init.recipients[0] = R_ALLOWED;
        }
        init.destinationDomains = new uint32[](1);
        init.destinationDomains[0] = DEST_DOMAIN;
        init.destinationMinters = new bytes32[](1);
        init.destinationMinters[0] = EVM_MINTER;
        init.sourceDomain = 26;
        init.tokens = new address[](1);
        init.tokens[0] = address(usdc);
        init.tokenNames = new string[](1);
        init.tokenNames[0] = "USDC";
        init.tokenVersions = new string[](1);
        init.tokenVersions[0] = "2";
        init.destinationTokens = new bytes32[](1);
        init.destinationTokens[0] = DEST_TOKEN;
        init.addressBook = addressBook;
    }

    function _installGuard(GatewayGuardInit memory init) internal returns (bool) {
        return _installPlugin(msca, address(guard), abi.encode(init), _addressBookDependencies(), _signers());
    }

    function _intent() internal view returns (BurnIntent memory intent) {
        intent = BurnIntent({
            maxBlockHeight: block.number + 1_211_599,
            maxFee: FEE_CAP,
            spec: TransferSpec({
                version: 1,
                sourceDomain: 26,
                destinationDomain: DEST_DOMAIN,
                sourceContract: bytes32(uint256(uint160(gatewayWallet))),
                destinationContract: EVM_MINTER,
                sourceToken: bytes32(uint256(uint160(address(usdc)))),
                destinationToken: DEST_TOKEN,
                sourceDepositor: bytes32(uint256(uint160(address(msca)))),
                destinationRecipient: R_ALLOWED,
                sourceSigner: bytes32(uint256(uint160(address(msca)))),
                destinationCaller: bytes32(0),
                value: 1e6,
                salt: keccak256("guard"),
                hookData: ""
            })
        });
    }

    /// @dev Circle multisig signature (first `k` owners, ascending) over the plugin's replay-safe hash.
    function _quorumSig(bytes32 hash, uint256 k) internal view returns (bytes memory sig) {
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(msca), hash);
        for (uint256 i = 0; i < k; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(owners[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function _withEnvelope(bytes memory quorumSig, uint8 kind, bytes memory payload)
        internal
        view
        returns (bytes memory)
    {
        bytes memory env = abi.encode(kind, payload);
        return bytes.concat(quorumSig, env, abi.encode(env.length), guard.ENVELOPE_MAGIC());
    }

    /// @dev Signs `intent` with the owners whose cumulative weight is >= 3 and attaches the envelope.
    function _sign(BurnIntent memory intent) internal view returns (bytes32 h, bytes memory sig) {
        h = GatewayIntentPolicy.burnIntentDigest(intent);
        sig = _withEnvelope(_quorumSig(h, 3), 0, abi.encode(intent));
    }

    /// @dev ERC-1271 exactly as Gateway / USDC call it: a STATICCALL; a revert reads as "invalid".
    function _erc1271(bytes32 h, bytes memory sig) internal view returns (bool ok, bytes4 ret, bytes memory raw) {
        (ok, raw) = address(msca).staticcall(abi.encodeCall(IERC1271.isValidSignature, (h, sig)));
        if (ok && raw.length >= 32) ret = abi.decode(raw, (bytes4));
    }

    function _assertValid(BurnIntent memory intent) internal view {
        (bytes32 h, bytes memory sig) = _sign(intent);
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        assertTrue(ok, "isValidSignature reverted");
        assertEq(ret, MAGIC);
    }

    /// @dev Asserts the account rejects the intent through the guard with exactly `reason`.
    function _assertGuardRejects(BurnIntent memory intent, bytes memory reason) internal view {
        (bytes32 h, bytes memory sig) = _sign(intent);
        _assertGuardRejectsRaw(h, sig, reason);
    }

    function _assertGuardRejectsRaw(bytes32 h, bytes memory sig, bytes memory reason) internal view {
        (bool ok,, bytes memory raw) = _erc1271(h, sig);
        assertFalse(ok, "expected a revert");
        assertEq(
            raw,
            abi.encodeWithSelector(BaseMSCA.PreRuntimeValidationHookFailed.selector, address(guard), uint8(0), reason)
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Install                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_install_throughOwnerUserOp() public {
        assertTrue(_installGuard(_init(address(0), true)));
        assertTrue(_isInstalled(msca, address(guard)));
        (address gwOut, uint256 cap,,, address book) = guard.gatewayLimits(address(msca));
        assertEq(gwOut, gatewayWallet);
        assertEq(cap, CAP);
        assertEq(book, address(0));
        assertTrue(guard.isGatewayRecipientAllowed(address(msca), R_ALLOWED));
    }

    function test_install_belowQuorum_rejected() public {
        Signer[] memory one = new Signer[](1);
        one[0] = owners[1]; // weight 1 < 3
        _expectValidationRevert(
            msca,
            _installPluginCalldata(address(guard), abi.encode(_init(address(0), true)), _addressBookDependencies()),
            one
        );
    }

    function test_install_emptyAllowlistWithoutAddressBook_fails() public {
        assertFalse(_installGuard(_init(address(0), false)));
    }

    function test_install_addressBookNotInstalled_fails() public {
        assertFalse(_installGuard(_init(address(addressBookPlugin), false)));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Baseline: WITHOUT the guard the quorum's ERC-1271 accepts any intent           ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_baseline_unguardedMsca_signsAnyRecipient() public view {
        BurnIntent memory intent = _intent();
        intent.spec.destinationRecipient = bytes32(uint256(0xBAD));
        intent.spec.value = 1_000_000e6;
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(intent);
        (bool ok, bytes4 ret,) = _erc1271(h, _quorumSig(h, 3));
        assertTrue(ok);
        assertEq(ret, MAGIC, "Circle's multisig alone has no Gateway policy");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Guarded: valid intent, quorum delegated to the weighted multisig               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_guarded_validIntent_returnsMagic() public {
        assertTrue(_installGuard(_init(address(0), true)));
        (bytes32 h, bytes memory sig) = _sign(_intent());
        uint256 g = gasleft();
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        console.log("guarded isValidSignature gas (3 owners, weight 4)", g - gasleft());
        assertTrue(ok);
        assertEq(ret, MAGIC);
    }

    function test_guarded_minimalQuorumOwnerAPlusB_valid() public {
        assertTrue(_installGuard(_init(address(0), true)));
        // setUp gives the first (lowest-address) owner weight 2, so owners[0] + owners[1] = 3 = threshold.
        BurnIntent memory intent = _intent();
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(intent);
        bytes memory q = _quorumSig(h, 2);
        (bool ok, bytes4 ret,) = _erc1271(h, _withEnvelope(q, 0, abi.encode(intent)));
        assertTrue(ok);
        assertEq(ret, MAGIC);
    }

    function test_guarded_belowThreshold_policyOk_returnsInvalid() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory intent = _intent();
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(intent);
        // owners[1] alone: weight 1 < 3. Policy holds, so the guard passes and the multisig says no.
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(msca), h);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(owners[1].key, wrapped);
        (bool ok, bytes4 ret, bytes memory raw) =
            _erc1271(h, _withEnvelope(abi.encodePacked(r, s, v), 0, abi.encode(intent)));
        // Circle's checkNSignatures keeps reading 65-byte slots until the threshold is met, so with a short quorum
        // it walks into the envelope trailer and reverts on the first slot it cannot parse. Either outcome is a
        // refusal; what matters is that the guard did NOT revert (it is not the guard's error).
        assertTrue(!ok || ret == INVALID);
        if (!ok) {
            assertTrue(bytes4(raw) != BaseMSCA.PreRuntimeValidationHookFailed.selector, "the guard passed this intent");
        }
        // The guard's own view agrees the policy holds.
        guard.checkIntent(address(msca), address(this), h, 0, abi.encode(intent));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Policy violations                                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_reject_recipient() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD));
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, i.spec.destinationRecipient)
        );
    }

    function test_reject_destinationCaller() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.destinationCaller = bytes32(uint256(0xCA11));
        _assertGuardRejects(
            i,
            abi.encodeWithSelector(IGatewayIntentGuard.DestinationCallerNotAllowed.selector, i.spec.destinationCaller)
        );
    }

    function test_reject_domain() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.destinationDomain = 0;
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationDomainNotAllowed.selector, uint32(0))
        );
    }

    function test_reject_destinationToken() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.destinationToken = bytes32(uint256(0xE0C));
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationTokenNotAllowed.selector, bytes32(uint256(0xE0C)))
        );
    }

    function test_reject_sourceToken() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.sourceToken = bytes32(uint256(0xE0C));
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.SourceTokenNotAllowed.selector, address(0xE0C))
        );
    }

    function _shape() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGatewayIntentGuard.IntentShapeRejected.selector);
    }

    function test_reject_valueOverCap() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.value = CAP + 1;
        _assertGuardRejects(i, _shape());
    }

    function test_reject_valueZero() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.value = 0;
        _assertGuardRejects(i, _shape());
    }

    function test_reject_feeOverCap() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.maxFee = FEE_CAP + 1;
        _assertGuardRejects(i, _shape());
    }

    function test_reject_expiryBeyondWindow() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.maxBlockHeight = block.number + EXPIRY + 1;
        _assertGuardRejects(i, _shape());
        i.maxBlockHeight = type(uint256).max;
        _assertGuardRejects(i, _shape());
    }

    function test_reject_hookData() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.hookData = hex"01";
        _assertGuardRejects(i, _shape());
    }

    function test_reject_sourceDepositorOrSigner() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.sourceDepositor = bytes32(uint256(0xD00D));
        _assertGuardRejects(i, _shape());
        i = _intent();
        i.spec.sourceSigner = bytes32(uint256(0xD00D));
        _assertGuardRejects(i, _shape());
    }

    function test_reject_sourceContract() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.sourceContract = bytes32(uint256(0xD00D));
        _assertGuardRejects(i, _shape());
    }

    function test_reject_versionNot1() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.version = 2;
        _assertGuardRejects(i, _shape());
    }

    function test_reject_nonCanonicalSourceToken() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.sourceToken = bytes32(uint256(uint160(address(usdc))) | (uint256(1) << 200));
        _assertGuardRejects(i, _shape());
    }

    function test_reject_digestMismatch() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory carried = _intent();
        BurnIntent memory signed = _intent();
        signed.spec.destinationRecipient = bytes32(uint256(0xBAD));
        bytes32 hSigned = GatewayIntentPolicy.burnIntentDigest(signed);
        // The owners signed a bad intent; the envelope carries the good one. Re-derivation catches it.
        bytes memory sig = _withEnvelope(_quorumSig(hSigned, 3), 0, abi.encode(carried));
        _assertGuardRejectsRaw(
            hSigned,
            sig,
            abi.encodeWithSelector(
                IGatewayIntentGuard.DigestMismatch.selector, hSigned, GatewayIntentPolicy.burnIntentDigest(carried)
            )
        );
    }

    function test_reject_noEnvelope() public {
        assertTrue(_installGuard(_init(address(0), true)));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(_intent());
        _assertGuardRejectsRaw(
            h, _quorumSig(h, 3), abi.encodeWithSelector(IGatewayIntentGuard.MissingIntentEnvelope.selector)
        );
    }

    function test_reject_badMagicOrLength() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        bytes memory env = abi.encode(uint8(0), abi.encode(i));
        bytes memory q = _quorumSig(h, 3);
        bytes memory missing = abi.encodeWithSelector(IGatewayIntentGuard.MissingIntentEnvelope.selector);
        _assertGuardRejectsRaw(h, bytes.concat(q, env, abi.encode(env.length), bytes32(uint256(1))), missing);
        _assertGuardRejectsRaw(h, bytes.concat(q, env, abi.encode(type(uint256).max), guard.ENVELOPE_MAGIC()), missing);
    }

    function test_reject_unknownKind() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        _assertGuardRejectsRaw(
            h,
            _withEnvelope(_quorumSig(h, 3), 7, abi.encode(i)),
            abi.encodeWithSelector(IGatewayIntentGuard.UnknownIntentKind.selector, uint8(7))
        );
    }

    function testFuzz_guarded_arbitraryTrailer_neverValidates(bytes calldata trailer) public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD)); // not allowlisted
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        (bool ok, bytes4 ret,) = _erc1271(h, bytes.concat(_quorumSig(h, 3), trailer));
        assertTrue(!ok || ret != MAGIC);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Kind 1: ERC-3009 ReceiveWithAuthorization (Gateway depositWithAuthorization)   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _rwaSig(address to, bytes32 nonce) internal view returns (bytes memory sig, uint256 vb) {
        vb = block.timestamp + 1 days;
        bytes32 d = usdc.digest(address(msca), to, 1e6, 0, vb, nonce);
        sig = _withEnvelope(_quorumSig(d, 3), 1, abi.encode(address(msca), to, uint256(1e6), uint256(0), vb, nonce));
    }

    function test_kind1_depositWithAuthorization_valid() public {
        assertTrue(_installGuard(_init(address(0), true)));
        (bytes memory sig, uint256 vb) = _rwaSig(gatewayWallet, keccak256("n1"));
        assertTrue(usdc.verify(address(msca), gatewayWallet, 1e6, 0, vb, keccak256("n1"), sig));
    }

    function test_kind1_toNotGateway_rejected() public {
        assertTrue(_installGuard(_init(address(0), true)));
        (bytes memory sig, uint256 vb) = _rwaSig(address(0xBAD), keccak256("n2"));
        assertFalse(usdc.verify(address(msca), address(0xBAD), 1e6, 0, vb, keccak256("n2"), sig));
    }

    function test_kind1_callerNotAllowedToken_rejected() public {
        assertTrue(_installGuard(_init(address(0), true)));
        GuardFiatToken other = new GuardFiatToken();
        uint256 vb = block.timestamp + 1 days;
        bytes32 d = other.digest(address(msca), gatewayWallet, 1e6, 0, vb, keccak256("n3"));
        bytes memory sig = _withEnvelope(
            _quorumSig(d, 3), 1, abi.encode(address(msca), gatewayWallet, uint256(1e6), uint256(0), vb, keccak256("n3"))
        );
        assertFalse(other.verify(address(msca), gatewayWallet, 1e6, 0, vb, keccak256("n3"), sig));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Admin: setters are owner-userOp-only                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_admin_addRecipientThroughOwnerUserOp_thenValid() public {
        assertTrue(_installGuard(_init(address(0), true)));
        bytes32 r2 = bytes32(uint256(uint160(R_EVM)));
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = r2;
        _assertGuardRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, r2));

        assertTrue(
            _executeUserOp(msca, abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (r2, true)), _signers())
        );
        assertTrue(guard.isGatewayRecipientAllowed(address(msca), r2));
        _assertValid(i);
    }

    function test_admin_limitsAndDomainAndTokens() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        i.spec.value = 3e6;
        _assertGuardRejects(i, _shape());
        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayLimits, (5e6, FEE_CAP, EXPIRY)), _signers()
            )
        );
        _assertValid(i);

        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationDomain, (DEST_DOMAIN, false)), _signers()
            )
        );
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationDomainNotAllowed.selector, DEST_DOMAIN)
        );
        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationDomain, (DEST_DOMAIN, true)), _signers()
            )
        );

        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationToken, (DEST_TOKEN, false)), _signers()
            )
        );
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationTokenNotAllowed.selector, DEST_TOKEN)
        );
        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationToken, (DEST_TOKEN, true)), _signers()
            )
        );

        assertTrue(
            _executeUserOp(
                msca, abi.encodeCall(IGatewayIntentGuard.setGatewayToken, (address(usdc), "", "", false)), _signers()
            )
        );
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.SourceTokenNotAllowed.selector, address(usdc))
        );
    }

    function test_admin_removingLastRecipient_failsInExecution() public {
        assertTrue(_installGuard(_init(address(0), true)));
        assertFalse(
            _executeUserOp(msca, abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (R_ALLOWED, false)), _signers())
        );
        assertTrue(guard.isGatewayRecipientAllowed(address(msca), R_ALLOWED));
    }

    function test_admin_setterBelowQuorum_rejectedAtValidation() public {
        assertTrue(_installGuard(_init(address(0), true)));
        Signer[] memory one = new Signer[](1);
        one[0] = owners[1];
        _expectValidationRevert(
            msca, abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (bytes32(uint256(0xBAD)), true)), one
        );
    }

    function test_admin_setterRuntimePath_failsClosed() public {
        assertTrue(_installGuard(_init(address(0), true)));
        vm.prank(owners[0].addr);
        vm.expectRevert();
        IGatewayIntentGuard(address(msca)).setGatewayRecipient(bytes32(uint256(0xBAD)), true);
        // And nobody can call the plugin directly for an account they are not (writes are keyed by msg.sender).
        vm.expectRevert();
        guard.setGatewayRecipient(bytes32(uint256(0xBAD)), true);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Circle ColdStorageAddressBook as a recipient source                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_addressBook_recipientFromBook_valid_andOthersRejected() public {
        address[] memory book = new address[](1);
        book[0] = R_EVM;
        assertTrue(_installAddressBook(msca, book, _signers()));
        assertTrue(_installGuard(_init(address(addressBookPlugin), false)));

        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(uint160(R_EVM)));
        _assertValid(i);

        i.spec.destinationRecipient = bytes32(uint256(uint160(address(0xBAD))));
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, i.spec.destinationRecipient)
        );

        // Non-EVM-shaped (Solana) recipients never come from the EVM address book.
        i.spec.destinationRecipient = R_ALLOWED;
        _assertGuardRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, R_ALLOWED));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Review findings (2026-10-05)                                                   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    bytes32 internal constant R_SOL_KEY =
        bytes32(uint256(0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB22));
    bytes32 internal constant SOL_TOKEN =
        bytes32(uint256(0x3B442CB3912157F13A933D0134282D032B5FFECD01A2DBF1B7790608DF002EA7));
    uint32 internal constant SOLANA_DOMAIN = 5;
    bytes32 internal constant SOL_MINTER =
        bytes32(uint256(0x6d696e7465726d696e7465726d696e7465726d696e7465726d696e746572aaaa));

    /// @dev Guard with both an EVM leg (domain 6) and a Solana leg (domain 5).
    function _twoLegInit(address addressBook, bytes32[] memory recipients)
        internal
        view
        returns (GatewayGuardInit memory init)
    {
        init = _init(addressBook, false);
        init.recipients = recipients;
        init.destinationDomains = new uint32[](2);
        init.destinationDomains[0] = DEST_DOMAIN;
        init.destinationDomains[1] = SOLANA_DOMAIN;
        init.destinationMinters = new bytes32[](2);
        init.destinationMinters[0] = EVM_MINTER;
        init.destinationMinters[1] = SOL_MINTER;
        init.destinationTokens = new bytes32[](2);
        init.destinationTokens[0] = DEST_TOKEN;
        init.destinationTokens[1] = SOL_TOKEN;
    }

    function _assertRejected(BurnIntent memory intent) internal view {
        (bytes32 h, bytes memory sig) = _sign(intent);
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        assertTrue(!ok || ret != MAGIC, "intent should have been refused");
    }

    // GG-1: an address-book entry is an EVM address; it must never be accepted as a Solana recipient.
    function test_GG1_addressBookRecipient_refusedOnSolanaDomain() public {
        address[] memory book = new address[](1);
        book[0] = R_EVM;
        assertTrue(_installAddressBook(msca, book, _signers()));
        assertTrue(_installGuard(_twoLegInit(address(addressBookPlugin), new bytes32[](0))));

        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(uint160(R_EVM)));
        _assertValid(i); // control: book entry on the EVM domain

        i.spec.destinationDomain = SOLANA_DOMAIN;
        i.spec.destinationToken = SOL_TOKEN;
        i.spec.destinationContract = SOL_MINTER;
        _assertGuardRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, i.spec.destinationRecipient));
    }

    // GG-1 / GT-1: explicit recipients are bound to their domain's address shape.
    function test_GG1_explicitRecipients_boundToDomainShape() public {
        bytes32[] memory r = new bytes32[](2);
        r[0] = bytes32(uint256(uint160(R_EVM)));
        r[1] = R_SOL_KEY;
        assertTrue(_installGuard(_twoLegInit(address(0), r)));

        BurnIntent memory evmLeg = _intent();
        evmLeg.spec.destinationRecipient = r[0];
        _assertValid(evmLeg);
        BurnIntent memory solLeg = _intent();
        solLeg.spec.destinationDomain = SOLANA_DOMAIN;
        solLeg.spec.destinationToken = SOL_TOKEN;
        solLeg.spec.destinationContract = SOL_MINTER;
        solLeg.spec.destinationRecipient = R_SOL_KEY;
        _assertValid(solLeg);

        evmLeg.spec.destinationRecipient = R_SOL_KEY; // Solana key on Base
        _assertGuardRejects(evmLeg, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, R_SOL_KEY));
        solLeg.spec.destinationRecipient = r[0]; // EVM address on Solana
        _assertGuardRejects(solLeg, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, r[0]));
        solLeg.spec.destinationRecipient = R_SOL_KEY;
        solLeg.spec.destinationToken = DEST_TOKEN; // Base USDC named as the Solana mint
        _assertGuardRejects(solLeg, abi.encodeWithSelector(IGatewayIntentGuard.DestinationTokenNotAllowed.selector, DEST_TOKEN));
    }

    // GT-6: an allowlisted payee is not an allowlisted destination caller.
    function test_GT6_recipientIsNotADestinationCaller() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        bytes32 relayer = i.spec.destinationRecipient;
        i.spec.destinationCaller = relayer;
        _assertGuardRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationCallerNotAllowed.selector, relayer));
        assertTrue(
            _executeUserOp(msca, abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationCaller, (relayer, true)), _signers())
        );
        assertTrue(guard.isGatewayDestinationCallerAllowed(address(msca), relayer));
        _assertValid(i);
    }

    // GT-4: destination contract and source domain are pinned.
    function test_GT4_destinationContractAndSourceDomainPinned() public {
        assertTrue(_installGuard(_init(address(0), true)));
        BurnIntent memory i = _intent();
        _assertValid(i);
        i.spec.destinationContract = bytes32(uint256(0xdeadbeef));
        _assertGuardRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationContractNotAllowed.selector, bytes32(uint256(0xdeadbeef)))
        );
        // The owners can repoint the minter (e.g. a Gateway upgrade) through their own userOp.
        assertTrue(
            _executeUserOp(
                msca,
                abi.encodeCall(IGatewayIntentGuard.setGatewayDestinationMinter, (DEST_DOMAIN, bytes32(uint256(0xdeadbeef)))),
                _signers()
            )
        );
        _assertValid(i);
        i = _intent();
        i.spec.sourceDomain = 77;
        _assertGuardRejects(i, _shape());
        assertEq(guard.gatewaySourceDomain(address(msca)), 26);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Uninstall: documented weakening + no stale state on reinstall                 ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_uninstall_reopensErc1271_andReinstallStartsClean() public {
        assertTrue(_installGuard(_init(address(0), true)));
        bytes32 extra = bytes32(uint256(0xE1));
        assertTrue(
            _executeUserOp(msca, abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (extra, true)), _signers())
        );

        assertTrue(
            _executeUserOp(msca, abi.encodeCall(IPluginManager.uninstallPlugin, (address(guard), "", "")), _signers())
        );
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        (bool ok, bytes4 ret,) = _erc1271(h, _quorumSig(h, 3));
        assertTrue(ok);
        assertEq(ret, MAGIC, "after uninstall the quorum signs anything again");

        assertTrue(_installGuard(_init(address(0), true)));
        assertFalse(guard.isGatewayRecipientAllowed(address(msca), extra), "reinstall must not inherit old entries");
        assertTrue(guard.isGatewayRecipientAllowed(address(msca), R_ALLOWED));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Manifest                                                                       ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_manifest_hooksIsValidSignatureOnly() public view {
        assertEq(guard.pluginManifest().preRuntimeValidationHooks.length, 1);
        assertEq(
            guard.pluginManifest().preRuntimeValidationHooks[0].executionSelector, IERC1271.isValidSignature.selector
        );
        assertEq(guard.pluginManifest().preUserOpValidationHooks.length, 0);
        assertTrue(guard.supportsInterface(type(IGatewayIntentGuard).interfaceId));
    }
}
