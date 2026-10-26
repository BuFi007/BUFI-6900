// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Permit2ConduitHarness, Permit2TestRouter} from "./TreasuryConduitPermit2.t.sol";
import {TreasuryBridgeConduit} from "../../../../src/bufi/conduit/TreasuryBridgeConduit.sol";
import {TreasuryBridgeConduitPermit2} from "../../../../src/bufi/conduit/TreasuryBridgeConduitPermit2.sol";
import {IPermit2SignatureTransfer} from "../../../../src/bufi/conduit/interfaces/IPermit2SignatureTransfer.sol";
import {MockTokenMessengerV2, MockCrossChainTokenService} from "../../../mocks/MockCctpBridges.sol";
import {MockFiatToken3009} from "../../../mocks/MockFiatToken3009.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";

contract SilentApprovalBridgeToken is MockFiatToken3009 {
    bool public ignoreApproval;
    bool public ignoreReset;
    bool public preserveAllowance;

    constructor() MockFiatToken3009("USDC", "USDC") {}

    function setApprovalBehavior(bool ignoreApproval_, bool ignoreReset_, bool preserveAllowance_) external {
        ignoreApproval = ignoreApproval_;
        ignoreReset = ignoreReset_;
        preserveAllowance = preserveAllowance_;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if ((value == 0 && ignoreReset) || (value != 0 && ignoreApproval)) return true;
        return super.approve(spender, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (!preserveAllowance) super._spendAllowance(owner, spender, value);
    }
}

contract TreasuryBridgeConduitPermit2Test is Permit2ConduitHarness {
    TreasuryBridgeConduitPermit2 internal bridgeConduit;
    MockTokenMessengerV2 internal messenger;
    MockCrossChainTokenService internal ccts;
    SilentApprovalBridgeToken internal bridgeToken;
    address internal constant DEST_TREASURY = address(0xD357);
    bytes32 internal constant OPERATION_ID = keccak256("original-document-payment");
    bytes32 internal constant DOCUMENT = keccak256("document-and-terms-v1");

    function setUp() public override {
        super.setUp();
        bridgeConduit = new TreasuryBridgeConduitPermit2(SAFE, PERMIT2);
        messenger = new MockTokenMessengerV2();
        ccts = new MockCrossChainTokenService();
        bridgeToken = new SilentApprovalBridgeToken();
        vm.startPrank(SAFE);
        bridgeConduit.setTarget(address(router), true);
        bridgeConduit.setPermit2Route(address(router), address(router), true);
        bridgeConduit.setBridge(TreasuryBridgeConduit.BridgeKind.CCTP_V2, address(messenger), true);
        vm.stopPrank();
    }

    function _bridgeIntent() internal view returns (TreasuryBridgeConduit.Intent memory intent) {
        intent.venue = address(router);
        intent.venueData = abi.encodeCall(
            Permit2TestRouter.swap, (address(input), address(bridgeToken), AMOUNT, 13e6, address(bridgeConduit))
        );
        intent.tokenIn = address(input);
        intent.amountIn = AMOUNT;
        intent.bridgeAsset = address(bridgeToken);
        intent.minBridgeAmount = 13e6;
        intent.bridgeKind = TreasuryBridgeConduit.BridgeKind.CCTP_V2;
        intent.bridge = address(messenger);
        intent.destinationDomain = 1;
        intent.mintRecipient = bytes32(uint256(uint160(DEST_TREASURY)));
        intent.maxFee = 1_000;
        intent.minFinalityThreshold = 2000;
        intent.beneficiary = address(treasury);
        intent.deadline = block.timestamp + 1 hours;
        intent.memoId = keccak256("doc-payment");
        intent.memo = "pending destination quorum";
    }

    function _bridgePermit(TreasuryBridgeConduit.Intent memory intent, uint256 nonce)
        internal
        pure
        returns (IPermit2SignatureTransfer.PermitTransferFrom memory)
    {
        return IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions(intent.tokenIn, intent.amountIn),
            nonce: nonce,
            deadline: intent.deadline
        });
    }

    function _signBridge(
        TreasuryBridgeConduit.Intent memory intent,
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        uint256 count
    ) internal view returns (bytes memory sig) {
        bytes32 witness = keccak256(
            abi.encode(
                keccak256("ConduitWitness(bytes32 operationId,bytes32 intentHash)"),
                OPERATION_ID,
                bridgeConduit.permit2BridgeIntentHash(
                    address(treasury),
                    OPERATION_ID,
                    DOCUMENT,
                    intent.venue == address(0) ? address(0) : address(router),
                    intent
                )
            )
        );
        bytes32 hash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                keccak256(abi.encode(TOKEN_TYPEHASH, permit.permitted.token, permit.permitted.amount)),
                address(bridgeConduit),
                permit.nonce,
                permit.deadline,
                witness
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(IPermit2SignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), hash);
        bytes32 wrapped = weightedPlugin.getReplaySafeMessageHash(address(treasury), digest);
        for (uint256 i; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(quorum[i].key, wrapped);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
    }

    function test_permit2_funds_existing_conversion_and_burn_without_claiming_destination_paid() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bridgeConduit.executePermit2(
            permit,
            address(treasury),
            _signBridge(intent, permit, 2),
            OPERATION_ID,
            DOCUMENT,
            address(router),
            intent,
            ""
        );
        (uint256 amount, uint32 domain, bytes32 recipient, address token,,,,) = messenger.last();
        assertEq(amount, 13e6);
        assertEq(domain, 1);
        assertEq(recipient, bytes32(uint256(uint160(DEST_TREASURY))));
        assertEq(token, address(bridgeToken));
        assertEq(input.balanceOf(address(treasury)), 83e18);
        assertEq(bridgeToken.balanceOf(DEST_TREASURY), 0, "source burn is not destination delivery");
        assertTrue(bridgeConduit.executed(address(treasury), OPERATION_ID));
        assertEq(input.allowance(address(bridgeConduit), address(router)), 0);
        assertEq(bridgeToken.allowance(address(bridgeConduit), address(messenger)), 0);
    }

    function test_bridge_requires_full_weighted_quorum() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 1);
        vm.expectRevert();
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 0);
        assertFalse(bridgeConduit.executed(address(treasury), OPERATION_ID));
    }

    function test_bridge_venue_rejects_silently_ignored_approval() public {
        input.setApprovalBehavior(true, false);
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.venueData = abi.encodeCall(
            Permit2TestRouter.swap, (address(input), address(bridgeToken), 0, 13e6, address(bridgeConduit))
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("AllowanceMismatch(address,address,uint256,uint256)")),
                address(input),
                address(router),
                AMOUNT,
                0
            )
        );
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 0);
    }

    function test_bridge_venue_rejects_silently_ignored_reset() public {
        input.setApprovalBehavior(false, true);
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.venueData = abi.encodeCall(
            Permit2TestRouter.swap, (address(input), address(bridgeToken), 10e18, 13e6, address(bridgeConduit))
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("AllowanceMismatch(address,address,uint256,uint256)")),
                address(input),
                address(router),
                0,
                7e18
            )
        );
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(input.allowance(address(bridgeConduit), address(router)), 0);
        assertEq(messenger.calls(), 0);
    }

    function _assertSilentBurnApproval(bool useCctpx, bool reset) private {
        bridgeToken.setApprovalBehavior(!reset, reset, reset);
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        address spender = address(messenger);
        if (useCctpx) {
            bytes32 tokenId = keccak256("test-eurc-token-id");
            ccts.setToken(tokenId, address(bridgeToken));
            vm.startPrank(SAFE);
            bridgeConduit.setBridge(TreasuryBridgeConduit.BridgeKind.CCTPX, address(ccts), true);
            bridgeConduit.setCctpxToken(tokenId, address(bridgeToken));
            vm.stopPrank();
            intent.bridgeKind = TreasuryBridgeConduit.BridgeKind.CCTPX;
            intent.bridge = address(ccts);
            intent.bridgeTokenId = tokenId;
            intent.maxFee = 0;
            spender = address(ccts.manager());
        }
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("AllowanceMismatch(address,address,uint256,uint256)")),
                address(bridgeToken),
                spender,
                reset ? 0 : 13e6,
                reset ? 13e6 : 0
            )
        );
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertFalse(bridgeConduit.executed(address(treasury), OPERATION_ID));
        assertEq(bridgeToken.allowance(address(bridgeConduit), spender), 0);
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertEq(useCctpx ? ccts.calls() : messenger.calls(), 0);
    }

    function test_cctp_rejects_silently_ignored_approval() public {
        _assertSilentBurnApproval(false, false);
    }

    function test_cctp_rejects_silently_ignored_reset() public {
        _assertSilentBurnApproval(false, true);
    }

    function test_cctpx_rejects_silently_ignored_approval() public {
        _assertSilentBurnApproval(true, false);
    }

    function test_cctpx_rejects_silently_ignored_reset() public {
        _assertSilentBurnApproval(true, true);
    }

    function test_zero_bridge_floor_cannot_consume_an_operation() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.minBridgeAmount = 0;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(TreasuryBridgeConduitPermit2.InvalidPermit2Intent.selector);
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertFalse(bridgeConduit.executed(address(treasury), OPERATION_ID));
    }

    function test_bridge_replay_with_fresh_nonce_cannot_burn_twice() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bridgeConduit.executePermit2(
            permit,
            address(treasury),
            _signBridge(intent, permit, 2),
            OPERATION_ID,
            DOCUMENT,
            address(router),
            intent,
            ""
        );
        permit.nonce = 3;
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(TreasuryBridgeConduitPermit2.OperationAlreadyExecuted.selector);
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 1);
    }

    function test_destination_terms_are_covered_by_the_quorum() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        intent.mintRecipient = bytes32(uint256(uint160(address(0xBAD))));
        vm.expectRevert();
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 0);
    }

    function test_document_commitment_is_covered_by_the_quorum() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert();
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, keccak256("changed"), address(router), intent, ""
        );
        assertEq(messenger.calls(), 0);
    }

    function test_partial_source_fill_preserves_donations_and_refunds_only_unused_input() public {
        input.mint(address(bridgeConduit), 123);
        bridgeToken.mint(address(bridgeConduit), 456);
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.venueData = abi.encodeCall(
            Permit2TestRouter.swap, (address(input), address(bridgeToken), 10e18, 13e6, address(bridgeConduit))
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bridgeConduit.executePermit2(
            permit,
            address(treasury),
            _signBridge(intent, permit, 2),
            OPERATION_ID,
            DOCUMENT,
            address(router),
            intent,
            ""
        );
        assertEq(input.balanceOf(address(bridgeConduit)), 123);
        assertEq(bridgeToken.balanceOf(address(bridgeConduit)), 456);
        assertEq(input.balanceOf(address(treasury)), 90e18);
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 13e6);
    }

    function test_failed_burn_keeps_source_funds_nonce_and_operation_recoverable() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        messenger.setSkim(1);
        vm.expectRevert();
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(input.balanceOf(address(treasury)), 100e18);
        assertEq(messenger.calls(), 0);
        assertFalse(bridgeConduit.executed(address(treasury), OPERATION_ID));
        messenger.setSkim(0);
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 1);
    }

    function test_source_transfer_fee_is_rejected() public {
        input.setShortTransfer(true);
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.expectRevert(TreasuryBridgeConduitPermit2.InexactInput.selector);
        bridgeConduit.executePermit2(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        assertEq(messenger.calls(), 0);
    }

    function test_cctp_native_value_and_wrong_spender_are_rejected() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.deal(address(this), 1);
        vm.expectRevert();
        bridgeConduit.executePermit2{value: 1}(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, ""
        );
        vm.expectRevert(TreasuryBridgeConduitPermit2.Permit2RouteNotRegistered.selector);
        bridgeConduit.executePermit2(permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(input), intent, "");
    }

    function test_direct_usdc_funding_reuses_the_cctp_burn() public {
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.venue = address(0);
        intent.venueData = "";
        intent.tokenIn = address(bridgeToken);
        intent.amountIn = 17e6;
        intent.minBridgeAmount = 17e6;
        bridgeToken.mint(address(treasury), 17e6);
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(
                    IStandardExecutor.execute,
                    (address(bridgeToken), 0, abi.encodeCall(IERC20.approve, (PERMIT2, 17e6)))
                ),
                quorum
            )
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bridgeConduit.executePermit2(
            permit, address(treasury), _signBridge(intent, permit, 2), OPERATION_ID, DOCUMENT, address(0), intent, ""
        );
        (uint256 amount,,,,,,,) = messenger.last();
        assertEq(amount, 17e6);
        assertEq(bridgeToken.balanceOf(address(treasury)), 0);
    }

    function test_cctpx_reuses_fee_cap_and_clears_token_manager_allowance() public {
        bytes32 tokenId = keccak256("test-eurc-token-id");
        ccts.setToken(tokenId, address(bridgeToken));
        ccts.setFee(3);
        vm.startPrank(SAFE);
        bridgeConduit.setBridge(TreasuryBridgeConduit.BridgeKind.CCTPX, address(ccts), true);
        bridgeConduit.setCctpxToken(tokenId, address(bridgeToken));
        vm.stopPrank();
        TreasuryBridgeConduit.Intent memory intent = _bridgeIntent();
        intent.bridgeKind = TreasuryBridgeConduit.BridgeKind.CCTPX;
        intent.bridge = address(ccts);
        intent.bridgeTokenId = tokenId;
        intent.maxFee = 3;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _bridgePermit(intent, 2);
        bytes memory sig = _signBridge(intent, permit, 2);
        vm.deal(address(this), 4);
        vm.expectRevert();
        bridgeConduit.executePermit2{value: 4}(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, hex"01"
        );
        bridgeConduit.executePermit2{value: 3}(
            permit, address(treasury), sig, OPERATION_ID, DOCUMENT, address(router), intent, hex"01"
        );
        assertEq(ccts.calls(), 1);
        assertEq(bridgeToken.allowance(address(bridgeConduit), address(ccts.manager())), 0);
        assertEq(bridgeToken.balanceOf(DEST_TREASURY), 0);
    }
}
