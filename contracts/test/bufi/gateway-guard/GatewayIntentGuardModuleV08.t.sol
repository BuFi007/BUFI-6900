// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleV08Harness} from "../../harness/CircleV08Harness.sol";

import {GatewayIntentGuardModule} from "../../../src/bufi/gateway-guard/GatewayIntentGuardModule.sol";
import {BurnIntent, GatewayIntentPolicy, TransferSpec} from "../../../src/bufi/gateway-guard/GatewayIntentPolicy.sol";
import {GatewayGuardInit, IGatewayIntentGuard} from "../../../src/bufi/gateway-guard/IGatewayIntentGuard.sol";

// Imported only so `deployCodeTo("EntryPoint.sol:EntryPoint")` in CircleV08Harness finds the artifact when this
// suite is compiled on its own (the harness itself does not import it).
// forge-lint: disable-next-line(unused-import)
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.8/account/UpgradableMSCA.sol";
import {ModuleEntity, ValidationConfig} from "@erc6900/reference-implementation/interfaces/IModularAccount.sol";
import {IModule} from "@erc6900/reference-implementation/interfaces/IModule.sol";
import {IValidationHookModule} from "@erc6900/reference-implementation/interfaces/IValidationHookModule.sol";
import {ValidationConfigLib} from "@erc6900/reference-implementation/libraries/ValidationConfigLib.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {console} from "forge-std/src/console.sol";

