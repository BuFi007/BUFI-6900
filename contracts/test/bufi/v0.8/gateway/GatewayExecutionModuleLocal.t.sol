// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MockGatewayWallet} from "../../../mocks/MockGatewayWallet.sol";

import {GatewayExecutionModule} from "../../../../src/bufi/v0.8/gateway/GatewayExecutionModule.sol";
import {IGatewayExecutionModule} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayExecutionModule.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {
    ExecutionManifest,
    IERC6900ExecutionModule
} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900ExecutionModule.sol";
import {IERC6900Module} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900Module.sol";
import {IModule as CircleV08IModule} from "@erc6900/reference-implementation/interfaces/IModule.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Test} from "forge-std/src/Test.sol";

/// @notice `GatewayExecutionModule` against a local `MockGatewayWallet` — the behavioural assertions of the
///         Sepolia fork suite (`test/fork/gateway/GatewayExecutionModule.t.sol`) with no `--fork-url`, plus the
///         deposit/withdrawal paths the fork suite skipped for lack of testnet USDC. The headline is the same
///         on both: everything the module does at Gateway is attributed to the MODULE, never to the account.
contract GatewayExecutionModuleLocalTest is Test {
    uint256 internal constant WITHDRAWAL_DELAY_BLOCKS = 100;

    MockGatewayWallet internal gateway;
    SandboxUSDC internal usdc;
    GatewayExecutionModule internal module;

    address internal msca = makeAddr("msca");
    address internal delegate = makeAddr("delegate");

    function setUp() public {
        gateway = new MockGatewayWallet(WITHDRAWAL_DELAY_BLOCKS);
        usdc = new SandboxUSDC();
        gateway.setSupportedToken(address(usdc), true);
        module = new GatewayExecutionModule(address(gateway));
        vm.label(address(gateway), "MockGatewayWallet");
        vm.label(address(module), "GatewayExecutionModule");
        vm.deal(msca, 10 ether);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Construction, identity, manifest                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_constructor_storesTheGatewayWallet() public view {
        assertEq(module.gatewayWallet(), address(gateway));
    }

    function test_constructor_rejectsAZeroGatewayWallet() public {
        vm.expectRevert("Invalid gateway wallet");
        new GatewayExecutionModule(address(0));
    }

    function test_moduleId_isVendorModuleSemver() public view {
        assertEq(module.moduleId(), "desk.gateway-execution-module.1.0.0");
        assertEq(module.MODULE_ID(), module.moduleId());
    }

    /// What a v0.8 account checks at install: Circle's `BaseMSCA._installExecution` verifies `IModule`
    /// (only when install data is non-empty); the ERC-6900 v0.8.1 reference account verifies nothing. Neither
    /// asks for `IERC6900ExecutionModule`, which the module does NOT advertise — recorded here so nobody adds an
    /// install-time check that would reject it.
    function test_erc165_advertisesIModuleAndIGatewayExecutionModule_butNotIERC6900ExecutionModule() public view {
        bytes4 moduleIface = type(IERC6900Module).interfaceId;
        assertEq(moduleIface, type(CircleV08IModule).interfaceId, "reference IERC6900Module == Circle v0.8 IModule");

        assertTrue(module.supportsInterface(type(IERC165).interfaceId));
        assertTrue(module.supportsInterface(moduleIface), "IModule: what Circle's v0.8 account checks on install");
        assertTrue(module.supportsInterface(type(IGatewayExecutionModule).interfaceId));
        assertFalse(module.supportsInterface(type(IERC6900ExecutionModule).interfaceId), "not advertised");
        assertFalse(module.supportsInterface(0xffffffff));
    }

    function test_executionManifest_declaresTheFiveGatewayFunctionsAndTheModuleInterface() public view {
        ExecutionManifest memory m = module.executionManifest();

        assertEq(m.executionFunctions.length, 5);
        assertEq(m.executionFunctions[0].executionSelector, IGatewayExecutionModule.authorizeDelegate.selector);
        assertEq(m.executionFunctions[1].executionSelector, IGatewayExecutionModule.revokeDelegate.selector);
        assertEq(m.executionFunctions[2].executionSelector, IGatewayExecutionModule.depositToGateway.selector);
        assertEq(m.executionFunctions[3].executionSelector, IGatewayExecutionModule.initiateWithdrawal.selector);
        assertEq(m.executionFunctions[4].executionSelector, IGatewayExecutionModule.completeWithdrawal.selector);
        for (uint256 i = 0; i < 5; i++) {
            assertFalse(m.executionFunctions[i].skipRuntimeValidation, "every function is validated");
        }
        assertFalse(m.executionFunctions[0].allowGlobalValidation, "authorizeDelegate: dedicated validation");
        assertTrue(m.executionFunctions[1].allowGlobalValidation, "revokeDelegate: global validation ok");
        assertFalse(m.executionFunctions[2].allowGlobalValidation, "depositToGateway: dedicated validation");
        assertFalse(m.executionFunctions[3].allowGlobalValidation, "initiateWithdrawal: dedicated validation");
        assertTrue(m.executionFunctions[4].allowGlobalValidation, "completeWithdrawal: global validation ok");

        assertEq(m.executionHooks.length, 0, "no execution hooks");
        assertEq(m.interfaceIds.length, 1);
        assertEq(m.interfaceIds[0], type(IGatewayExecutionModule).interfaceId);
    }

    function test_onInstallAndOnUninstall_areNoOps_andUninstallDoesNotRevokeDelegates() public {
        vm.prank(msca);
        module.onInstall(hex"deadbeef");

        vm.prank(msca);
        module.authorizeDelegate(address(usdc), delegate);
        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));

        vm.prank(msca);
        module.onUninstall("");
        assertTrue(
            module.isDelegateAuthorized(address(usdc), address(module), delegate),
            "delegation survives uninstall, as the module's own warning says"
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Delegation through the module                                                  ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// Fork `test_AuthorizeDelegate`: Gateway keys the delegation by `msg.sender`, which is the module.
    function test_authorizeDelegate_isAttributedToTheModule_notTheCallingAccount() public {
        vm.expectEmit(true, true, true, true, address(module));
        emit IGatewayExecutionModule.DelegateAuthorized(msca, address(usdc), delegate);
        vm.prank(msca);
        module.authorizeDelegate(address(usdc), delegate);

        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate), "keyed to the module");
        assertFalse(module.isDelegateAuthorized(address(usdc), msca, delegate), "the account got nothing");
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), msca, delegate));
    }

    function test_revokeDelegate_clearsTheModulesDelegation() public {
        vm.startPrank(msca);
        module.authorizeDelegate(address(usdc), delegate);
        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));

        vm.expectEmit(true, true, true, true, address(module));
        emit IGatewayExecutionModule.DelegateRevoked(msca, address(usdc), delegate);
        module.revokeDelegate(address(usdc), delegate);
        vm.stopPrank();

        assertFalse(module.isDelegateAuthorized(address(usdc), address(module), delegate));
    }

    function test_delegationLifecycle_throughTheModule_authorizeRevokeReauthorize() public {
        vm.startPrank(msca);
        assertFalse(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        module.authorizeDelegate(address(usdc), delegate);
        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        module.revokeDelegate(address(usdc), delegate);
        assertFalse(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        module.authorizeDelegate(address(usdc), delegate);
        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        vm.stopPrank();
    }

    function test_delegatesAreTokenScoped_throughTheModule() public {
        SandboxUSDC eurc = new SandboxUSDC();
        gateway.setSupportedToken(address(eurc), true);

        vm.prank(msca);
        module.authorizeDelegate(address(usdc), delegate);

        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        assertFalse(module.isDelegateAuthorized(address(eurc), address(module), delegate), "USDC only");
    }

    function test_twoAccountsSharingOneModule_shareOneDelegateSet() public {
        address otherMsca = makeAddr("other-msca");
        vm.prank(msca);
        module.authorizeDelegate(address(usdc), delegate);

        // The other account never authorized anyone, yet "its" delegate check through the module says yes.
        assertTrue(
            module.isDelegateAuthorized(address(usdc), address(module), delegate),
            "one module address means one Gateway depositor for every installing account"
        );
        vm.prank(otherMsca);
        module.revokeDelegate(address(usdc), delegate);
        assertFalse(
            module.isDelegateAuthorized(address(usdc), address(module), delegate),
            "...and any of them can revoke what another authorized"
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Input validation                                                               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_authorizeDelegate_rejectsZeroDelegateAndZeroToken() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidDelegate.selector);
        module.authorizeDelegate(address(usdc), address(0));
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.authorizeDelegate(address(0), delegate);
        vm.stopPrank();
    }

    function test_revokeDelegate_rejectsZeroDelegateAndZeroToken() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidDelegate.selector);
        module.revokeDelegate(address(usdc), address(0));
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.revokeDelegate(address(0), delegate);
        vm.stopPrank();
    }

    function test_depositAndWithdrawal_rejectZeroAmountAndZeroToken() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidAmount.selector);
        module.depositToGateway(address(usdc), 0);
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.depositToGateway(address(0), 1e6);
        vm.expectRevert(IGatewayExecutionModule.InvalidAmount.selector);
        module.initiateWithdrawal(address(usdc), 0);
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.initiateWithdrawal(address(0), 1e6);
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.completeWithdrawal(address(0));
        vm.stopPrank();
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Balances, deposits, withdrawals                                                ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_views_readGatewayBalancesForAnyAccount() public {
        assertEq(module.getAvailableBalance(address(usdc), msca), 0, "new account: 0 available");
        assertEq(module.getTotalBalance(address(usdc), msca), 0, "new account: 0 total");

        address funder = makeAddr("funder");
        usdc.mint(funder, 7e6);
        vm.startPrank(funder);
        usdc.approve(address(gateway), 7e6);
        gateway.depositFor(address(usdc), msca, 7e6);
        vm.stopPrank();

        assertEq(module.getAvailableBalance(address(usdc), msca), 7e6, "views are sender-independent");
        assertEq(module.getTotalBalance(address(usdc), msca), 7e6);
    }

    /// The fork suite skipped this for lack of USDC; it would have failed. `depositToGateway` approves and
    /// deposits FROM THE MODULE'S balance: an account that holds the USDC and approved Gateway itself gets a
    /// revert, and a module that does hold USDC deposits it under the module's name.
    function test_depositToGateway_pullsFromTheModule_notTheCallingAccount() public {
        uint256 amount = 1_000e6;
        usdc.mint(msca, amount);
        vm.startPrank(msca);
        usdc.approve(address(gateway), amount);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(module), 0, amount)
        );
        module.depositToGateway(address(usdc), amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(msca), amount, "the account's USDC never moved");
        assertEq(module.getTotalBalance(address(usdc), msca), 0);

        usdc.mint(address(module), amount);
        vm.expectEmit(true, true, false, true, address(module));
        emit IGatewayExecutionModule.DepositedToGateway(msca, address(usdc), amount);
        vm.prank(msca);
        module.depositToGateway(address(usdc), amount);

        assertEq(module.getTotalBalance(address(usdc), address(module)), amount, "credited to the module");
        assertEq(module.getTotalBalance(address(usdc), msca), 0, "the event names the account; Gateway does not");
        assertEq(usdc.balanceOf(address(gateway)), amount);
    }

    function test_withdrawal_throughTheModule_actsOnTheModulesBalanceAndPaysTheModule() public {
        uint256 amount = 500e6;
        usdc.mint(address(module), amount);
        vm.startPrank(msca);
        module.depositToGateway(address(usdc), amount);

        vm.expectEmit(true, true, false, true, address(module));
        emit IGatewayExecutionModule.WithdrawalInitiated(msca, address(usdc), amount);
        module.initiateWithdrawal(address(usdc), amount);
        assertEq(gateway.availableBalance(address(usdc), address(module)), 0);
        assertEq(gateway.withdrawingBalance(address(usdc), address(module)), amount);
        assertEq(module.getTotalBalance(address(usdc), address(module)), amount, "total = available + withdrawing");

        uint256 readyAt = block.number + WITHDRAWAL_DELAY_BLOCKS;
        vm.expectRevert(
            abi.encodeWithSelector(MockGatewayWallet.WithdrawalDelayNotElapsed.selector, readyAt, block.number)
        );
        module.completeWithdrawal(address(usdc));

        vm.roll(readyAt);
        // The event reads `withdrawableBalance(token, msg.sender)` — the CALLER's Gateway balance, which is
        // zero — while `withdraw` pays out the MODULE's. It therefore reports 0 for a withdrawal that moved
        // `amount`.
        vm.expectEmit(true, true, false, true, address(module));
        emit IGatewayExecutionModule.WithdrawalCompleted(msca, address(usdc), 0);
        module.completeWithdrawal(address(usdc));
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(module)), amount, "Gateway paid msg.sender: the module");
        assertEq(usdc.balanceOf(msca), 0, "the account that signed the withdrawal received nothing");
        assertEq(module.getTotalBalance(address(usdc), address(module)), 0);
    }

    function test_completeWithdrawal_withNothingPending_revertsFromGateway() public {
        vm.prank(msca);
        vm.expectRevert(
            abi.encodeWithSelector(MockGatewayWallet.NoWithdrawalPending.selector, address(usdc), address(module))
        );
        module.completeWithdrawal(address(usdc));
    }
}
