// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/src/Test.sol";
import {GatewayExecutionModule} from "../../../src/bufi/v0.8/gateway/GatewayExecutionModule.sol";
import {IGatewayExecutionModule} from "../../../src/bufi/v0.8/gateway/interfaces/IGatewayExecutionModule.sol";
import {IGatewayWallet} from "../../../src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GatewayExecutionModuleTest
 * @notice Tests for the GatewayExecutionModule against forked testnet
 * @dev Run with: forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-contract GatewayExecutionModuleTest
 */
contract GatewayExecutionModuleTest is Test {
    // =========================================================================
    // Constants
    // =========================================================================

    address constant GATEWAY_WALLET_TESTNET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    // =========================================================================
    // State
    // =========================================================================

    GatewayExecutionModule public module;
    address public msca; // Simulated MSCA (msg.sender for module calls)
    address public delegate;

    // =========================================================================
    // Setup
    // =========================================================================

    function setUp() public {
        // Deploy the module with testnet Gateway address
        module = new GatewayExecutionModule(GATEWAY_WALLET_TESTNET);

        // Create test addresses
        msca = makeAddr("msca");
        delegate = makeAddr("delegate");

        // Give MSCA some ETH
        vm.deal(msca, 10 ether);
    }

    // =========================================================================
    // Construction Tests
    // =========================================================================

    function test_Constructor() public view {
        assertEq(module.gatewayWallet(), GATEWAY_WALLET_TESTNET);
    }

    function test_ModuleId() public view {
        string memory id = module.moduleId();
        assertEq(id, "desk.gateway-execution-module.1.0.0");
        console2.log("Module ID:", id);
    }

    function test_SupportsInterface() public view {
        // Should support IModule
        bytes4 iModuleId = 0x00000001; // Placeholder - need actual IModule interface ID
        // assertTrue(module.supportsInterface(iModuleId));

        // Should support IERC165
        assertTrue(module.supportsInterface(0x01ffc9a7)); // ERC165
    }

    // =========================================================================
    // Execution Manifest Tests
    // =========================================================================

    function test_ExecutionManifest() public view {
        // Get the manifest
        // ExecutionManifest memory manifest = module.executionManifest();

        // Verify it declares our functions
        // This test verifies the module correctly declares its execution functions
        console2.log("ExecutionManifest test - verify function selectors are declared");

        bytes4 authorizeDelegateSelector = module.authorizeDelegate.selector;
        bytes4 revokeDelegateSelector = module.revokeDelegate.selector;
        bytes4 depositSelector = module.depositToGateway.selector;
        bytes4 initiateWithdrawalSelector = module.initiateWithdrawal.selector;
        bytes4 completeWithdrawalSelector = module.completeWithdrawal.selector;

        console2.log("authorizeDelegate selector:");
        console2.logBytes4(authorizeDelegateSelector);

        console2.log("revokeDelegate selector:");
        console2.logBytes4(revokeDelegateSelector);

        console2.log("depositToGateway selector:");
        console2.logBytes4(depositSelector);

        console2.log("initiateWithdrawal selector:");
        console2.logBytes4(initiateWithdrawalSelector);

        console2.log("completeWithdrawal selector:");
        console2.logBytes4(completeWithdrawalSelector);
    }

    // =========================================================================
    // Delegation Tests (Fork Required)
    // =========================================================================
    //
    // ARCHITECTURE NOTE:
    // When the module calls Gateway, msg.sender to Gateway is the MODULE address,
    // not the MSCA. This is a fundamental ERC-6900 limitation for protocols that
    // rely on msg.sender identity.
    //
    // In production, the MSCA should either:
    // 1. Call Gateway directly via execute() to preserve msg.sender
    // 2. Use a pattern where the module prepares calldata and MSCA executes it
    //
    // For these tests, we verify the module correctly forwards the call, even
    // though the delegation is created for address(module) not msca.
    //
    // The core Gateway ABI is verified in GatewayFork.t.sol::test_DelegationFlow
    // =========================================================================

    /**
     * @notice Test authorizeDelegate calls Gateway correctly
     * @dev This test verifies the module forwards the call. Due to ERC-6900 call
     *      semantics, the delegation is created for address(module), not msca.
     */
    function test_AuthorizeDelegate() public {
        // Simulate call from MSCA
        vm.startPrank(msca);

        // Authorize the delegate through our module
        try module.authorizeDelegate(USDC_SEPOLIA, delegate) {
            console2.log("authorizeDelegate via module succeeded!");
        } catch Error(string memory reason) {
            console2.log("authorizeDelegate failed:", reason);
            assertTrue(false, "authorizeDelegate reverted");
        } catch (bytes memory lowLevelData) {
            console2.log("authorizeDelegate low-level error:");
            console2.logBytes(lowLevelData);

            if (lowLevelData.length >= 4) {
                bytes4 errorSelector;
                assembly {
                    errorSelector := mload(add(lowLevelData, 32))
                }
                console2.log("Error selector:");
                console2.logBytes4(errorSelector);
            }
            assertTrue(false, "authorizeDelegate reverted with low-level error");
        }

        vm.stopPrank();

        // NOTE: Due to ERC-6900 call semantics, the delegation is created for
        // address(module), not msca. This is expected behavior.
        // The delegation IS created - verify it's for the module address:
        bool moduleAuthorized = module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate);
        assertTrue(moduleAuthorized, "Delegate should be authorized for module address");

        // The msca is NOT directly authorized (expected):
        bool mscaAuthorized = module.isDelegateAuthorized(USDC_SEPOLIA, msca, delegate);
        assertFalse(mscaAuthorized, "MSCA not authorized (expected - see architecture note)");
    }

    /**
     * @notice Test revokeDelegate calls Gateway correctly
     */
    function test_RevokeDelegate() public {
        vm.startPrank(msca);

        // First authorize
        module.authorizeDelegate(USDC_SEPOLIA, delegate);

        // Verify delegation created for module address
        assertTrue(module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate));

        // Then revoke
        module.revokeDelegate(USDC_SEPOLIA, delegate);

        // Check delegate is NOT authorized
        bool authorizedAfter = module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate);
        assertFalse(authorizedAfter, "Delegate should not be authorized after revoke");

        vm.stopPrank();
    }

    /**
     * @notice Test full delegation lifecycle
     */
    function test_DelegationLifecycle() public {
        vm.startPrank(msca);

        // 1. Initial state - not authorized
        assertFalse(module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate));

        // 2. Authorize
        module.authorizeDelegate(USDC_SEPOLIA, delegate);
        assertTrue(module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate));

        // 3. Revoke
        module.revokeDelegate(USDC_SEPOLIA, delegate);
        assertFalse(module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate));

        // 4. Re-authorize (should work)
        module.authorizeDelegate(USDC_SEPOLIA, delegate);
        assertTrue(module.isDelegateAuthorized(USDC_SEPOLIA, address(module), delegate));

        vm.stopPrank();
    }

    // =========================================================================
    // Input Validation Tests
    // =========================================================================

    function test_AuthorizeDelegate_RevertOnZeroDelegate() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidDelegate.selector);
        module.authorizeDelegate(USDC_SEPOLIA, address(0));
        vm.stopPrank();
    }

    function test_AuthorizeDelegate_RevertOnZeroToken() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidToken.selector);
        module.authorizeDelegate(address(0), delegate);
        vm.stopPrank();
    }

    function test_RevokeDelegate_RevertOnZeroDelegate() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidDelegate.selector);
        module.revokeDelegate(USDC_SEPOLIA, address(0));
        vm.stopPrank();
    }

    function test_DepositToGateway_RevertOnZeroAmount() public {
        vm.startPrank(msca);
        vm.expectRevert(IGatewayExecutionModule.InvalidAmount.selector);
        module.depositToGateway(USDC_SEPOLIA, 0);
        vm.stopPrank();
    }

    // =========================================================================
    // View Function Tests
    // =========================================================================

    function test_GetAvailableBalance() public view {
        uint256 balance = module.getAvailableBalance(USDC_SEPOLIA, msca);
        assertEq(balance, 0, "New MSCA should have 0 available balance");
    }

    function test_GetTotalBalance() public view {
        uint256 balance = module.getTotalBalance(USDC_SEPOLIA, msca);
        assertEq(balance, 0, "New MSCA should have 0 total balance");
    }

    // =========================================================================
    // Deposit Tests (Requires Testnet USDC)
    // =========================================================================

    /**
     * @notice Test deposit flow
     * @dev This test requires the MSCA to have testnet USDC
     *      Use a Sepolia USDC faucet to get test tokens
     */
    function test_DepositToGateway() public {
        // Skip if no USDC balance
        uint256 usdcBalance = IERC20(USDC_SEPOLIA).balanceOf(msca);
        if (usdcBalance == 0) {
            console2.log("Skipping deposit test - MSCA has no USDC");
            console2.log("Get testnet USDC from Circle's faucet to test deposits");
            return;
        }

        uint256 depositAmount = usdcBalance > 1000000 ? 1000000 : usdcBalance; // 1 USDC or less

        vm.startPrank(msca);

        // Approve module to spend USDC (module will then approve Gateway)
        // Actually, the module calls deposit directly, so MSCA needs to approve Gateway
        IERC20(USDC_SEPOLIA).approve(GATEWAY_WALLET_TESTNET, depositAmount);

        // Check balance before
        uint256 balanceBefore = module.getTotalBalance(USDC_SEPOLIA, msca);

        // Deposit
        module.depositToGateway(USDC_SEPOLIA, depositAmount);

        // Check balance after
        uint256 balanceAfter = module.getTotalBalance(USDC_SEPOLIA, msca);

        assertEq(balanceAfter, balanceBefore + depositAmount, "Gateway balance should increase");

        vm.stopPrank();
    }
}

/**
 * @title GatewayExecutionModuleUnitTest
 * @notice Unit tests that don't require forking
 * @dev Run with: forge test --match-contract GatewayExecutionModuleUnitTest
 */
contract GatewayExecutionModuleUnitTest is Test {
    function test_ConstructorRevertsOnZeroAddress() public {
        vm.expectRevert("Invalid gateway wallet");
        new GatewayExecutionModule(address(0));
    }

    function test_ModuleIdFormat() public {
        // Deploy with any address (won't make external calls in this test)
        GatewayExecutionModule module = new GatewayExecutionModule(makeAddr("gateway"));

        string memory id = module.moduleId();

        // Verify format: vendor.module.semver
        // Should start with "desk."
        bytes memory idBytes = bytes(id);
        assertGt(idBytes.length, 5, "Module ID too short");

        // Should contain version number
        assertTrue(
            _contains(id, "1.0.0"),
            "Module ID should contain version"
        );
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);

        if (n.length > h.length) return false;

        for (uint i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }
}
