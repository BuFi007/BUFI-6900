// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";
import {MockGatewayWallet} from "../../../mocks/MockGatewayWallet.sol";

import {GatewayBalanceType} from "../../../../src/bufi/v0.8/gateway/GatewayEnums.sol";
import {GatewayHelper} from "../../../../src/bufi/v0.8/gateway/GatewayHelper.sol";
import {IGatewayHelper} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayHelper.sol";
import {IGatewayWallet} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/src/Test.sol";

/// @notice `GatewayHelper` against a local `MockGatewayWallet`: the encoder contract, and the behavioural
///         assertions of the Sepolia fork suite (`test/fork/gateway/GatewayHelper.t.sol`) — above all
///         `test_DirectExecution_PreservesMsgSender`, the finding that Gateway attributes deposits and
///         delegations to `msg.sender`, so an account must call Gateway DIRECTLY with helper-encoded calldata.
contract GatewayHelperLocalTest is Test {
    uint256 internal constant WITHDRAWAL_DELAY_BLOCKS = 100;

    MockGatewayWallet internal gateway;
    SandboxUSDC internal usdc;
    GatewayHelper internal helper;

    address internal msca = makeAddr("msca");
    address internal delegate = makeAddr("delegate");

    function setUp() public {
        gateway = new MockGatewayWallet(WITHDRAWAL_DELAY_BLOCKS);
        usdc = new SandboxUSDC();
        gateway.setSupportedToken(address(usdc), true);
        helper = new GatewayHelper(address(gateway));
        vm.label(address(gateway), "MockGatewayWallet");
        vm.label(address(helper), "GatewayHelper");
        vm.deal(msca, 10 ether);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Construction + encoders                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_constructor_storesTheGatewayWallet_andRejectsZero() public {
        assertEq(helper.gatewayWallet(), address(gateway));
        vm.expectRevert("Invalid gateway wallet");
        new GatewayHelper(address(0));
    }

    function test_encodeAuthorizeDelegate_targetsGatewayWithAddDelegateCalldata() public view {
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        assertEq(target, address(gateway));
        assertEq(data, abi.encodeCall(IGatewayWallet.addDelegate, (address(usdc), delegate)));
        assertEq(bytes4(data), IGatewayWallet.addDelegate.selector);
    }

    function test_encodeRevokeDelegate_targetsGatewayWithRemoveDelegateCalldata() public view {
        (address target, bytes memory data) = helper.encodeRevokeDelegate(address(usdc), delegate);
        assertEq(target, address(gateway));
        assertEq(data, abi.encodeCall(IGatewayWallet.removeDelegate, (address(usdc), delegate)));
    }

    function test_encodeDeposit_targetsGatewayWithDepositCalldata() public view {
        (address target, bytes memory data) = helper.encodeDeposit(address(usdc), 1e6);
        assertEq(target, address(gateway));
        assertEq(data, abi.encodeCall(IGatewayWallet.deposit, (address(usdc), 1e6)));
    }

    function test_encodeInitiateWithdrawal_targetsGatewayWithInitiateWithdrawalCalldata() public view {
        (address target, bytes memory data) = helper.encodeInitiateWithdrawal(address(usdc), 1e6);
        assertEq(target, address(gateway));
        assertEq(data, abi.encodeCall(IGatewayWallet.initiateWithdrawal, (address(usdc), 1e6)));
    }

    function test_encodeCompleteWithdrawal_targetsGatewayWithWithdrawCalldata() public view {
        (address target, bytes memory data) = helper.encodeCompleteWithdrawal(address(usdc));
        assertEq(target, address(gateway));
        assertEq(data, abi.encodeCall(IGatewayWallet.withdraw, (address(usdc))));
    }

    function test_encodeApproveGateway_targetsTheTokenNotGateway() public view {
        (address target, bytes memory data) = helper.encodeApproveGateway(address(usdc), 1e6);
        assertEq(target, address(usdc));
        assertEq(data, abi.encodeCall(IERC20.approve, (address(gateway), 1e6)));
    }

    function test_encodedSelectors_matchTheFunctionSignaturesTheForkSuiteVerified() public pure {
        assertEq(bytes4(keccak256("addDelegate(address,address)")), bytes4(0xe909ebfa));
        assertEq(bytes4(keccak256("removeDelegate(address,address)")), bytes4(0x020d308d));
        assertEq(IGatewayWallet.addDelegate.selector, bytes4(0xe909ebfa));
        assertEq(IGatewayWallet.removeDelegate.selector, bytes4(0x020d308d));
        assertEq(IGatewayWallet.deposit.selector, bytes4(keccak256("deposit(address,uint256)")));
        assertEq(
            IGatewayWallet.isAuthorizedForBalance.selector,
            bytes4(keccak256("isAuthorizedForBalance(address,address,address)"))
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Input validation                                                               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_encoders_rejectZeroDelegate() public {
        vm.expectRevert(IGatewayHelper.InvalidDelegate.selector);
        helper.encodeAuthorizeDelegate(address(usdc), address(0));
        vm.expectRevert(IGatewayHelper.InvalidDelegate.selector);
        helper.encodeRevokeDelegate(address(usdc), address(0));
    }

    function test_encoders_rejectZeroToken() public {
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeAuthorizeDelegate(address(0), delegate);
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeRevokeDelegate(address(0), delegate);
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeDeposit(address(0), 1e6);
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeInitiateWithdrawal(address(0), 1e6);
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeCompleteWithdrawal(address(0));
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeApproveGateway(address(0), 1e6);
    }

    function test_encoders_rejectZeroAmount() public {
        vm.expectRevert(IGatewayHelper.InvalidAmount.selector);
        helper.encodeDeposit(address(usdc), 0);
        vm.expectRevert(IGatewayHelper.InvalidAmount.selector);
        helper.encodeInitiateWithdrawal(address(usdc), 0);
        vm.expectRevert(IGatewayHelper.InvalidAmount.selector);
        helper.encodeApproveGateway(address(usdc), 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Views                                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_views_readZeroForANewDepositor_andTheConfiguredDelay() public view {
        assertEq(helper.getAvailableBalance(address(usdc), msca), 0);
        assertEq(helper.getTotalBalance(address(usdc), msca), 0);
        assertEq(helper.getWithdrawableBalance(address(usdc), msca), 0);
        assertEq(helper.getWithdrawalDelay(), WITHDRAWAL_DELAY_BLOCKS);
        assertFalse(helper.isDelegateAuthorized(address(usdc), msca, delegate));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Direct execution preserves msg.sender — the finding                            ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_DirectExecution_PreservesMsgSender() public {
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        assertFalse(helper.isDelegateAuthorized(address(usdc), msca, delegate), "not authorized initially");

        // Simulates msca.execute(target, 0, data): the account is the caller Gateway sees.
        vm.prank(msca);
        (bool success,) = target.call(data);
        assertTrue(success, "direct call succeeds");

        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, delegate), "delegation keyed to the MSCA");
        assertFalse(helper.isDelegateAuthorized(address(usdc), address(helper), delegate), "never to the helper");
    }

    function test_delegationLifecycle_directExecution() public {
        assertFalse(helper.isDelegateAuthorized(address(usdc), msca, delegate));

        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        vm.prank(msca);
        (bool ok,) = target.call(data);
        assertTrue(ok, "authorize");
        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, delegate));

        (target, data) = helper.encodeRevokeDelegate(address(usdc), delegate);
        vm.prank(msca);
        (ok,) = target.call(data);
        assertTrue(ok, "revoke");
        assertFalse(helper.isDelegateAuthorized(address(usdc), msca, delegate));
    }

    function test_multipleDelegates_canBeAuthorizedForOneAccount() public {
        address delegate2 = makeAddr("delegate2");
        _directCall(helper.encodeAuthorizeDelegate, address(usdc), delegate);
        _directCall(helper.encodeAuthorizeDelegate, address(usdc), delegate2);
        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, delegate));
        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, delegate2));
    }

    function test_delegateIsTokenScoped() public {
        SandboxUSDC eurc = new SandboxUSDC();
        gateway.setSupportedToken(address(eurc), true);
        _directCall(helper.encodeAuthorizeDelegate, address(usdc), delegate);
        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, delegate));
        assertFalse(helper.isDelegateAuthorized(address(eurc), msca, delegate), "USDC only");
        assertFalse(helper.isDelegateAuthorized(makeAddr("unsupported-token"), msca, delegate));
    }

    function test_depositor_isAlwaysAuthorizedForItsOwnBalance() public view {
        assertTrue(helper.isDelegateAuthorized(address(usdc), msca, msca));
    }

    function test_deposit_directExecution_creditsTheAccountThatCalled() public {
        uint256 amount = 1_000e6;
        usdc.mint(msca, amount);

        _directCall(helper.encodeApproveGateway, address(usdc), amount);
        _directCall(helper.encodeDeposit, address(usdc), amount);

        assertEq(helper.getTotalBalance(address(usdc), msca), amount, "credited to the MSCA");
        assertEq(helper.getAvailableBalance(address(usdc), msca), amount);
        assertEq(helper.getTotalBalance(address(usdc), address(helper)), 0, "the helper holds nothing");
        assertEq(usdc.balanceOf(msca), 0);
        assertEq(usdc.balanceOf(address(gateway)), amount);
    }

    function test_withdrawal_directExecution_isTwoStepAndRespectsTheBlockDelay() public {
        uint256 amount = 1_000e6;
        usdc.mint(msca, amount);
        _directCall(helper.encodeApproveGateway, address(usdc), amount);
        _directCall(helper.encodeDeposit, address(usdc), amount);

        _directCall(helper.encodeInitiateWithdrawal, address(usdc), amount);
        assertEq(helper.getAvailableBalance(address(usdc), msca), 0, "moved out of available");
        assertEq(gateway.withdrawingBalance(address(usdc), msca), amount);
        assertEq(helper.getTotalBalance(address(usdc), msca), amount, "still counted in total");
        assertEq(helper.getWithdrawableBalance(address(usdc), msca), 0, "not yet withdrawable");
        uint256 readyAt = gateway.withdrawalBlock(address(usdc), msca);
        assertEq(readyAt, block.number + WITHDRAWAL_DELAY_BLOCKS);

        (address target, bytes memory data) = helper.encodeCompleteWithdrawal(address(usdc));
        vm.roll(readyAt - 1);
        vm.prank(msca);
        vm.expectRevert(
            abi.encodeWithSelector(MockGatewayWallet.WithdrawalDelayNotElapsed.selector, readyAt, block.number)
        );
        IGatewayWallet(target).withdraw(address(usdc));

        vm.roll(readyAt);
        assertEq(helper.getWithdrawableBalance(address(usdc), msca), amount, "withdrawable once the delay elapsed");
        vm.prank(msca);
        (bool ok,) = target.call(data);
        assertTrue(ok, "withdraw");
        assertEq(usdc.balanceOf(msca), amount, "USDC back on the MSCA");
        assertEq(helper.getTotalBalance(address(usdc), msca), 0);
        assertEq(helper.getWithdrawableBalance(address(usdc), msca), 0);
    }

    function test_balanceOf_erc1155StyleIds_followTheGatewayBalanceTypeEncoding() public {
        uint256 amount = 300e6;
        usdc.mint(msca, amount);
        _directCall(helper.encodeApproveGateway, address(usdc), amount);
        _directCall(helper.encodeDeposit, address(usdc), amount);
        _directCall(helper.encodeInitiateWithdrawal, address(usdc), 100e6);

        assertEq(gateway.balanceOf(msca, _balanceId(GatewayBalanceType.Total)), 300e6);
        assertEq(gateway.balanceOf(msca, _balanceId(GatewayBalanceType.Available)), 200e6);
        assertEq(gateway.balanceOf(msca, _balanceId(GatewayBalanceType.Withdrawing)), 100e6);
        assertEq(gateway.balanceOf(msca, _balanceId(GatewayBalanceType.Withdrawable)), 0);
        vm.roll(block.number + WITHDRAWAL_DELAY_BLOCKS);
        assertEq(gateway.balanceOf(msca, _balanceId(GatewayBalanceType.Withdrawable)), 100e6);

        address[] memory depositors = new address[](2);
        depositors[0] = msca;
        depositors[1] = msca;
        uint256[] memory ids = new uint256[](2);
        ids[0] = _balanceId(GatewayBalanceType.Total);
        ids[1] = _balanceId(GatewayBalanceType.Available);
        uint256[] memory batch = gateway.balanceOfBatch(depositors, ids);
        assertEq(batch[0], 300e6);
        assertEq(batch[1], 200e6);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// Encode with the helper, then execute as the account (msca.execute(target, 0, data), simulated).
    function _directCall(
        function(address, uint256) external view returns (address, bytes memory) encoder,
        address token,
        uint256 amountOrDelegate
    ) internal {
        (address target, bytes memory data) = encoder(token, amountOrDelegate);
        vm.prank(msca);
        (bool ok,) = target.call(data);
        assertTrue(ok, "direct call");
    }

    function _directCall(
        function(address, address) external view returns (address, bytes memory) encoder,
        address token,
        address delegate_
    ) internal {
        (address target, bytes memory data) = encoder(token, delegate_);
        vm.prank(msca);
        (bool ok,) = target.call(data);
        assertTrue(ok, "direct call");
    }

    function _balanceId(GatewayBalanceType kind) internal view returns (uint256) {
        return uint256(bytes32(abi.encodePacked(uint96(uint8(kind)), address(usdc))));
    }
}

