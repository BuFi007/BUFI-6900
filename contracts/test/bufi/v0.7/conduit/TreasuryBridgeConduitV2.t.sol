// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {
    ICrossChainTokenService,
    ITokenMessengerV2,
    TreasuryBridgeConduitV2
} from "../../../../src/bufi/conduit/TreasuryBridgeConduitV2.sol";
import {IFiatTokenV2} from "../../../../src/bufi/conduit/interfaces/IFiatTokenV2.sol";
import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {MockCrossChainTokenService, MockReentrantVenue, MockTokenMessengerV2} from "../../../mocks/MockCctpBridges.sol";
import {MockFiatToken3009} from "../../../mocks/MockFiatToken3009.sol";
import {MockSwapRouter} from "../../../mocks/MockSwapRouter.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Test} from "forge-std/src/Test.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @notice The bridge conduit against a REAL Circle treasury: a weighted 2-of-2
/// MSCA with ColdStorageAddressBook installed, signing the ERC-3009
/// authorization through the plugin's ERC-1271 path. Plan 408 v2.
contract TreasuryBridgeConduitV2Test is CircleStackHarness {
    MockFiatToken3009 internal usdc;
    MockFiatToken3009 internal eurc;
    MockSwapRouter internal router;
    MockTokenMessengerV2 internal messenger;
    MockCrossChainTokenService internal ccts;
    TreasuryBridgeConduitV2 internal conduit;
    UpgradableMSCA internal treasury;
    Signer[] internal quorum;

    address internal constant SAFE = address(0x5AFE);
    address internal constant KEEPER = address(0xCAFE);
    address internal constant DEST_TREASURY = address(0xD357);
    address internal constant ATTACKER = address(0xBAD);
    bytes32 internal constant EURC_ID = 0x6ca9e29fa53becc29becaf4a90b9ca7a995ad4d2234880da13ca38c657fb241c;
    uint32 internal constant AVALANCHE = 1;
    uint256 internal constant AMOUNT = 17e6;
    uint256 internal constant START = 100e6;
    uint256 internal constant SIGNED_FIELDS = 21;

    function setUp() public {
        _deployCircleCanonicalStack();
        quorum = _makeSigners("treasury", 2);
        treasury = _createWeightedMsca(quorum, _uniformWeights(2, 100), 200, bytes32(uint256(1)));
        address[] memory seed = new address[](1);
        seed[0] = address(0xFEE);
        assertTrue(_installAddressBook(treasury, seed, quorum), "address book installs");

        usdc = new MockFiatToken3009("USDC", "USDC");
        eurc = new MockFiatToken3009("EURC", "EURC");
        router = new MockSwapRouter();
        messenger = new MockTokenMessengerV2();
        ccts = new MockCrossChainTokenService();
        ccts.setToken(EURC_ID, address(eurc));

        conduit = new TreasuryBridgeConduitV2(SAFE);
        vm.startPrank(SAFE);
        conduit.setTarget(address(router), true);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, address(messenger), true);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTPX, address(ccts), true);
        conduit.setCctpxToken(EURC_ID, address(eurc));
        vm.stopPrank();

        usdc.mint(address(treasury), START);
        eurc.mint(address(treasury), START);
        vm.warp(1_800_000_000);
    }

    // ── intents
    // ─────────────────────────────────────────────────────────────

    function _recipient() internal pure returns (bytes32) {
        return bytes32(uint256(uint160(DEST_TREASURY)));
    }

    /// USDC straight into CCTP V2: no swap.
    function _usdcDirect() internal view returns (TreasuryBridgeConduitV2.Intent memory) {
        return TreasuryBridgeConduitV2.Intent({
            venue: address(0),
            venueData: "",
            tokenIn: address(usdc),
            amountIn: AMOUNT,
            bridgeAsset: address(usdc),
            minBridgeAmount: AMOUNT,
            bridgeKind: TreasuryBridgeConduitV2.BridgeKind.CCTP_V2,
            bridge: address(messenger),
            bridgeTokenId: bytes32(0),
            destinationDomain: AVALANCHE,
            mintRecipient: _recipient(),
            destinationCaller: bytes32(0),
            maxFee: 1_700,
            minFinalityThreshold: 1000,
            beneficiary: address(treasury),
            deadline: block.timestamp + 1 hours,
            memoId: keccak256("payroll-2026-10"),
            memo: bytes("payroll=2026-10"),
            platformFeeToken: address(0),
            platformFeeAmount: 0,
            platformFeeRecipient: address(0)
        });
    }

    /// EURC -> USDC on a venue, then CCTP V2.
    function _eurcSwapToUsdc(uint256 minBridge) internal view returns (TreasuryBridgeConduitV2.Intent memory i) {
        i = _usdcDirect();
        i.venue = address(router);
        i.venueData = abi.encodeCall(MockSwapRouter.swap, (address(eurc), address(usdc), AMOUNT, address(conduit)));
        i.tokenIn = address(eurc);
        i.minBridgeAmount = minBridge;
    }

    /// USDC -> EURC on a venue, then CCTPx with a native fee.
    function _usdcSwapToEurcCctpx(uint256 minBridge) internal view returns (TreasuryBridgeConduitV2.Intent memory i) {
        i = _usdcDirect();
        i.venue = address(router);
        i.venueData = abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(eurc), AMOUNT, address(conduit)));
        i.bridgeAsset = address(eurc);
        i.minBridgeAmount = minBridge;
        i.bridgeKind = TreasuryBridgeConduitV2.BridgeKind.CCTPX;
        i.bridge = address(ccts);
        i.bridgeTokenId = EURC_ID;
        i.maxFee = 1 ether;
    }

    /// EURC straight into CCTPx: no swap.
    function _eurcDirectCctpx() internal view returns (TreasuryBridgeConduitV2.Intent memory i) {
        i = _usdcSwapToEurcCctpx(AMOUNT);
        i.venue = address(0);
        i.venueData = "";
        i.tokenIn = address(eurc);
    }

    function _auth(TreasuryBridgeConduitV2.Intent memory intent)
        internal
        view
        returns (TreasuryBridgeConduitV2.Authorization memory)
    {
        return TreasuryBridgeConduitV2.Authorization({
            token: intent.tokenIn,
            from: address(treasury),
            value: intent.amountIn,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: conduit.intentNonce(intent)
        });
    }

    /// The quorum signs the token's EIP-712 digest, wrapped in the account's
    /// replay-safe hash, one 65-byte (r,s,v) per owner — the plugin's 1271 blob.
    function _sign(TreasuryBridgeConduitV2.Authorization memory auth) internal view returns (bytes memory sig) {
        MockFiatToken3009 token = MockFiatToken3009(auth.token);
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                auth.from,
                address(conduit),
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), structHash);
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        for (uint256 i = 0; i < quorum.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(quorum[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    /// The conduit holds nothing, has no allowance anywhere, and holds no native.
    function _assertConduitEmpty() internal view {
        assertEq(usdc.balanceOf(address(conduit)), 0, "conduit holds no USDC");
        assertEq(eurc.balanceOf(address(conduit)), 0, "conduit holds no EURC");
        assertEq(address(conduit).balance, 0, "conduit holds no native");
        address[4] memory spenders = [address(router), address(messenger), address(ccts), address(ccts.manager())];
        for (uint256 i = 0; i < spenders.length; i++) {
            assertEq(usdc.allowance(address(conduit), spenders[i]), 0, "no USDC allowance left");
            assertEq(eurc.allowance(address(conduit), spenders[i]), 0, "no EURC allowance left");
        }
    }

    function _assertUntouched(bytes32 nonce, address token) internal view {
        assertEq(usdc.balanceOf(address(treasury)), START, "treasury USDC unchanged");
        assertEq(eurc.balanceOf(address(treasury)), START, "treasury EURC unchanged");
        assertFalse(IFiatTokenV2(token).authorizationState(address(treasury), nonce), "nonce still unused");
        assertEq(messenger.calls(), 0, "nothing burned via CCTP");
        assertEq(ccts.calls(), 0, "nothing burned via CCTPx");
        _assertConduitEmpty();
    }

    /// A fresh intent of each shape, so a mutation never aliases another test's memory.
    function _fresh(uint256 shape) internal view returns (TreasuryBridgeConduitV2.Intent memory) {
        if (shape == 0) return _usdcDirect();
        if (shape == 1) return _eurcSwapToUsdc(13_000_000);
        if (shape == 2) return _usdcSwapToEurcCctpx(13_000_000);
        return _eurcDirectCctpx();
    }

    /// Change exactly one signed field. `salt` makes the new value differ.
    function _mutate(TreasuryBridgeConduitV2.Intent memory i, uint256 field, uint256 salt) internal pure {
        uint256 d = (salt % type(uint64).max) + 1; // non-zero delta
        if (field == 0) {
            i.venue = address(uint160(i.venue) ^ uint160(d));
        } else if (field == 1) {
            i.venueData = bytes.concat(i.venueData, bytes1(uint8(d)));
        } else if (field == 2) {
            i.tokenIn = address(uint160(i.tokenIn) ^ uint160(d));
        } else if (field == 3) {
            i.amountIn = i.amountIn ^ d;
        } else if (field == 4) {
            i.bridgeAsset = address(uint160(i.bridgeAsset) ^ uint160(d));
        } else if (field == 5) {
            i.minBridgeAmount = i.minBridgeAmount ^ d;
        } else if (field == 6) {
            i.bridgeKind = i.bridgeKind == TreasuryBridgeConduitV2.BridgeKind.CCTP_V2
                ? TreasuryBridgeConduitV2.BridgeKind.CCTPX
                : TreasuryBridgeConduitV2.BridgeKind.CCTP_V2;
        } else if (field == 7) {
            i.bridge = address(uint160(i.bridge) ^ uint160(d));
        } else if (field == 8) {
            i.bridgeTokenId = i.bridgeTokenId ^ bytes32(d);
        } else if (field == 9) {
            i.destinationDomain = i.destinationDomain ^ uint32(d % type(uint32).max + 1);
        } else if (field == 10) {
            i.mintRecipient = i.mintRecipient ^ bytes32(d);
        } else if (field == 11) {
            i.destinationCaller = i.destinationCaller ^ bytes32(d);
        } else if (field == 12) {
            i.maxFee = i.maxFee ^ d;
        } else if (field == 13) {
            i.minFinalityThreshold = i.minFinalityThreshold ^ uint32(d % type(uint32).max + 1);
        } else if (field == 14) {
            i.beneficiary = address(uint160(i.beneficiary) ^ uint160(d));
        } else if (field == 15) {
            i.deadline = i.deadline ^ d;
        } else if (field == 16) {
            i.memoId = i.memoId ^ bytes32(d);
        } else if (field == 17) {
            i.memo = bytes.concat(i.memo, bytes1(uint8(d)));
        } else if (field == 18) {
            i.platformFeeToken = address(uint160(i.platformFeeToken) ^ uint160(d));
        } else if (field == 19) {
            i.platformFeeAmount = i.platformFeeAmount ^ d;
        } else {
            i.platformFeeRecipient = address(uint160(i.platformFeeRecipient) ^ uint160(d));
        }
    }

    // ── the rail: every shape succeeds and leaves nothing behind ────────────

    function test_usdc_direct_burns_exactly_the_signed_burn() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);

        vm.expectEmit(true, true, true, true, address(conduit));
        emit TreasuryBridgeConduitV2.Bridged(
            address(treasury),
            intent.memoId,
            AVALANCHE,
            auth.nonce,
            TreasuryBridgeConduitV2.BridgeKind.CCTP_V2,
            address(messenger),
            address(usdc),
            AMOUNT,
            address(usdc),
            AMOUNT,
            _recipient(),
            1_700,
            intent.memo
        );
        vm.prank(KEEPER);
        conduit.execute(auth, sig, intent, "");

        (
            uint256 amount,
            uint32 domain,
            bytes32 recipient,
            address burnToken,
            bytes32 caller,
            uint256 maxFee,
            uint32 threshold,
            address from
        ) = messenger.last();
        assertEq(amount, AMOUNT, "burn amount is the measured amount");
        assertEq(domain, AVALANCHE, "signed domain");
        assertEq(recipient, _recipient(), "signed mint recipient");
        assertEq(burnToken, address(usdc), "signed bridge asset");
        assertEq(caller, bytes32(0), "signed destination caller");
        assertEq(maxFee, 1_700, "signed max fee");
        assertEq(threshold, 1000, "signed finality threshold (FAST)");
        assertEq(from, address(conduit), "the conduit burns");
        assertEq(usdc.balanceOf(address(messenger)), AMOUNT, "messenger took exactly the burn");
        assertEq(usdc.balanceOf(address(treasury)), START - AMOUNT, "treasury spent exactly the authorization");
        assertTrue(usdc.authorizationState(address(treasury), auth.nonce), "nonce consumed");
        _assertConduitEmpty();
    }

    function test_swap_then_cctp_burns_the_proceeds_and_returns_nothing_else() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(13_000_000);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent, "");
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 13_600_000, "burned the swap proceeds (17 EURC at 0.80)");
        assertEq(eurc.balanceOf(address(treasury)), START - AMOUNT);
        assertEq(usdc.balanceOf(address(treasury)), START, "no USDC left over to sweep");
        _assertConduitEmpty();
    }

    function test_swap_then_cctpx_passes_the_exact_signed_destination_and_forwards_the_fee() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcSwapToEurcCctpx(13_000_000);
        intent.destinationCaller = bytes32(uint256(0xCA11E2));
        intent.minFinalityThreshold = 2000; // SLOW is a signed choice too
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        bytes memory quote = hex"deadbeefcafe";
        ccts.setFee(0.3 ether);
        vm.deal(KEEPER, 1 ether);

        vm.prank(KEEPER);
        conduit.execute{value: 0.5 ether}(auth, sig, intent, quote);

        MockCrossChainTokenService.Call memory c = ccts.last();
        assertEq(c.tokenId, EURC_ID, "signed token id");
        assertEq(c.amount, 13_600_000, "measured burn");
        assertEq(c.destinationDomain, AVALANCHE, "signed domain");
        assertEq(c.destinationAddress, abi.encodePacked(DEST_TREASURY), "20-byte EVM recipient");
        assertEq(c.destinationCaller, bytes32(uint256(0xCA11E2)), "signed destination caller");
        assertEq(c.minFinalityThreshold, 2000, "signed threshold");
        assertEq(c.signedQuote, quote, "quote forwarded verbatim");
        assertEq(c.refundAddress, KEEPER, "fee refunds go to whoever paid it");
        assertFalse(c.autoExecuteHookData, "no hook execution");
        assertEq(c.hookData.length, 0, "no hook data");
        assertEq(c.value, 0.5 ether, "the whole msg.value is forwarded");
        assertEq(c.caller, address(conduit));
        assertEq(KEEPER.balance, 0.7 ether, "keeper paid only the quoted fee");
        assertEq(eurc.balanceOf(address(ccts.manager())), 13_600_000, "manager took exactly the burn");
        assertEq(usdc.balanceOf(address(treasury)), START - AMOUNT);
        _assertConduitEmpty();
    }

    function test_eurc_direct_cctpx_with_zero_fee() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcDirectCctpx();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent, hex"01");
        assertEq(ccts.last().amount, AMOUNT);
        assertEq(eurc.balanceOf(address(treasury)), START - AMOUNT);
        _assertConduitEmpty();
    }

    function test_a_partial_fill_sweeps_the_unspent_input_back_to_the_treasury() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        // The venue spends only 10 of the 17 EURC the conduit holds.
        intent.venueData = abi.encodeCall(MockSwapRouter.swap, (address(eurc), address(usdc), 10e6, address(conduit)));
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent, "");
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 8e6, "burned only the proceeds");
        assertEq(eurc.balanceOf(address(treasury)), START - 10e6, "7 unspent EURC returned");
        _assertConduitEmpty();
    }

    function test_a_stray_balance_is_never_burned() public {
        usdc.mint(address(conduit), 5e6); // someone transferred USDC here directly
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent, "");
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, AMOUNT, "only what this transaction delivered is burned");
        // Like TreasuryConduit, the stray is swept to the treasury in the call.
        assertEq(usdc.balanceOf(address(treasury)), START - AMOUNT + 5e6);
        _assertConduitEmpty();
    }

    // ── invariant 1: mutating ANY signed field fails redemption ─────────────

    function test_every_signed_field_is_bound_by_the_nonce() public {
        for (uint256 shape = 0; shape < 4; shape++) {
            TreasuryBridgeConduitV2.Intent memory signed = _fresh(shape);
            TreasuryBridgeConduitV2.Authorization memory auth = _auth(signed);
            bytes memory sig = _sign(auth);
            for (uint256 field = 0; field < SIGNED_FIELDS; field++) {
                TreasuryBridgeConduitV2.Intent memory tampered = _fresh(shape);
                _mutate(tampered, field, 0xA11CE + field);
                bytes32 tamperedNonce = conduit.intentNonce(tampered);
                assertTrue(tamperedNonce != auth.nonce, "mutation changes the nonce");
                vm.expectRevert(
                    abi.encodeWithSelector(
                        TreasuryBridgeConduitV2.NonceIsNotTheIntent.selector, auth.nonce, tamperedNonce
                    )
                );
                conduit.execute(auth, sig, tampered, "");
            }
            _assertUntouched(auth.nonce, auth.token);
        }
    }

    function testFuzz_any_single_field_mutation_is_refused(uint256 shape, uint256 field, uint256 salt) public {
        shape = bound(shape, 0, 3);
        field = bound(field, 0, SIGNED_FIELDS - 1);
        TreasuryBridgeConduitV2.Intent memory signed = _fresh(shape);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(signed);
        bytes memory sig = _sign(auth);
        TreasuryBridgeConduitV2.Intent memory tampered = _fresh(shape);
        _mutate(tampered, field, salt);
        bytes32 tamperedNonce = conduit.intentNonce(tampered);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.NonceIsNotTheIntent.selector, auth.nonce, tamperedNonce)
        );
        conduit.execute(auth, sig, tampered, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_the_typehash_is_the_documented_string() public view {
        assertEq(
            conduit.INTENT_TYPEHASH(),
            keccak256(
                "BridgeIntentV2(address venue,bytes venueData,address tokenIn,uint256 amountIn,address bridgeAsset,uint256 minBridgeAmount,uint8 bridgeKind,address bridge,bytes32 bridgeTokenId,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,address beneficiary,uint256 deadline,bytes32 memoId,bytes memo,address platformFeeToken,uint256 platformFeeAmount,address platformFeeRecipient)"
            )
        );
    }

    function test_the_nonce_is_one_flat_struct_hash() public view {
        // The split encode inside the contract must equal the flat EIP-712-style
        // encoding a signer's tooling would compute.
        TreasuryBridgeConduitV2.Intent memory i = _usdcSwapToEurcCctpx(1);
        bytes memory head = abi.encode(
            conduit.INTENT_TYPEHASH(),
            i.venue,
            keccak256(i.venueData),
            i.tokenIn,
            i.amountIn,
            i.bridgeAsset,
            i.minBridgeAmount,
            uint8(i.bridgeKind),
            i.bridge
        );
        bytes memory tail = abi.encode(
            i.bridgeTokenId,
            i.destinationDomain,
            i.mintRecipient,
            i.destinationCaller,
            i.maxFee,
            i.minFinalityThreshold,
            i.beneficiary,
            i.deadline,
            i.memoId,
            keccak256(i.memo),
            i.platformFeeToken,
            i.platformFeeAmount,
            i.platformFeeRecipient
        );
        assertEq(head.length + tail.length, 22 * 32, "22 static words");
        assertEq(conduit.intentNonce(i), keccak256(bytes.concat(head, tail)));
    }

    // ── invariants 2 and 6: registries and the beneficiary ──────────────────

    function test_an_unregistered_venue_is_refused() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.prank(SAFE);
        conduit.setTarget(address(router), false);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.TargetNotRegistered.selector, address(router)));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_an_unregistered_bridge_is_refused_for_each_rail() public {
        TreasuryBridgeConduitV2.Intent memory a = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory authA = _auth(a);
        bytes memory sigA = _sign(authA);
        TreasuryBridgeConduitV2.Intent memory b = _eurcDirectCctpx();
        TreasuryBridgeConduitV2.Authorization memory authB = _auth(b);
        bytes memory sigB = _sign(authB);
        vm.startPrank(SAFE);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, address(messenger), false);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTPX, address(ccts), false);
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.BridgeNotRegistered.selector,
                TreasuryBridgeConduitV2.BridgeKind.CCTP_V2,
                address(messenger)
            )
        );
        conduit.execute(authA, sigA, a, "");
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.BridgeNotRegistered.selector,
                TreasuryBridgeConduitV2.BridgeKind.CCTPX,
                address(ccts)
            )
        );
        conduit.execute(authB, sigB, b, "");
        _assertUntouched(authA.nonce, authA.token);
        _assertUntouched(authB.nonce, authB.token);
    }

    function test_a_bridge_registered_for_the_other_rail_is_refused() public {
        // A CCTPx service passed off as a CCTP V2 messenger.
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.bridge = address(ccts);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.BridgeNotRegistered.selector,
                TreasuryBridgeConduitV2.BridgeKind.CCTP_V2,
                address(ccts)
            )
        );
        conduit.execute(auth, sig, intent, "");
    }

    function test_a_bridge_can_never_be_called_as_a_venue() public {
        vm.prank(SAFE);
        conduit.setTarget(address(messenger), true);
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        intent.venue = address(messenger);
        intent.venueData = abi.encodeCall(
            ITokenMessengerV2.depositForBurn,
            (AMOUNT, 0, bytes32(uint256(uint160(ATTACKER))), address(eurc), bytes32(0), 0, 1000)
        );
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.VenueIsABridge.selector, address(messenger)));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_the_cctpx_token_id_must_be_registered_for_the_bridge_asset() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcDirectCctpx();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.prank(SAFE);
        conduit.setCctpxToken(EURC_ID, address(usdc)); // the id now stands for another token
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.BridgeTokenMismatch.selector, EURC_ID, address(usdc), address(eurc)
            )
        );
        conduit.execute(auth, sig, intent, "");
        vm.prank(SAFE);
        conduit.setCctpxToken(EURC_ID, address(0)); // retired
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.BridgeTokenMismatch.selector, EURC_ID, address(0), address(eurc)
            )
        );
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_the_beneficiary_is_always_the_signer() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.beneficiary = ATTACKER;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent); // a quorum that signed a bad intent
        bytes memory sig = _sign(auth);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.BeneficiaryMismatch.selector, ATTACKER, address(treasury))
        );
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_token_and_amount_must_be_the_authorization() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        auth.value = AMOUNT + 1;
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.AmountMismatch.selector, AMOUNT, AMOUNT + 1));
        conduit.execute(auth, "", intent, "");
        auth = _auth(intent);
        auth.token = address(eurc);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.TokenMismatch.selector, address(usdc), address(eurc))
        );
        conduit.execute(auth, "", intent, "");
    }

    // ── invariant 3: the floor
    // ──────────────────────────────────────────────

    function test_a_floor_miss_reverts_and_keeps_the_nonce_then_the_same_signature_works() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(13_600_000);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        router.setRate(7_900); // the market moved after signing
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.BelowFloor.selector, 13_430_000, 13_600_000));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);

        router.setRate(8_100);
        conduit.execute(auth, sig, intent, "");
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 13_770_000);
        _assertConduitEmpty();
    }

    function test_a_route_that_delivers_nothing_misses_any_positive_floor() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        intent.venueData = abi.encodeCall(MockSwapRouter.swallow, (address(eurc), AMOUNT));
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.BelowFloor.selector, 0, 1));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_a_route_that_delivers_elsewhere_misses_the_floor() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        intent.venueData = abi.encodeCall(MockSwapRouter.swap, (address(eurc), address(usdc), AMOUNT, ATTACKER));
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.BelowFloor.selector, 0, 1));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_venue_failure_reverts_with_its_reason() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        router.setBroken(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.TargetCallFailed.selector,
                abi.encodeWithSignature("Error(string)", "router: venue down")
            )
        );
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_bridge_failure_reverts_the_pull() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        messenger.setBroken(true);
        vm.expectRevert(bytes("messenger: down"));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_a_bridge_that_takes_less_than_the_burn_is_refused() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        messenger.setSkim(1);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.BurnMismatch.selector, AMOUNT - 1, AMOUNT));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);

        messenger.setSkim(0);
        TreasuryBridgeConduitV2.Intent memory x = _eurcDirectCctpx();
        TreasuryBridgeConduitV2.Authorization memory authX = _auth(x);
        bytes memory sigX = _sign(authX);
        ccts.setSkim(2);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.BurnMismatch.selector, AMOUNT - 2, AMOUNT));
        conduit.execute(authX, sigX, x, "");
        _assertUntouched(authX.nonce, authX.token);
    }

    // ── invariant 5: fees and destinations exactly as signed ────────────────

    function test_cctpx_native_fee_above_the_signed_max_is_refused() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcDirectCctpx();
        intent.maxFee = 0.1 ether;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.deal(KEEPER, 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.FeeAboveMax.selector, 0.1 ether + 1, 0.1 ether));
        conduit.execute{value: 0.1 ether + 1}(auth, sig, intent, hex"01");
        _assertUntouched(auth.nonce, auth.token);
        // Exactly the cap is fine.
        vm.prank(KEEPER);
        conduit.execute{value: 0.1 ether}(auth, sig, intent, hex"01");
        _assertConduitEmpty();
    }

    function test_cctp_v2_takes_no_native_value_and_no_quote() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.deal(KEEPER, 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.NativeFeeNotAllowed.selector, 1));
        conduit.execute{value: 1}(auth, sig, intent, "");
        vm.expectRevert(TreasuryBridgeConduitV2.QuoteNotAllowed.selector);
        conduit.execute(auth, sig, intent, hex"01");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_cctp_v2_refuses_a_token_id() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.bridgeTokenId = EURC_ID;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.UnexpectedBridgeTokenId.selector, EURC_ID));
        conduit.execute(auth, sig, intent, "");
    }

    function test_the_cctp_max_fee_is_passed_through_and_cctp_enforces_it_below_the_amount() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.maxFee = AMOUNT; // nonsense: CCTP requires maxFee < amount
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(bytes("Max fee must be less than amount"));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_a_zero_mint_recipient_is_refused() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.mintRecipient = bytes32(0);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(TreasuryBridgeConduitV2.ZeroMintRecipient.selector);
        conduit.execute(auth, sig, intent, "");
    }

    function test_cctpx_refuses_a_non_evm_recipient() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcDirectCctpx();
        bytes32 solanaLike = keccak256("a 32-byte solana pubkey");
        intent.mintRecipient = solanaLike;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.NonEvmRecipient.selector, solanaLike));
        conduit.execute(auth, sig, intent, "");
    }

    // ── shape guards
    // ─────────────────────────────────────────────────────────

    function test_no_swap_requires_matching_tokens_and_no_calldata() public {
        TreasuryBridgeConduitV2.Intent memory a = _usdcDirect();
        a.bridgeAsset = address(eurc);
        TreasuryBridgeConduitV2.Authorization memory authA = _auth(a);
        bytes memory sigA = _sign(authA);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.NoSwapButTokensDiffer.selector, address(usdc), address(eurc))
        );
        conduit.execute(authA, sigA, a, "");

        TreasuryBridgeConduitV2.Intent memory b = _usdcDirect();
        b.venueData = hex"00";
        TreasuryBridgeConduitV2.Authorization memory authB = _auth(b);
        bytes memory sigB = _sign(authB);
        vm.expectRevert(TreasuryBridgeConduitV2.NoSwapButCalldata.selector);
        conduit.execute(authB, sigB, b, "");
    }

    function test_a_swap_into_the_same_token_is_refused() public {
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        intent.tokenIn = address(usdc);
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBridgeConduitV2.SwapTokensIdentical.selector, address(usdc)));
        conduit.execute(auth, sig, intent, "");
    }

    // ── invariant 7: expiry
    // ─────────────────────────────────────────────────

    function test_an_expired_intent_is_refused_even_inside_the_authorization_window() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.deadline = block.timestamp + 10 minutes;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent); // window: 1 hour
        bytes memory sig = _sign(auth);
        vm.warp(intent.deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.IntentExpired.selector, intent.deadline, block.timestamp)
        );
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_an_expired_authorization_is_refused_by_the_token() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        intent.deadline = block.timestamp + 2 hours;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent); // window: 1 hour
        bytes memory sig = _sign(auth);
        vm.warp(auth.validBefore);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    // ── invariant 8: reentrancy
    // ─────────────────────────────────────────────

    function test_a_venue_cannot_reenter() public {
        MockReentrantVenue evil = new MockReentrantVenue();
        vm.prank(SAFE);
        conduit.setTarget(address(evil), true);
        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(1);
        intent.venue = address(evil);
        intent.venueData = abi.encodeCall(MockReentrantVenue.swap, ());
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        // A second, independently valid intent the venue tries to run mid-flight.
        TreasuryBridgeConduitV2.Intent memory inner = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory innerAuth = _auth(inner);
        evil.arm(address(conduit), abi.encodeCall(conduit.execute, (innerAuth, _sign(innerAuth), inner, bytes(""))));

        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBridgeConduitV2.TargetCallFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);
        _assertUntouched(innerAuth.nonce, innerAuth.token);
    }

    function test_a_bridge_cannot_reenter() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        TreasuryBridgeConduitV2.Intent memory inner = _eurcDirectCctpx();
        TreasuryBridgeConduitV2.Authorization memory innerAuth = _auth(inner);
        bytes memory innerSig = _sign(innerAuth);
        bytes memory reenter = abi.encodeCall(conduit.execute, (innerAuth, innerSig, inner, bytes("")));
        messenger.setReenter(address(conduit), reenter);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        conduit.execute(auth, sig, intent, "");
        _assertUntouched(auth.nonce, auth.token);

        messenger.setReenter(address(0), "");
        ccts.setReenter(address(conduit), abi.encodeCall(conduit.execute, (auth, sig, intent, bytes(""))));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        conduit.execute(innerAuth, innerSig, inner, hex"01");
        _assertUntouched(innerAuth.nonce, innerAuth.token);
    }

    // ── invariant 10: replay, and the ERC-1271 quorum
    // ───────────────────────

    function test_a_replayed_authorization_is_refused_by_the_token() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        conduit.execute(auth, sig, intent, "");
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        conduit.execute(auth, sig, intent, "");
        assertEq(messenger.calls(), 1, "burned once");
    }

    function test_a_signature_below_the_quorum_threshold_is_refused_by_the_token() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        bytes memory full = _sign(auth);
        bytes memory oneOfTwo = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            oneOfTwo[i] = full[i];
        }
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        conduit.execute(auth, oneOfTwo, intent, "");
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_an_authorization_for_another_contract_does_not_redeem_here() public {
        // The 3009 digest binds `to`: a signature for TreasuryConduit (or any
        // other payee) cannot be spent by this contract, and vice versa.
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        TreasuryBridgeConduitV2 other = new TreasuryBridgeConduitV2(SAFE);
        bytes memory sig = _sign(auth); // signed with to = conduit
        vm.startPrank(SAFE);
        other.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, address(messenger), true);
        vm.stopPrank();
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        other.execute(auth, sig, intent, "");
    }

    // ── fuzz: the conduit is always empty after a success
    // ────────────────────

    function testFuzz_swap_and_burn_leaves_nothing_behind(uint256 amountIn, uint256 spent, uint256 rateBps) public {
        amountIn = bound(amountIn, 1, START);
        spent = bound(spent, 1, amountIn);
        rateBps = bound(rateBps, 1, 20_000);
        router.setRate(rateBps);
        uint256 out = spent * rateBps / 10_000;
        vm.assume(out > 1); // CCTP needs maxFee (1) < amount

        TreasuryBridgeConduitV2.Intent memory intent = _eurcSwapToUsdc(out);
        intent.amountIn = amountIn;
        intent.maxFee = 1;
        intent.venueData = abi.encodeCall(MockSwapRouter.swap, (address(eurc), address(usdc), spent, address(conduit)));
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent, "");

        (uint256 burned,,,,,,,) = messenger.last();
        assertEq(burned, out, "burned exactly the proceeds");
        assertEq(eurc.balanceOf(address(treasury)), START - spent, "unspent input returned");
        assertEq(usdc.balanceOf(address(treasury)), START);
        _assertConduitEmpty();
    }

    // ── governance
    // ───────────────────────────────────────────────────────────

    function test_only_the_safe_governs() public {
        vm.startPrank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER));
        conduit.setTarget(ATTACKER, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER));
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, ATTACKER, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER));
        conduit.setCctpxToken(EURC_ID, ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER));
        conduit.rescue(address(usdc), ATTACKER);
        vm.stopPrank();

        vm.startPrank(SAFE);
        vm.expectRevert(TreasuryBridgeConduitV2.ZeroAddress.selector);
        conduit.setTarget(address(0), true);
        vm.expectRevert(TreasuryBridgeConduitV2.ZeroAddress.selector);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTPX, address(0), true);
        vm.expectRevert(TreasuryBridgeConduitV2.NothingToSweep.selector);
        conduit.rescue(address(usdc), SAFE);
        usdc.mint(address(conduit), 5e6);
        conduit.rescue(address(usdc), address(treasury));
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(treasury)), START + 5e6);
    }

    function test_ownership_moves_in_two_steps() public {
        address next = address(0x5AFE2);
        vm.prank(SAFE);
        conduit.transferOwnership(next);
        assertEq(conduit.owner(), SAFE, "pending until accepted");
        vm.prank(next);
        conduit.acceptOwnership();
        assertEq(conduit.owner(), next);
    }

    function test_the_conduit_refuses_plain_native_transfers() public {
        vm.deal(KEEPER, 1 ether);
        vm.prank(KEEPER);
        (bool ok,) = address(conduit).call{value: 1}("");
        assertFalse(ok, "no receive / fallback");
    }

    function test_a_movement_is_findable_by_memoId() public {
        TreasuryBridgeConduitV2.Intent memory intent = _usdcDirect();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(intent);
        vm.recordLogs();
        conduit.execute(auth, _sign(auth), intent, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "Bridged(address,bytes32,uint32,bytes32,uint8,address,address,uint256,address,uint256,bytes32,uint256,bytes)"
        );
        uint256 matches;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(conduit) || logs[i].topics[0] != topic) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(treasury)))), "treasury indexed");
            assertEq(logs[i].topics[2], keccak256("payroll-2026-10"), "memoId indexed");
            assertEq(logs[i].topics[3], bytes32(uint256(AVALANCHE)), "destination indexed");
            matches++;
        }
        assertEq(matches, 1);
    }
}