/// @dev ERC-3009 receiver modelled on FiatToken (STATICCALL to the account's isValidSignature).
contract GuardFiatTokenV08 {
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

/// @notice `GatewayIntentGuardModule` as a validation hook on a REAL Circle ERC-6900 v0.8 account
///         (`UpgradableMSCA`, `circle.msca.2.0.0`) whose owner validation is `WeightedMultisigValidationModule`.
contract GatewayIntentGuardModuleV08Test is CircleV08Harness {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    /// The explicitly allowlisted recipient. EVM-shaped: the default intent goes to Base Sepolia (domain 6).
    bytes32 internal constant R_ALLOWED = bytes32(uint256(uint160(0x5555555555555555555555555555555555555555)));
    bytes32 internal constant EVM_MINTER = bytes32(uint256(uint160(0x0022222ABE238Cc2C7Bb1f21003F0a260052475B)));
    bytes32 internal constant DEST_TOKEN = bytes32(uint256(uint160(0x036CbD53842c5426634e7929541eC2318f3dCF7e)));
    uint32 internal constant DEST_DOMAIN = 6;
    uint256 internal constant CAP = 2e6;
    uint256 internal constant FEE_CAP = 2.01e6;
    uint256 internal constant EXPIRY = 1_250_000;

    address internal gatewayWallet = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    GuardFiatTokenV08 internal usdc;
    GatewayIntentGuardModule internal guard;
    UpgradableMSCA internal account;
    Signer internal a; // weight 2
    Signer internal b; // weight 1
    Signer internal c; // weight 1

    function setUp() public {
        vm.roll(1_000_000);
        _deployCircleV08Stack();
        usdc = new GuardFiatTokenV08();
        guard = new GatewayIntentGuardModule();
        a = _makeSigner("v08-owner-a");
        b = _makeSigner("v08-owner-b");
        c = _makeSigner("v08-owner-c");
        Signer[] memory s = new Signer[](3);
        s[0] = a;
        s[1] = b;
        s[2] = c;
        uint256[] memory w = new uint256[](3);
        w[0] = 2;
        w[1] = 1;
        w[2] = 1;
        account = _createWeightedAccount(s, w, 3, keccak256("v08-gateway-guard"));
    }

    // ── helpers
    // ──────────────────────────────────────────────────────────────

    function _all() internal view returns (Signer[] memory s) {
        s = new Signer[](3);
        s[0] = a;
        s[1] = b;
        s[2] = c;
    }

    function _init() internal view returns (GatewayGuardInit memory init) {
        init.gatewayWallet = gatewayWallet;
        init.perIntentCap = CAP;
        init.maxFeeCap = FEE_CAP;
        init.maxExpiryBlocks = EXPIRY;
        init.recipients = new bytes32[](1);
        init.recipients[0] = R_ALLOWED;
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
    }

    /// @dev Attaches the guard as a validation hook on the existing multisig validation (flags unchanged:
    ///      global, signature validation, userOp validation), through a quorum-signed userOp.
    function _attachGuard() internal returns (bool) {
        ValidationConfig config = ValidationConfigLib.pack(_multisigValidation(), true, true, true);
        bytes[] memory hooks = new bytes[](1);
        hooks[0] = _validationHook(address(guard), 0, abi.encode(_init()));
        return _executeWeightedUserOp(account, _installValidationCalldata(config, new bytes4[](0), "", hooks), _all());
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
                sourceDepositor: bytes32(uint256(uint160(address(account)))),
                destinationRecipient: R_ALLOWED,
                sourceSigner: bytes32(uint256(uint160(address(account)))),
                destinationCaller: bytes32(0),
                value: 1e6,
                salt: keccak256("v08"),
                hookData: ""
            })
        });
    }

    /// @dev Weighted-multisig ERC-1271 signature from `signers` (sorted by signer id) over the replay-safe hash.
    function _quorum(bytes32 hash, Signer[] memory signers) internal view returns (bytes memory sig) {
        Signer[] memory ordered = _sortBySignerId(signers);
        bytes32 wrapped = weightedMultisig.getReplaySafeMessageHash(address(account), hash);
        for (uint256 i = 0; i < ordered.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ordered[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    /// @dev Circle v0.8 1271 envelope: [ModuleEntity][hook segment 0 = guard envelope][0xff][quorum sig].
    function _sig1271(bytes memory guardSegment, bytes memory quorumSig) internal view returns (bytes memory) {
        PreValidationHookData[] memory hd = new PreValidationHookData[](guardSegment.length == 0 ? 0 : 1);
        if (guardSegment.length != 0) hd[0] = PreValidationHookData({index: 0, hookData: guardSegment});
        return encode1271Signature(hd, _multisigValidation(), quorumSig);
    }

    function _sign(BurnIntent memory intent, Signer[] memory signers)
        internal
        view
        returns (bytes32 h, bytes memory sig)
    {
        h = GatewayIntentPolicy.burnIntentDigest(intent);
        sig = _sig1271(abi.encode(uint8(0), abi.encode(intent)), _quorum(h, signers));
    }

    function _erc1271(bytes32 h, bytes memory sig) internal view returns (bool ok, bytes4 ret, bytes memory raw) {
        (ok, raw) = address(account).staticcall(abi.encodeCall(IERC1271.isValidSignature, (h, sig)));
        if (ok && raw.length >= 32) ret = abi.decode(raw, (bytes4));
    }

    function _assertValid(BurnIntent memory intent) internal view {
        (bytes32 h, bytes memory sig) = _sign(intent, _all());
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        assertTrue(ok, "isValidSignature reverted");
        assertEq(ret, MAGIC);
    }

    /// @dev v0.8 calls the signature hook directly (no try/catch), so the guard's error IS the revert data.
    function _assertRejects(BurnIntent memory intent, bytes memory reason) internal view {
        (bytes32 h, bytes memory sig) = _sign(intent, _all());
        (bool ok,, bytes memory raw) = _erc1271(h, sig);
        assertFalse(ok, "expected the guard to revert");
        assertEq(raw, reason);
    }

    function _shape() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGatewayIntentGuard.IntentShapeRejected.selector);
    }

    // ── install / baseline
    // ───────────────────────────────────────────────────

    function test_v08_attachGuard_throughQuorumUserOp() public {
        assertTrue(_attachGuard());
        (address gw,,,,) = guard.gatewayLimits(address(account));
        assertEq(gw, gatewayWallet);
        assertTrue(guard.supportsInterface(type(IValidationHookModule).interfaceId));
        assertTrue(guard.supportsInterface(type(IModule).interfaceId));
    }

    function test_v08_attachGuard_belowQuorum_rejected() public {
        ValidationConfig config = ValidationConfigLib.pack(_multisigValidation(), true, true, true);
        bytes[] memory hooks = new bytes[](1);
        hooks[0] = _validationHook(address(guard), 0, abi.encode(_init()));
        Signer[] memory one = new Signer[](1);
        one[0] = b;
        _expectWeightedValidationRevert(account, _installValidationCalldata(config, new bytes4[](0), "", hooks), one);
    }

    function test_v08_baseline_unguarded_signsAnything() public view {
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        (bool ok, bytes4 ret,) = _erc1271(h, _sig1271("", _quorum(h, _all())));
        assertTrue(ok);
        assertEq(ret, MAGIC);
    }

    // ── guarded
    // ──────────────────────────────────────────────────────────────

    function test_v08_validIntent_returnsMagic() public {
        assertTrue(_attachGuard());
        (bytes32 h, bytes memory sig) = _sign(_intent(), _all());
        uint256 g = gasleft();
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        console.log("v0.8 guarded isValidSignature gas", g - gasleft());
        assertTrue(ok);
        assertEq(ret, MAGIC);
    }

    function test_v08_belowThreshold_returnsInvalid() public {
        assertTrue(_attachGuard());
        Signer[] memory bc = new Signer[](2);
        bc[0] = b;
        bc[1] = c; // weight 2 < 3
        (bytes32 h, bytes memory sig) = _sign(_intent(), bc);
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        assertTrue(ok, "the guard passed; the multisig answers");
        assertEq(ret, INVALID);
    }

    function test_v08_minimalQuorum_AB_valid() public {
        assertTrue(_attachGuard());
        Signer[] memory ab = new Signer[](2);
        ab[0] = a;
        ab[1] = b;
        (bytes32 h, bytes memory sig) = _sign(_intent(), ab);
        (bool ok, bytes4 ret,) = _erc1271(h, sig);
        assertTrue(ok);
        assertEq(ret, MAGIC);
    }

    function test_v08_missingSegment_rejected() public {
        assertTrue(_attachGuard());
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(_intent());
        (bool ok,, bytes memory raw) = _erc1271(h, _sig1271("", _quorum(h, _all())));
        assertFalse(ok);
        assertEq(raw, abi.encodeWithSelector(IGatewayIntentGuard.MissingIntentEnvelope.selector));
    }

    function test_v08_reject_recipient() public {
        assertTrue(_attachGuard());
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD));
        _assertRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, bytes32(uint256(0xBAD)))
        );
    }

    function test_v08_reject_domain_token_caps_expiry() public {
        assertTrue(_attachGuard());
        BurnIntent memory i = _intent();
        i.spec.destinationDomain = 0;
        _assertRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationDomainNotAllowed.selector, uint32(0)));

        i = _intent();
        i.spec.destinationToken = bytes32(uint256(1));
        _assertRejects(
            i, abi.encodeWithSelector(IGatewayIntentGuard.DestinationTokenNotAllowed.selector, bytes32(uint256(1)))
        );

        i = _intent();
        i.spec.sourceToken = bytes32(uint256(1));
        _assertRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.SourceTokenNotAllowed.selector, address(1)));

        i = _intent();
        i.spec.value = CAP + 1;
        _assertRejects(i, _shape());

        i = _intent();
        i.maxFee = FEE_CAP + 1;
        _assertRejects(i, _shape());

        i = _intent();
        i.maxBlockHeight = block.number + EXPIRY + 1;
        _assertRejects(i, _shape());

        i = _intent();
        i.spec.sourceDepositor = bytes32(uint256(0xD00D));
        _assertRejects(i, _shape());

        i = _intent();
        i.spec.hookData = hex"00";
        _assertRejects(i, _shape());
    }

    function test_v08_reject_digestMismatch() public {
        assertTrue(_attachGuard());
        BurnIntent memory signed = _intent();
        signed.spec.destinationRecipient = bytes32(uint256(0xBAD));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(signed);
        BurnIntent memory carried = _intent();
        bytes memory sig = _sig1271(abi.encode(uint8(0), abi.encode(carried)), _quorum(h, _all()));
        (bool ok,, bytes memory raw) = _erc1271(h, sig);
        assertFalse(ok);
        assertEq(
            raw,
            abi.encodeWithSelector(
                IGatewayIntentGuard.DigestMismatch.selector, h, GatewayIntentPolicy.burnIntentDigest(carried)
            )
        );
    }

    function testFuzz_v08_arbitrarySegment_neverValidatesBadIntent(bytes calldata segment) public {
        assertTrue(_attachGuard());
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = bytes32(uint256(0xBAD));
        bytes32 h = GatewayIntentPolicy.burnIntentDigest(i);
        (bool ok, bytes4 ret,) = _erc1271(h, _sig1271(segment, _quorum(h, _all())));
        assertTrue(!ok || ret != MAGIC);
    }

    // ── kind 1
    // ───────────────────────────────────────────────────────────────

    function test_v08_kind1_depositWithAuthorization() public {
        assertTrue(_attachGuard());
        uint256 vb = block.timestamp + 1 days;
        bytes32 nonce = keccak256("v08-n1");
        bytes32 d = usdc.digest(address(account), gatewayWallet, 1e6, 0, vb, nonce);
        bytes memory payload = abi.encode(address(account), gatewayWallet, uint256(1e6), uint256(0), vb, nonce);
        bytes memory sig = _sig1271(abi.encode(uint8(1), payload), _quorum(d, _all()));
        assertTrue(usdc.verify(address(account), gatewayWallet, 1e6, 0, vb, nonce, sig));

        bytes32 d2 = usdc.digest(address(account), address(0xBAD), 1e6, 0, vb, nonce);
        bytes memory payload2 = abi.encode(address(account), address(0xBAD), uint256(1e6), uint256(0), vb, nonce);
        bytes memory sig2 = _sig1271(abi.encode(uint8(1), payload2), _quorum(d2, _all()));
        assertFalse(usdc.verify(address(account), address(0xBAD), 1e6, 0, vb, nonce, sig2));
    }

    // ── the guard does not get in the owners' way; admin through the quorum ──

    function test_v08_ordinaryUserOpsStillWork_andSettersThroughExecute() public {
        assertTrue(_attachGuard());
        address payee = makeAddr("payee");
        assertTrue(_executeWeightedUserOp(account, _executeCalldata(payee, 1 ether, ""), _all()));
        assertEq(payee.balance, 1 ether);

        bytes32 r2 = bytes32(uint256(0xE2));
        BurnIntent memory i = _intent();
        i.spec.destinationRecipient = r2;
        _assertRejects(i, abi.encodeWithSelector(IGatewayIntentGuard.RecipientNotAllowed.selector, r2));
        assertTrue(
            _executeWeightedUserOp(
                account,
                _executeCalldata(
                    address(guard), 0, abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (r2, true))
                ),
                _all()
            )
        );
        _assertValid(i);

        // Not through the account: keyed by msg.sender, so a stranger has no config to write.
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(IGatewayIntentGuard.GuardNotInstalled.selector, makeAddr("stranger")));
        guard.setGatewayRecipient(bytes32(uint256(0xBAD)), true);
    }

    function test_v08_setterBelowQuorum_rejected() public {
        assertTrue(_attachGuard());
        Signer[] memory one = new Signer[](1);
        one[0] = c;
        _expectWeightedValidationRevert(
            account,
            _executeCalldata(
                address(guard),
                0,
                abi.encodeCall(IGatewayIntentGuard.setGatewayRecipient, (bytes32(uint256(0xBAD)), true))
            ),
            one
        );
    }
}
