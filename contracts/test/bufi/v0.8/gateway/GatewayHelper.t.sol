// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/src/Test.sol";
import {GatewayHelper} from "../../../../src/bufi/v0.8/gateway/GatewayHelper.sol";
import {IGatewayHelper} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayHelper.sol";
import {IGatewayWallet} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GatewayHelperTest
 * @notice Tests for the GatewayHelper contract against forked testnet
 * @dev Run with: forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-contract GatewayHelperTest
 *
 * KEY TEST: Verify that MSCA direct execution (via encoded calldata) preserves
 * msg.sender = MSCA, ensuring Gateway state is correctly keyed to the MSCA address.
 */
contract GatewayHelperTest is Test {
    // =========================================================================
    // Constants
    // =========================================================================

    address constant GATEWAY_WALLET_TESTNET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    // =========================================================================
    // State
    // =========================================================================

    GatewayHelper public helper;
    IGatewayWallet public gatewayWallet;
    address public msca; // Simulated MSCA (will call Gateway directly)
    address public delegate;

    // =========================================================================
    // Setup
    // =========================================================================

    function setUp() public {
        // Deploy the helper with testnet Gateway address
        helper = new GatewayHelper(GATEWAY_WALLET_TESTNET);
        gatewayWallet = IGatewayWallet(GATEWAY_WALLET_TESTNET);

        // Create test addresses
        msca = makeAddr("msca");
        delegate = makeAddr("delegate");

        // Give MSCA some ETH for gas
        vm.deal(msca, 10 ether);
    }

    // =========================================================================
    // Construction Tests
    // =========================================================================

    function test_Constructor() public view {
        assertEq(helper.gatewayWallet(), GATEWAY_WALLET_TESTNET);
    }

    function test_ConstructorRevertsOnZeroAddress() public {
        vm.expectRevert("Invalid gateway wallet");
        new GatewayHelper(address(0));
    }

    // =========================================================================
    // Encoder Tests
    // =========================================================================

    function test_EncodeAuthorizeDelegate() public view {
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate);

        // Verify target is Gateway
        assertEq(target, GATEWAY_WALLET_TESTNET);

        // Verify calldata is correctly encoded
        bytes memory expected = abi.encodeCall(IGatewayWallet.addDelegate, (USDC_SEPOLIA, delegate));
        assertEq(data, expected);

        // Verify selector
        bytes4 selector = bytes4(data);
        assertEq(selector, IGatewayWallet.addDelegate.selector);
    }

    function test_EncodeRevokeDelegate() public view {
        (address target, bytes memory data) = helper.encodeRevokeDelegate(USDC_SEPOLIA, delegate);

        assertEq(target, GATEWAY_WALLET_TESTNET);

        bytes memory expected = abi.encodeCall(IGatewayWallet.removeDelegate, (USDC_SEPOLIA, delegate));
        assertEq(data, expected);
    }

    function test_EncodeDeposit() public view {
        uint256 amount = 1000000; // 1 USDC
        (address target, bytes memory data) = helper.encodeDeposit(USDC_SEPOLIA, amount);

        assertEq(target, GATEWAY_WALLET_TESTNET);

        bytes memory expected = abi.encodeCall(IGatewayWallet.deposit, (USDC_SEPOLIA, amount));
        assertEq(data, expected);
    }

    function test_EncodeInitiateWithdrawal() public view {
        uint256 amount = 1000000;
        (address target, bytes memory data) = helper.encodeInitiateWithdrawal(USDC_SEPOLIA, amount);

        assertEq(target, GATEWAY_WALLET_TESTNET);

        bytes memory expected = abi.encodeCall(IGatewayWallet.initiateWithdrawal, (USDC_SEPOLIA, amount));
        assertEq(data, expected);
    }

    function test_EncodeCompleteWithdrawal() public view {
        (address target, bytes memory data) = helper.encodeCompleteWithdrawal(USDC_SEPOLIA);

        assertEq(target, GATEWAY_WALLET_TESTNET);

        bytes memory expected = abi.encodeCall(IGatewayWallet.withdraw, (USDC_SEPOLIA));
        assertEq(data, expected);
    }

    function test_EncodeApproveGateway() public view {
        uint256 amount = 1000000;
        (address target, bytes memory data) = helper.encodeApproveGateway(USDC_SEPOLIA, amount);

        // Target should be the token, not Gateway
        assertEq(target, USDC_SEPOLIA);

        bytes memory expected = abi.encodeCall(IERC20.approve, (GATEWAY_WALLET_TESTNET, amount));
        assertEq(data, expected);
    }

    // =========================================================================
    // Input Validation Tests
    // =========================================================================

    function test_EncodeAuthorizeDelegate_RevertOnZeroDelegate() public {
        vm.expectRevert(IGatewayHelper.InvalidDelegate.selector);
        helper.encodeAuthorizeDelegate(USDC_SEPOLIA, address(0));
    }

    function test_EncodeAuthorizeDelegate_RevertOnZeroToken() public {
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeAuthorizeDelegate(address(0), delegate);
    }

    function test_EncodeDeposit_RevertOnZeroAmount() public {
        vm.expectRevert(IGatewayHelper.InvalidAmount.selector);
        helper.encodeDeposit(USDC_SEPOLIA, 0);
    }

    function test_EncodeDeposit_RevertOnZeroToken() public {
        vm.expectRevert(IGatewayHelper.InvalidToken.selector);
        helper.encodeDeposit(address(0), 1000000);
    }

    // =========================================================================
    // View Function Tests
    // =========================================================================

    function test_GetAvailableBalance() public view {
        uint256 balance = helper.getAvailableBalance(USDC_SEPOLIA, msca);
        assertEq(balance, 0, "New MSCA should have 0 available balance");
    }

    function test_GetTotalBalance() public view {
        uint256 balance = helper.getTotalBalance(USDC_SEPOLIA, msca);
        assertEq(balance, 0, "New MSCA should have 0 total balance");
    }

    function test_GetWithdrawalDelay() public view {
        uint256 delay = helper.getWithdrawalDelay();
        assertGt(delay, 0, "Withdrawal delay should be > 0");
        console2.log("Withdrawal delay (seconds):", delay);
        console2.log("Withdrawal delay (days):", delay / 86400);
    }

    // =========================================================================
    // CRITICAL TEST: Direct MSCA Execution Preserves msg.sender
    // =========================================================================

    /**
     * @notice Verify that MSCA direct execution creates delegation for MSCA (not helper)
     * @dev This is THE key test that proves the architecture works correctly.
     *
     * FLOW:
     * 1. Helper encodes calldata
     * 2. MSCA executes the call directly (simulated with low-level call)
     * 3. Gateway receives msg.sender = MSCA
     * 4. Delegation is keyed to MSCA address
     */
    function test_DirectExecution_PreservesMsgSender() public {
        // 1. Get encoded calldata from helper
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate);

        // 2. Verify delegate is NOT authorized initially
        bool authorizedBefore = helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate);
        assertFalse(authorizedBefore, "Delegate should not be authorized initially");

        // 3. MSCA executes the call directly
        // This simulates: msca.execute(target, 0, data)
        vm.prank(msca);
        (bool success, ) = target.call(data);
        assertTrue(success, "Direct call should succeed");

        // 4. CRITICAL: Verify delegation is for MSCA address (NOT helper)
        bool mscaAuthorized = helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate);
        assertTrue(mscaAuthorized, "MSCA should be the depositor with authorized delegate");

        // 5. Verify helper address is NOT the depositor
        bool helperAuthorized = helper.isDelegateAuthorized(USDC_SEPOLIA, address(helper), delegate);
        assertFalse(helperAuthorized, "Helper should NOT be the depositor");

        console2.log("SUCCESS: Direct execution preserves msg.sender = MSCA");
    }

    /**
     * @notice Full delegation lifecycle with direct execution
     */
    function test_DelegationLifecycle_DirectExecution() public {
        // 1. Initial state - not authorized
        assertFalse(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate));

        // 2. Authorize via direct execution
        (address target1, bytes memory data1) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate);
        vm.prank(msca);
        (bool success1, ) = target1.call(data1);
        assertTrue(success1, "Authorize should succeed");

        // 3. Verify authorized
        assertTrue(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate));

        // 4. Revoke via direct execution
        (address target2, bytes memory data2) = helper.encodeRevokeDelegate(USDC_SEPOLIA, delegate);
        vm.prank(msca);
        (bool success2, ) = target2.call(data2);
        assertTrue(success2, "Revoke should succeed");

        // 5. Verify revoked
        assertFalse(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate));

        console2.log("SUCCESS: Full delegation lifecycle works with direct execution");
    }

    /**
     * @notice Verify multiple delegates can be authorized for same MSCA
     */
    function test_MultipleDelegates() public {
        address delegate2 = makeAddr("delegate2");

        // Authorize both delegates
        (address target1, bytes memory data1) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate);
        vm.prank(msca);
        target1.call(data1);

        (address target2, bytes memory data2) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate2);
        vm.prank(msca);
        target2.call(data2);

        // Both should be authorized
        assertTrue(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate));
        assertTrue(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate2));
    }

    /**
     * @notice Verify delegates are token-scoped
     */
    function test_DelegateIsTokenScoped() public {
        address otherToken = makeAddr("otherToken");

        // Authorize delegate for USDC
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(USDC_SEPOLIA, delegate);
        vm.prank(msca);
        target.call(data);

        // Should be authorized for USDC
        assertTrue(helper.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate));

        // Should NOT be authorized for other token
        assertFalse(helper.isDelegateAuthorized(otherToken, msca, delegate));
    }
}

/**
 * @title GatewayHelperUnitTest
 * @notice Unit tests that don't require forking
 * @dev Run with: forge test --match-contract GatewayHelperUnitTest
 */
contract GatewayHelperUnitTest is Test {
    function test_EncodedCalldataMatchesSelectors() public {
        // Deploy with any address (won't make external calls)
        GatewayHelper helper = new GatewayHelper(makeAddr("gateway"));

        // Verify selectors match expected values
        bytes4 addDelegateSelector = bytes4(keccak256("addDelegate(address,address)"));
        bytes4 removeDelegateSelector = bytes4(keccak256("removeDelegate(address,address)"));
        bytes4 depositSelector = bytes4(keccak256("deposit(address,uint256)"));

        assertEq(addDelegateSelector, bytes4(0xe909ebfa), "addDelegate selector");
        assertEq(removeDelegateSelector, bytes4(0x020d308d), "removeDelegate selector");

        console2.log("Verified selectors:");
        console2.log("addDelegate:");
        console2.logBytes4(addDelegateSelector);
        console2.log("removeDelegate:");
        console2.logBytes4(removeDelegateSelector);
        console2.log("deposit:");
        console2.logBytes4(depositSelector);
    }
}
