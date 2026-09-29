// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduit} from "../../../../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryEarnVault} from "../../../../src/bufi/conduit/TreasuryEarnVault.sol";
import {TreasuryRedeemConduit} from "../../../../src/bufi/conduit/TreasuryRedeemConduit.sol";
import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {MockFiatToken3009} from "../../../mocks/MockFiatToken3009.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// Deposit via TreasuryConduit + withdraw via TreasuryRedeemConduit against a
/// real Circle treasury MSCA. The canary the desk rail has to match.
contract TreasuryEarnRoundTripTest is CircleStackHarness {
    MockFiatToken3009 internal usdc;
    TreasuryEarnVault internal vault;
    TreasuryConduit internal conduit;
    TreasuryRedeemConduit internal redeem;
    UpgradableMSCA internal treasury;
    Signer[] internal quorum;

    address internal constant OPS = address(0x0B5);
    uint256 internal constant AMOUNT = 17e6;

    function setUp() public {
        _deployCircleCanonicalStack();
        quorum = _makeSigners("treasury", 2);
        treasury = _createWeightedMsca(quorum, _uniformWeights(2, 100), 200, bytes32(uint256(2)));

        usdc = new MockFiatToken3009("USDC", "USDC");
        vault = new TreasuryEarnVault(IERC20(address(usdc)));
        conduit = new TreasuryConduit(OPS);
        redeem = new TreasuryRedeemConduit(OPS);

        address[] memory seed = new address[](1);
        seed[0] = address(redeem);
        assertTrue(_installAddressBook(treasury, seed, quorum), "address book installs");

        vm.startPrank(OPS);
        conduit.setTarget(address(vault), true);
        redeem.setVault(address(vault), true);
        vm.stopPrank();

        usdc.mint(address(treasury), 100e6);
        vm.warp(1_800_000_000);
    }

    function _depositIntent(uint256 minShares) internal view returns (TreasuryConduit.Intent memory) {
        return TreasuryConduit.Intent({
            target: address(vault),
            data: abi.encodeCall(IERC4626.deposit, (AMOUNT, address(treasury))),
            tokenIn: address(usdc),
            amountIn: AMOUNT,
            tokenOut: address(vault),
            minOut: minShares,
            beneficiary: address(treasury),
            deadline: block.timestamp + 1 hours,
            memoId: keccak256("earn-canary"),
            memo: bytes("deposit 17 USDC")
        });
    }

    function _auth(TreasuryConduit.Intent memory intent)
        internal
        view
        returns (TreasuryConduit.Authorization memory)
    {
        return TreasuryConduit.Authorization({
            token: address(usdc),
            from: address(treasury),
            value: AMOUNT,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: conduit.intentNonce(intent)
        });
    }

    function _sign3009(TreasuryConduit.Authorization memory auth) internal view returns (bytes memory sig) {
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

    function _signRedeem(uint256 shares, uint256 minAssets, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 digest = redeem.redeemHash(address(treasury), address(vault), shares, minAssets, deadline, nonce);
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        for (uint256 i = 0; i < quorum.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(quorum[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function test_deposit_mints_shares_to_the_treasury_in_one_transaction() public {
        TreasuryConduit.Intent memory intent = _depositIntent(AMOUNT);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign3009(auth), intent);

        assertEq(vault.balanceOf(address(treasury)), AMOUNT);
        assertEq(usdc.balanceOf(address(treasury)), 100e6 - AMOUNT);
        assertEq(usdc.balanceOf(address(conduit)), 0);
        assertEq(vault.balanceOf(address(conduit)), 0);
    }

    function test_a_floor_miss_reverts_the_pull_and_leaves_the_nonce_unused() public {
        TreasuryConduit.Intent memory intent = _depositIntent(AMOUNT + 1);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        bytes memory sig = _sign3009(auth);
        vm.expectRevert(abi.encodeWithSelector(TreasuryConduit.BelowFloor.selector, AMOUNT, AMOUNT + 1));
        conduit.execute(auth, sig, intent);

        assertEq(usdc.balanceOf(address(treasury)), 100e6);
        assertEq(vault.balanceOf(address(treasury)), 0);
        assertFalse(usdc.authorizationState(address(treasury), auth.nonce));
    }

    function test_withdraw_returns_usdc_to_the_treasury_and_burns_shares() public {
        TreasuryConduit.Intent memory intent = _depositIntent(AMOUNT);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign3009(auth), intent);

        bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(redeem), AMOUNT));
        assertTrue(
            _executeUserOp(treasury, _executeCalldata(address(vault), 0, approveCall), quorum),
            "approve the redeem conduit"
        );

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 1;
        redeem.redeem(
            address(treasury),
            address(vault),
            AMOUNT,
            AMOUNT,
            deadline,
            nonce,
            _signRedeem(AMOUNT, AMOUNT, deadline, nonce)
        );

        assertEq(vault.balanceOf(address(treasury)), 0);
        assertEq(usdc.balanceOf(address(treasury)), 100e6);
        assertTrue(redeem.usedNonces(address(treasury), nonce));
    }

    function test_redeem_without_the_quorum_signature_is_refused() public {
        TreasuryConduit.Intent memory intent = _depositIntent(AMOUNT);
        TreasuryConduit.Authorization memory auth = _auth(intent);
        conduit.execute(auth, _sign3009(auth), intent);

        bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(redeem), AMOUNT));
        assertTrue(_executeUserOp(treasury, _executeCalldata(address(vault), 0, approveCall), quorum));

        vm.expectRevert();
        redeem.redeem(address(treasury), address(vault), AMOUNT, AMOUNT, block.timestamp + 1 hours, 1, hex"00");
        assertEq(vault.balanceOf(address(treasury)), AMOUNT);
    }

    function test_unregistered_vault_cannot_be_redeemed() public {
        vm.prank(OPS);
        redeem.setVault(address(vault), false);
        vm.expectRevert(abi.encodeWithSelector(TreasuryRedeemConduit.VaultNotRegistered.selector, address(vault)));
        redeem.redeem(
            address(treasury), address(vault), AMOUNT, AMOUNT, block.timestamp + 1 hours, 1, bytes("")
        );
    }
}
