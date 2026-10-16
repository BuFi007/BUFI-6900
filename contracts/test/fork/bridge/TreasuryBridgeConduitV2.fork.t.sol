// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryBridgeConduitV2} from "../../../src/bufi/conduit/TreasuryBridgeConduitV2.sol";
import {CircleStackHarness} from "../../harness/CircleStackHarness.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IForkFiatToken is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @notice Source-only proof against actual Fuji USDC + TokenMessengerV2 bytecode.
/// Funding is a local storage cheatcode, quorum accounts are locally deployed real
/// Circle contracts. No destination attestation or live settlement is claimed.
contract TreasuryBridgeConduitV2ForkTest is CircleStackHarness {
    address internal constant USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant OWNER = address(0x5AFE);
    address internal constant FEE_RECIPIENT = address(0xFEE123);
    uint256 internal constant GROSS = 20e6;
    uint256 internal constant FEE = 100_000;
    TreasuryBridgeConduitV2 internal conduit;

    function setUp() public {
        require(block.chainid == 43113, "Fuji fork required");
        require(USDC.code.length > 0 && MESSENGER.code.length > 0, "live Circle contracts absent");
        conduit = new TreasuryBridgeConduitV2(OWNER);
        vm.prank(OWNER);
        conduit.setBridge(TreasuryBridgeConduitV2.BridgeKind.CCTP_V2, MESSENGER, true);
    }

    function _intent(address beneficiary) internal view returns (TreasuryBridgeConduitV2.Intent memory i) {
        i.tokenIn = USDC;
        i.amountIn = GROSS;
        i.bridgeAsset = USDC;
        i.minBridgeAmount = GROSS - FEE;
        i.bridge = MESSENGER;
        i.destinationDomain = 26;
        i.mintRecipient = bytes32(uint256(uint160(address(0xD357))));
        i.minFinalityThreshold = 2000;
        i.beneficiary = beneficiary;
        i.deadline = block.timestamp + 1 hours;
        i.memoId = keccak256("V2 source fork proof");
        i.platformFeeToken = USDC;
        i.platformFeeAmount = FEE;
        i.platformFeeRecipient = FEE_RECIPIENT;
    }

    function _assertSourceBurn(address from, uint256 supplyBefore) internal view {
        assertEq(IERC20(USDC).balanceOf(from), 0);
        assertEq(IERC20(USDC).balanceOf(FEE_RECIPIENT), FEE);
        assertEq(IERC20(USDC).totalSupply(), supplyBefore - (GROSS - FEE));
        assertEq(IERC20(USDC).balanceOf(address(conduit)), 0);
        assertEq(IERC20(USDC).allowance(address(conduit), MESSENGER), 0);
    }

    function test_personal_exact_approval_burns_through_real_cctp() public {
        address human = vm.addr(0x123456);
        deal(USDC, human, GROSS, true);
        uint256 supplyBefore = IERC20(USDC).totalSupply();
        vm.startPrank(human);
        IERC20(USDC).approve(address(conduit), GROSS);
        conduit.executePersonal(_intent(human), "");
        vm.stopPrank();
        assertEq(IERC20(USDC).allowance(human, address(conduit)), 0);
        _assertSourceBurn(human, supplyBefore);
    }

    function test_personal_one_unit_below_floor_rolls_back_real_token_fee_and_allowance() public {
        address human = vm.addr(0x123456);
        deal(USDC, human, GROSS, true);
        uint256 supplyBefore = IERC20(USDC).totalSupply();
        TreasuryBridgeConduitV2.Intent memory i = _intent(human);
        i.minBridgeAmount++;
        vm.startPrank(human);
        IERC20(USDC).approve(address(conduit), GROSS);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryBridgeConduitV2.BelowFloor.selector, GROSS - FEE, GROSS - FEE + 1)
        );
        conduit.executePersonal(i, "");
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(human), GROSS);
        assertEq(IERC20(USDC).allowance(human, address(conduit)), GROSS);
        assertEq(IERC20(USDC).balanceOf(FEE_RECIPIENT), 0);
        assertEq(IERC20(USDC).totalSupply(), supplyBefore);
        assertEq(IERC20(USDC).balanceOf(address(conduit)), 0);
    }

    function test_gas_sca_userop_redeems_two_owner_erc1271_then_burns_real_cctp() public {
        _deployCircleCanonicalStack();
        Signer[] memory signers = _makeSigners("fork treasury", 2);
        UpgradableMSCA treasury = _createWeightedMsca(signers, _uniformWeights(2, 100), 200, bytes32(uint256(1)));
        address[] memory seed = new address[](1);
        seed[0] = FEE_RECIPIENT;
        assertTrue(_installAddressBook(treasury, seed, signers));
        deal(USDC, address(treasury), GROSS, true);
        uint256 supplyBefore = IERC20(USDC).totalSupply();
        TreasuryBridgeConduitV2.Intent memory i = _intent(address(treasury));
        TreasuryBridgeConduitV2.Authorization memory auth = TreasuryBridgeConduitV2.Authorization({
            token: USDC,
            from: address(treasury),
            value: GROSS,
            validAfter: 0,
            validBefore: i.deadline,
            nonce: conduit.intentNonce(i)
        });
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            IForkFiatToken(USDC).DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256(
                        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                    ),
                    auth.from,
                    address(conduit),
                    auth.value,
                    auth.validAfter,
                    auth.validBefore,
                    auth.nonce
                )
            )
        );
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        bytes memory signature;
        for (uint256 j; j < signers.length; j++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[j].key, wrapped);
            signature = bytes.concat(signature, abi.encodePacked(r, s, v));
        }
        bytes memory oneOwner = new bytes(65);
        for (uint256 j; j < 65; j++) {
            oneOwner[j] = signature[j];
        }
        vm.expectRevert();
        conduit.execute(auth, oneOwner, i, "");
        assertFalse(IForkFiatToken(USDC).authorizationState(address(treasury), auth.nonce));
        assertEq(IERC20(USDC).balanceOf(FEE_RECIPIENT), 0);
        Signer[] memory gasSigners = _makeSigners("gas-only carrier", 1);
        UpgradableMSCA gasAccount = _createWeightedMsca(gasSigners, _uniformWeights(1, 100), 100, bytes32(uint256(2)));
        assertEq(IERC20(USDC).balanceOf(address(gasAccount)), 0, "carrier owns no principal");
        assertTrue(
            _executeUserOp(
                gasAccount,
                _executeCalldata(
                    address(conduit),
                    0,
                    abi.encodeCall(TreasuryBridgeConduitV2.execute, (auth, signature, i, bytes("")))
                ),
                gasSigners
            ),
            "carrier UserOp succeeds"
        );
        assertEq(IERC20(USDC).balanceOf(address(gasAccount)), 0, "carrier never receives principal");
        assertTrue(IForkFiatToken(USDC).authorizationState(address(treasury), auth.nonce));
        _assertSourceBurn(address(treasury), supplyBefore);
        vm.expectRevert();
        conduit.execute(auth, signature, i, "");
    }
}