contract TreasuryBridgeConduitV2FeeTest is TreasuryBridgeConduitV2Test {
    address internal constant FEE_RECIPIENT = address(0xFEE123);
    uint256 internal constant FEE = AMOUNT * 50 / 10_000;

    function _feeIntent() internal view returns (TreasuryBridgeConduitV2.Intent memory i) {
        i = _usdcDirect();
        i.platformFeeToken = address(usdc);
        i.platformFeeAmount = FEE;
        i.platformFeeRecipient = FEE_RECIPIENT;
        i.minBridgeAmount = AMOUNT - FEE;
    }

    function test_positive_fee_and_net_burn_are_atomic() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        conduit.execute(auth, _sign(auth), i, "");
        (uint256 burned,,,,,,,) = messenger.last();
        assertEq(burned, AMOUNT - FEE);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), FEE);
        assertEq(usdc.balanceOf(address(treasury)), START - AMOUNT);
        _assertConduitEmpty();
    }

    function test_fee_rolls_back_one_unit_below_floor() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        i.minBridgeAmount++;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        bytes memory sig = _sign(auth);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.BelowFloor.selector, AMOUNT - FEE, AMOUNT - FEE + 1)
        );
        conduit.execute(auth, sig, i, "");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_fee_rolls_back_bridge_failure() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        bytes memory sig = _sign(auth);
        messenger.setBroken(true);
        vm.expectRevert("messenger: down");
        conduit.execute(auth, sig, i, "");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_fee_keeps_real_two_owner_quorum_and_replay_protection() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        bytes memory full = _sign(auth);
        bytes memory one = new bytes(65);
        for (uint256 j; j < 65; j++) {
            one[j] = full[j];
        }
        vm.expectRevert();
        conduit.execute(auth, one, i, "");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
        _assertUntouched(auth.nonce, auth.token);
        conduit.execute(auth, full, i, "");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), FEE);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        conduit.execute(auth, full, i, "");
    }

    function test_swap_approves_only_net_input_and_clears() public {
        TreasuryBridgeConduitV2.Intent memory i = _eurcSwapToUsdc(1);
        i.platformFeeToken = address(eurc);
        i.platformFeeAmount = FEE;
        i.platformFeeRecipient = FEE_RECIPIENT;
        i.venueData =
            abi.encodeCall(MockSwapRouter.swap, (address(eurc), address(usdc), AMOUNT - FEE, address(conduit)));
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        conduit.execute(auth, _sign(auth), i, "");
        assertEq(eurc.balanceOf(FEE_RECIPIENT), FEE);
        assertEq(eurc.balanceOf(address(router)), AMOUNT - FEE);
        _assertConduitEmpty();
    }

    function test_venue_cannot_spend_gross_after_fee() public {
        TreasuryBridgeConduitV2.Intent memory i = _eurcSwapToUsdc(1);
        i.platformFeeToken = address(eurc);
        i.platformFeeAmount = FEE;
        i.platformFeeRecipient = FEE_RECIPIENT;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        bytes memory sig = _sign(auth);
        vm.expectRevert();
        conduit.execute(auth, sig, i, "");
        assertEq(eurc.balanceOf(FEE_RECIPIENT), 0);
        _assertUntouched(auth.nonce, auth.token);
    }

    function test_personal_normal_transaction_exact_approval_fee_and_net_burn() public {
        address user = vm.addr(0x123456);
        usdc.mint(user, AMOUNT);
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        i.beneficiary = user;
        vm.startPrank(user);
        usdc.approve(address(conduit), AMOUNT);
        conduit.executePersonal(i, "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), 0);
        assertEq(usdc.allowance(user, address(conduit)), 0);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), FEE);
        (uint256 burned,,,,,,,) = messenger.last();
        assertEq(burned, AMOUNT - FEE);
        _assertConduitEmpty();
    }

    function test_personal_bridge_failure_restores_balance_approval_and_fee() public {
        address user = vm.addr(0x123456);
        usdc.mint(user, AMOUNT);
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        i.beneficiary = user;
        messenger.setBroken(true);
        vm.startPrank(user);
        usdc.approve(address(conduit), AMOUNT);
        vm.expectRevert("messenger: down");
        conduit.executePersonal(i, "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), AMOUNT);
        assertEq(usdc.allowance(user, address(conduit)), AMOUNT);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
        _assertConduitEmpty();
    }

    function test_personal_cannot_pull_someone_else() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        vm.prank(ATTACKER);
        vm.expectRevert(TreasuryBridgeConduitV2.PersonalCallerMismatch.selector);
        conduit.executePersonal(i, "");
        _assertUntouched(bytes32(0), address(usdc));
    }

    function test_zero_floor_and_wrong_fee_asset_rejected_before_pull() public {
        TreasuryBridgeConduitV2.Intent memory i = _feeIntent();
        i.minBridgeAmount = 0;
        TreasuryBridgeConduitV2.Authorization memory auth = _auth(i);
        bytes memory sig = _sign(auth);
        vm.expectRevert(TreasuryBridgeConduitV2.ZeroBridgeFloor.selector);
        conduit.execute(auth, sig, i, "");
        _assertUntouched(auth.nonce, auth.token);
        i.minBridgeAmount = AMOUNT - FEE;
        i.platformFeeToken = address(eurc);
        auth = _auth(i);
        sig = _sign(auth);
        vm.expectRevert(TreasuryBridgeConduitV2.InvalidPlatformFee.selector);
        conduit.execute(auth, sig, i, "");
        _assertUntouched(auth.nonce, auth.token);
    }
}
