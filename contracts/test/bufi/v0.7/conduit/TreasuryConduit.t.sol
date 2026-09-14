// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduit} from "../../../../src/bufi/conduit/TreasuryConduit.sol";
import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {MockFiatToken3009} from "../../../mocks/MockFiatToken3009.sol";
import {MockSwapRouter} from "../../../mocks/MockSwapRouter.sol";
import {MockVault4626} from "../../../mocks/MockVault4626.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice The on-chain conduit against a REAL Circle treasury: a weighted
/// 2-of-2 MSCA with ColdStorageAddressBook installed, signing the ERC-3009
/// authorization through the plugin's ERC-1271 path. Plan 353.
contract TreasuryConduitTest is CircleStackHarness {
    MockFiatToken3009 internal usdc;
    MockFiatToken3009 internal eurc;
    MockSwapRouter internal router;
    MockVault4626 internal vault;
    TreasuryConduit internal conduit;
    UpgradableMSCA internal treasury;
    Signer[] internal quorum;

    address internal constant OPS_MULTISIG = address(0x0B5);
    address internal constant KEEPER = address(0xCAFE);
    uint256 internal constant AMOUNT = 17e6;

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
        vault = new MockVault4626(IERC20(address(usdc)));
        conduit = new TreasuryConduit(OPS_MULTISIG);
        vm.startPrank(OPS_MULTISIG);
        conduit.setTarget(address(router), true);
        conduit.setTarget(address(vault), true);
        vm.stopPrank();

        usdc.mint(address(treasury), 100e6);
        vm.warp(1_800_000_000);
    }

    // ── helpers
    // ─────────────────────────────────────────────────────────────

    function _swapIntent(uint256 minOut) internal view returns (TreasuryConduit.Intent memory) {
        return TreasuryConduit.Intent({
            target: address(router),
            data: abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(eurc), AMOUNT, address(conduit))),
            tokenIn: address(usdc),
            amountIn: AMOUNT,
            tokenOut: address(eurc),
            minOut: minOut,
            beneficiary: address(treasury),
            deadline: block.timestamp + 1 hours
        });
    }

    function _auth(TreasuryConduit.Intent memory intent) internal view returns (TreasuryConduit.Authorization memory) {
        return TreasuryConduit.Authorization({
            token: address(usdc),
            from: address(treasury),
            value: AMOUNT,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: conduit.intentNonce(intent)
        });
    }

    /// The quorum signs the token's EIP-712 digest, wrapped in the account's
    /// replay-safe hash, one 65-byte (r,s,v) per owner — the plugin's 1271 blob.
    function _sign(TreasuryConduit.Authorization memory auth) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                auth.from,
                address(conduit),
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        for (uint256 i = 0; i < quorum.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(quorum[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function _assertUntouched(bytes32 nonce) internal view {
        assertEq(usdc.balanceOf(address(treasury)), 100e6, "treasury USDC unchanged");
        assertEq(usdc.balanceOf(address(conduit)), 0, "conduit holds no USDC");
        assertEq(eurc.balanceOf(address(conduit)), 0, "conduit holds no EURC");
        assertFalse(usdc.authorizationState(address(treasury), nonce), "nonce still unused");
    }

    // ── the rail
    // ────────────────────────────────────────────────────────────

    function test_swap_pulls_swaps_and_returns_in_one_transaction() public {
        TreasuryConduit.Intent memory intent = _swapIntent(13_500_000);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);

        vm.expectEmit(true, true, true, true, address(conduit));
        emit TreasuryConduit.Executed(
            address(treasury), auth.nonce, address(router), address(usdc), AMOUNT, address(eurc), 13_600_000
        );
        vm.prank(KEEPER); // anyone may drive it
        conduit.execute(auth, sig, intent);

        assertEq(usdc.balanceOf(address(treasury)), 100e6 - AMOUNT, "treasury spent exactly the authorization");
        assertEq(eurc.balanceOf(address(treasury)), 13_600_000, "proceeds are the treasury's");
        assertEq(usdc.balanceOf(address(conduit)), 0, "conduit keeps nothing");
        assertEq(eurc.balanceOf(address(conduit)), 0, "conduit keeps nothing");
        assertEq(usdc.allowance(address(conduit), address(router)), 0, "allowance cleared");
        assertTrue(usdc.authorizationState(address(treasury), auth.nonce), "nonce consumed");
    }

    function test_earn_deposit_mints_shares_to_the_treasury() public {
        TreasuryConduit.Intent memory intent = TreasuryConduit.Intent({
            target: address(vault),
            data: abi.encodeCall(vault.deposit, (AMOUNT, address(treasury))),
            tokenIn: address(usdc),
            amountIn: AMOUNT,
            tokenOut: address(vault),
            minOut: AMOUNT, // fresh vault: 1:1
            beneficiary: address(treasury),
            deadline: block.timestamp + 1 hours
        });
        TreasuryConduit.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign(auth), intent);
        assertEq(vault.balanceOf(address(treasury)), AMOUNT, "shares belong to the treasury");
        assertEq(vault.balanceOf(address(conduit)), 0);
        assertEq(usdc.balanceOf(address(conduit)), 0);
    }

    function test_a_replayed_authorization_is_refused_by_the_token() public {
        TreasuryConduit.Intent memory intent = _swapIntent(0);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        conduit.execute(auth, sig, intent);
        vm.expectRevert();
        conduit.execute(auth, sig, intent);
    }

    // ── every failure leaves the treasury exactly as it was ──────────────────

    function test_floor_miss_reverts_whole_transaction_and_keeps_the_nonce() public {
        TreasuryConduit.Intent memory intent = _swapIntent(13_600_000);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        router.setRate(7_900); // the market moved under the floor after signing
        vm.expectRevert(abi.encodeWithSelector(TreasuryConduit.BelowFloor.selector, 13_430_000, 13_600_000));
        conduit.execute(auth, sig, intent);
        _assertUntouched(auth.nonce);
        // The world improves; the SAME signature still works.
        router.setRate(8_100);
        conduit.execute(auth, sig, intent);
        assertEq(eurc.balanceOf(address(treasury)), 13_770_000);
    }

    function test_venue_failure_reverts_with_its_reason() public {
        TreasuryConduit.Intent memory intent = _swapIntent(0);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        router.setBroken(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryConduit.TargetCallFailed.selector,
                abi.encodeWithSignature("Error(string)", "router: venue down")
            )
        );
        conduit.execute(auth, sig, intent);
        _assertUntouched(auth.nonce);
    }

    function test_a_route_that_delivers_nothing_is_below_any_positive_floor() public {
        TreasuryConduit.Intent memory intent = _swapIntent(1);
        intent.data = abi.encodeCall(MockSwapRouter.swallow, (address(usdc), AMOUNT));
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryConduit.BelowFloor.selector, 0, 1));
        conduit.execute(auth, sig, intent);
        _assertUntouched(auth.nonce);
    }

    function test_the_nonce_must_be_the_intent_the_quorum_signed() public {
        TreasuryConduit.Intent memory signedIntent = _swapIntent(13_500_000);
        TreasuryConduit.Authorization memory auth = _auth(signedIntent);
        bytes memory sig = _sign(auth);
        // A server that swaps the calldata after the quorum signed.
        TreasuryConduit.Intent memory tampered = signedIntent;
        tampered.data = abi.encodeCall(MockSwapRouter.swap, (address(usdc), address(eurc), AMOUNT, KEEPER));
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryConduit.NonceIsNotTheIntent.selector, auth.nonce, conduit.intentNonce(tampered)
            )
        );
        conduit.execute(auth, sig, tampered);
        _assertUntouched(auth.nonce);
    }

    function test_the_beneficiary_is_always_the_signer() public {
        TreasuryConduit.Intent memory intent = _swapIntent(0);
        intent.beneficiary = KEEPER;
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryConduit.BeneficiaryMismatch.selector, KEEPER, address(treasury)));
        conduit.execute(auth, sig, intent);
        _assertUntouched(auth.nonce);
    }

    function test_unregistered_target_and_expired_intent_are_refused() public {
        TreasuryConduit.Intent memory intent = _swapIntent(0);
        vm.prank(OPS_MULTISIG);
        conduit.setTarget(address(router), false);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryConduit.TargetNotRegistered.selector, address(router)));
        conduit.execute(auth, sig, intent);

        vm.prank(OPS_MULTISIG);
        conduit.setTarget(address(router), true);
        vm.warp(intent.deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryConduit.IntentExpired.selector, intent.deadline, block.timestamp)
        );
        conduit.execute(auth, sig, intent);
        _assertUntouched(auth.nonce);
    }

    function test_a_signature_below_the_quorum_threshold_is_refused_by_the_token() public {
        TreasuryConduit.Intent memory intent = _swapIntent(0);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory full = _sign(auth);
        bytes memory oneOfTwo = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            oneOfTwo[i] = full[i];
        }
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        conduit.execute(auth, oneOfTwo, intent);
        _assertUntouched(auth.nonce);
    }

    function test_governance_only_touches_the_registry_and_strays() public {
        vm.expectRevert();
        conduit.setTarget(KEEPER, true);
        usdc.mint(address(conduit), 5e6); // a stray direct transfer
        vm.prank(OPS_MULTISIG);
        conduit.rescue(address(usdc), address(treasury));
        assertEq(usdc.balanceOf(address(treasury)), 105e6);
    }
}