/// @notice The same helper driven by a REAL Circle v0.7 MSCA through multisig-signed userOps: Gateway sees the
///         account as `msg.sender` because `execute` is a plain call from the account. Also shows what
///         ColdStorageAddressBookPlugin does to that path.
contract GatewayHelperOnCircleMscaTest is CircleStackHarness {
    uint256 internal constant WITHDRAWAL_DELAY_BLOCKS = 100;

    MockGatewayWallet internal gateway;
    SandboxUSDC internal usdc;
    GatewayHelper internal helper;
    UpgradableMSCA internal msca;
    Signer[] internal quorum;

    address internal delegate = makeAddr("delegate");

    function setUp() public {
        _deployCircleCanonicalStack();
        gateway = new MockGatewayWallet(WITHDRAWAL_DELAY_BLOCKS);
        usdc = new SandboxUSDC();
        gateway.setSupportedToken(address(usdc), true);
        helper = new GatewayHelper(address(gateway));

        Signer[] memory owners = _makeSigners("treasury", 3);
        quorum.push(owners[0]);
        quorum.push(owners[1]);
        msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(0x6A)));
        usdc.mint(address(msca), 10_000e6);
    }

    function test_helperCalldataThroughAMultisigUserOp_attributesTheDelegationToTheMsca() public {
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        assertTrue(_executeUserOp(msca, _executeCalldata(target, 0, data), quorum), "authorize userOp");
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(msca), delegate), "keyed to the MSCA");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(helper), delegate));

        (target, data) = helper.encodeRevokeDelegate(address(usdc), delegate);
        assertTrue(_executeUserOp(msca, _executeCalldata(target, 0, data), quorum), "revoke userOp");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(msca), delegate));
    }

    function test_approveThenDepositInOneBatchUserOp_thenWithdrawBackToTheMsca() public {
        uint256 amount = 2_500e6;
        Call[] memory calls = new Call[](2);
        (calls[0].target, calls[0].data) = helper.encodeApproveGateway(address(usdc), amount);
        (calls[1].target, calls[1].data) = helper.encodeDeposit(address(usdc), amount);
        assertTrue(_executeUserOp(msca, abi.encodeCall(IStandardExecutor.executeBatch, (calls)), quorum));
        assertEq(helper.getTotalBalance(address(usdc), address(msca)), amount, "credited to the MSCA");
        assertEq(usdc.balanceOf(address(msca)), 10_000e6 - amount);

        (address target, bytes memory data) = helper.encodeInitiateWithdrawal(address(usdc), amount);
        assertTrue(_executeUserOp(msca, _executeCalldata(target, 0, data), quorum), "initiate");
        vm.roll(block.number + WITHDRAWAL_DELAY_BLOCKS);
        (target, data) = helper.encodeCompleteWithdrawal(address(usdc));
        assertTrue(_executeUserOp(msca, _executeCalldata(target, 0, data), quorum), "complete");
        assertEq(usdc.balanceOf(address(msca)), 10_000e6, "USDC back on the MSCA");
        assertEq(helper.getTotalBalance(address(usdc), address(msca)), 0);
    }

    /// With the address book installed, `approve(gateway, …)` passes only when Gateway is allowlisted, but
    /// every Gateway-targeted call (`addDelegate`, `deposit`, `initiateWithdrawal`, `withdraw`) is rejected at
    /// validation: the address book cannot decode a recipient from those selectors and fails closed. An
    /// AddressBook-gated treasury therefore cannot use Gateway through `execute` at all.
    function test_addressBook_failsClosedOnEveryGatewayTargetedCall() public {
        address[] memory allowlist = new address[](1);
        allowlist[0] = address(gateway);
        assertTrue(_installAddressBook(msca, allowlist, quorum));

        (address target, bytes memory data) = helper.encodeApproveGateway(address(usdc), 1e6);
        assertTrue(_executeUserOp(msca, _executeCalldata(target, 0, data), quorum), "approve: spender allowlisted");
        assertEq(usdc.allowance(address(msca), address(gateway)), 1e6);

        (target, data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        _expectValidationRevert(msca, _executeCalldata(target, 0, data), quorum);
        (target, data) = helper.encodeDeposit(address(usdc), 1e6);
        _expectValidationRevert(msca, _executeCalldata(target, 0, data), quorum);
        (target, data) = helper.encodeInitiateWithdrawal(address(usdc), 1e6);
        _expectValidationRevert(msca, _executeCalldata(target, 0, data), quorum);
        (target, data) = helper.encodeCompleteWithdrawal(address(usdc));
        _expectValidationRevert(msca, _executeCalldata(target, 0, data), quorum);

        Call[] memory calls = new Call[](2);
        (calls[0].target, calls[0].data) = helper.encodeApproveGateway(address(usdc), 1e6);
        (calls[1].target, calls[1].data) = helper.encodeDeposit(address(usdc), 1e6);
        _expectValidationRevert(msca, abi.encodeCall(IStandardExecutor.executeBatch, (calls)), quorum);

        assertEq(helper.getTotalBalance(address(usdc), address(msca)), 0, "nothing reached Gateway");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(msca), delegate));
    }
}
