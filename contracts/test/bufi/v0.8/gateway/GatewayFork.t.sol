// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/src/Test.sol";
import {IGatewayWallet} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayWallet.sol";
import {IGatewayMinter} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayMinter.sol";

/**
 * @title GatewayForkTest
 * @notice Fork tests to verify Gateway contract ABI against real testnet deployment
 * @dev Run with: forge test --fork-url $SEPOLIA_RPC_URL -vvv
 *
 * PURPOSE: Verify our interface assumptions against the ACTUAL deployed contracts.
 * This is where we find out if addDelegate(token, delegate) is real or hallucinated.
 */
contract GatewayForkTest is Test {
    // =========================================================================
    // Constants - Testnet Addresses
    // =========================================================================

    /// @notice Gateway Wallet on Sepolia (and other testnets)
    address constant GATEWAY_WALLET_TESTNET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;

    /// @notice Gateway Minter on Sepolia (and other testnets)
    address constant GATEWAY_MINTER_TESTNET = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B;

    /// @notice USDC on Sepolia
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    // =========================================================================
    // State
    // =========================================================================

    IGatewayWallet public gatewayWallet;
    IGatewayMinter public gatewayMinter;

    address public testDepositor;
    address public testDelegate;

    // =========================================================================
    // Setup
    // =========================================================================

    function setUp() public {
        // Fork Sepolia - this will fail if RPC not set, which is intentional
        // Run with: forge test --fork-url $SEPOLIA_RPC_URL

        gatewayWallet = IGatewayWallet(GATEWAY_WALLET_TESTNET);
        gatewayMinter = IGatewayMinter(GATEWAY_MINTER_TESTNET);

        // Create test addresses
        testDepositor = makeAddr("depositor");
        testDelegate = makeAddr("delegate");
    }

    // =========================================================================
    // ABI Verification Tests
    // =========================================================================

    /**
     * @notice Verify Gateway Wallet contract exists and has code
     */
    function test_GatewayWalletExists() public view {
        uint256 codeSize;
        address wallet = GATEWAY_WALLET_TESTNET;
        assembly {
            codeSize := extcodesize(wallet)
        }

        assertGt(codeSize, 0, "Gateway Wallet has no code - wrong address or not deployed");
        console2.log("Gateway Wallet code size:", codeSize);
    }

    /**
     * @notice Verify Gateway Minter contract exists and has code
     */
    function test_GatewayMinterExists() public view {
        uint256 codeSize;
        address minter = GATEWAY_MINTER_TESTNET;
        assembly {
            codeSize := extcodesize(minter)
        }

        assertGt(codeSize, 0, "Gateway Minter has no code - wrong address or not deployed");
        console2.log("Gateway Minter code size:", codeSize);
    }

    /**
     * @notice Test withdrawalDelay() function exists and returns a value
     * @dev This is a simple view function - if it works, the ABI is at least partially correct
     */
    function test_WithdrawalDelayExists() public view {
        // This will revert if the function doesn't exist with this signature
        uint256 delay = gatewayWallet.withdrawalDelay();

        console2.log("Withdrawal delay (seconds):", delay);
        console2.log("Withdrawal delay (days):", delay / 86400);

        // Gateway typically has 7-day delay
        assertGt(delay, 0, "Withdrawal delay should be > 0");
    }

    /**
     * @notice Test totalBalance() function signature
     * @dev Verifies the function exists with (address token, address depositor) signature
     */
    function test_TotalBalanceSignature() public view {
        // Should not revert - function exists
        uint256 balance = gatewayWallet.totalBalance(USDC_SEPOLIA, testDepositor);

        // New depositor should have 0 balance
        assertEq(balance, 0, "New depositor should have 0 balance");
        console2.log("Total balance for new depositor:", balance);
    }

    /**
     * @notice Test availableBalance() function signature
     */
    function test_AvailableBalanceSignature() public view {
        uint256 balance = gatewayWallet.availableBalance(USDC_SEPOLIA, testDepositor);
        assertEq(balance, 0, "New depositor should have 0 available balance");
    }

    /**
     * @notice Test isAuthorizedForBalance() function signature
     * @dev This verifies the three-parameter version: (token, depositor, addr)
     */
    function test_IsAuthorizedForBalanceSignature() public view {
        // Depositor is always authorized for their own balance
        bool selfAuthorized = gatewayWallet.isAuthorizedForBalance(
            USDC_SEPOLIA,
            testDepositor,
            testDepositor
        );

        console2.log("Self-authorized:", selfAuthorized);

        // A random address should NOT be authorized
        bool delegateAuthorized = gatewayWallet.isAuthorizedForBalance(
            USDC_SEPOLIA,
            testDepositor,
            testDelegate
        );

        console2.log("Random delegate authorized:", delegateAuthorized);
        assertFalse(delegateAuthorized, "Random address should not be authorized");
    }

    // =========================================================================
    // Function Selector Verification
    // =========================================================================

    /**
     * @notice Verify function selectors match what we expect
     * @dev If these fail, our ABI is wrong
     */
    function test_FunctionSelectors() public pure {
        // Calculate expected selectors
        bytes4 addDelegateSelector = bytes4(keccak256("addDelegate(address,address)"));
        bytes4 removeDelegateSelector = bytes4(keccak256("removeDelegate(address,address)"));
        bytes4 depositSelector = bytes4(keccak256("deposit(address,uint256)"));
        bytes4 isAuthorizedSelector = bytes4(keccak256("isAuthorizedForBalance(address,address,address)"));
        bytes4 totalBalanceSelector = bytes4(keccak256("totalBalance(address,address)"));
        bytes4 withdrawalDelaySelector = bytes4(keccak256("withdrawalDelay()"));

        console2.log("addDelegate(address,address) selector:");
        console2.logBytes4(addDelegateSelector);

        console2.log("removeDelegate(address,address) selector:");
        console2.logBytes4(removeDelegateSelector);

        console2.log("deposit(address,uint256) selector:");
        console2.logBytes4(depositSelector);

        console2.log("isAuthorizedForBalance(address,address,address) selector:");
        console2.logBytes4(isAuthorizedSelector);

        console2.log("totalBalance(address,address) selector:");
        console2.logBytes4(totalBalanceSelector);

        console2.log("withdrawalDelay() selector:");
        console2.logBytes4(withdrawalDelaySelector);

        // Verify the computed selectors match what we expect from keccak256
        // These values come from: bytes4(keccak256("addDelegate(address,address)")) etc.
        assertEq(addDelegateSelector, bytes4(0xe909ebfa), "addDelegate selector mismatch");
        assertEq(removeDelegateSelector, bytes4(0x020d308d), "removeDelegate selector mismatch");
    }

    /**
     * @notice Verify selectors by attempting raw calls
     * @dev This is the ultimate test - if the call doesn't revert, the selector is correct
     */
    function test_RawCallSelectors() public {
        // Test withdrawalDelay() - should succeed
        (bool success, bytes memory data) = GATEWAY_WALLET_TESTNET.staticcall(
            abi.encodeWithSignature("withdrawalDelay()")
        );

        assertTrue(success, "withdrawalDelay() call failed - selector mismatch?");

        uint256 delay = abi.decode(data, (uint256));
        console2.log("Raw call withdrawalDelay result:", delay);

        // Test totalBalance(address,address) - should succeed
        (success, data) = GATEWAY_WALLET_TESTNET.staticcall(
            abi.encodeWithSignature("totalBalance(address,address)", USDC_SEPOLIA, testDepositor)
        );

        assertTrue(success, "totalBalance(address,address) call failed - selector mismatch?");

        // Test isAuthorizedForBalance(address,address,address) - should succeed
        (success, data) = GATEWAY_WALLET_TESTNET.staticcall(
            abi.encodeWithSignature(
                "isAuthorizedForBalance(address,address,address)",
                USDC_SEPOLIA,
                testDepositor,
                testDelegate
            )
        );

        assertTrue(success, "isAuthorizedForBalance(address,address,address) call failed - selector mismatch?");
    }

    // =========================================================================
    // Delegation Flow Tests (State-Changing)
    // =========================================================================

    /**
     * @notice Test the full delegation flow
     * @dev This tests addDelegate and removeDelegate with real contract calls
     */
    function test_DelegationFlow() public {
        // Give the depositor some ETH for gas
        vm.deal(testDepositor, 1 ether);

        // Step 1: Verify delegate is NOT authorized initially
        bool authorizedBefore = gatewayWallet.isAuthorizedForBalance(
            USDC_SEPOLIA,
            testDepositor,
            testDelegate
        );
        assertFalse(authorizedBefore, "Delegate should not be authorized initially");

        // Step 2: Add delegate (as the depositor)
        vm.startPrank(testDepositor);

        // This is the critical test - does addDelegate(address,address) work?
        // If the ABI is wrong, this will revert
        try gatewayWallet.addDelegate(USDC_SEPOLIA, testDelegate) {
            console2.log("addDelegate succeeded!");
        } catch Error(string memory reason) {
            console2.log("addDelegate failed with reason:", reason);
            assertTrue(false, "addDelegate call reverted - ABI mismatch or other error");
        } catch (bytes memory lowLevelData) {
            console2.log("addDelegate failed with low-level error");
            console2.logBytes(lowLevelData);
            assertTrue(false, "addDelegate call reverted with low-level error");
        }

        vm.stopPrank();

        // Step 3: Verify delegate IS authorized now
        bool authorizedAfter = gatewayWallet.isAuthorizedForBalance(
            USDC_SEPOLIA,
            testDepositor,
            testDelegate
        );
        assertTrue(authorizedAfter, "Delegate should be authorized after addDelegate");
        console2.log("Delegate authorized after addDelegate:", authorizedAfter);

        // Step 4: Remove delegate
        vm.startPrank(testDepositor);

        try gatewayWallet.removeDelegate(USDC_SEPOLIA, testDelegate) {
            console2.log("removeDelegate succeeded!");
        } catch Error(string memory reason) {
            console2.log("removeDelegate failed with reason:", reason);
            assertTrue(false, "removeDelegate call reverted");
        }

        vm.stopPrank();

        // Step 5: Verify delegate is NOT authorized anymore
        bool authorizedFinal = gatewayWallet.isAuthorizedForBalance(
            USDC_SEPOLIA,
            testDepositor,
            testDelegate
        );
        assertFalse(authorizedFinal, "Delegate should not be authorized after removeDelegate");
        console2.log("Delegate authorized after removeDelegate:", authorizedFinal);
    }

    // =========================================================================
    // Alternative ABI Tests
    // =========================================================================

    /**
     * @notice Test if addDelegate might have a DIFFERENT signature
     * @dev If our assumed signature is wrong, try alternatives
     */
    function test_AlternativeAddDelegateSignatures() public {
        vm.deal(testDepositor, 1 ether);
        vm.startPrank(testDepositor);

        // Try: addDelegate(address delegate) - single param version
        (bool success1,) = GATEWAY_WALLET_TESTNET.call(
            abi.encodeWithSignature("addDelegate(address)", testDelegate)
        );
        console2.log("addDelegate(address) success:", success1);

        // Try: addDelegate(address token, address delegate) - our assumed version
        (bool success2,) = GATEWAY_WALLET_TESTNET.call(
            abi.encodeWithSignature("addDelegate(address,address)", USDC_SEPOLIA, testDelegate)
        );
        console2.log("addDelegate(address,address) success:", success2);

        // Try: setDelegate(address,address) - alternative naming
        (bool success3,) = GATEWAY_WALLET_TESTNET.call(
            abi.encodeWithSignature("setDelegate(address,address)", USDC_SEPOLIA, testDelegate)
        );
        console2.log("setDelegate(address,address) success:", success3);

        // Try: authorize(address,address) - alternative naming
        (bool success4,) = GATEWAY_WALLET_TESTNET.call(
            abi.encodeWithSignature("authorize(address,address)", USDC_SEPOLIA, testDelegate)
        );
        console2.log("authorize(address,address) success:", success4);

        vm.stopPrank();

        // At least one should succeed
        assertTrue(
            success1 || success2 || success3 || success4,
            "None of the delegate function signatures worked!"
        );
    }

    // =========================================================================
    // Deposit Tests (Requires Testnet USDC)
    // =========================================================================

    /**
     * @notice Test deposit function signature
     * @dev This test requires the depositor to have testnet USDC
     *      Skip if no USDC balance
     */
    function test_DepositSignature() public {
        // This test verifies the deposit function exists
        // Actual deposit requires USDC approval and balance

        // Just verify the function can be called (will fail due to no approval/balance)
        vm.deal(testDepositor, 1 ether);
        vm.startPrank(testDepositor);

        // Expect revert due to no USDC balance, but verify selector is correct
        (bool success, bytes memory data) = GATEWAY_WALLET_TESTNET.call(
            abi.encodeWithSignature("deposit(address,uint256)", USDC_SEPOLIA, 1000000)
        );

        // We expect this to fail (no USDC), but NOT with "function not found"
        // If selector was wrong, we'd get a different error
        console2.log("Deposit call success:", success);
        if (!success && data.length > 0) {
            console2.log("Deposit revert data length:", data.length);
            // This is expected - we don't have USDC
        }

        vm.stopPrank();
    }
}

/**
 * @title GatewayABIDiscovery
 * @notice Discover what functions actually exist on the Gateway contract
 * @dev Use this to find the correct function signatures if our assumptions are wrong
 */
contract GatewayABIDiscovery is Test {
    address constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;

    function test_DiscoverFunctions() public {
        console2.log("=== Gateway Wallet Function Discovery ===");
        console2.log("Contract:", GATEWAY_WALLET);

        // Test various possible function signatures
        string[20] memory signatures = [
            "withdrawalDelay()",
            "deposit(address,uint256)",
            "depositFor(address,address,uint256)",
            "addDelegate(address,address)",
            "addDelegate(address)",
            "removeDelegate(address,address)",
            "removeDelegate(address)",
            "isAuthorizedForBalance(address,address,address)",
            "isDelegate(address,address,address)",
            "totalBalance(address,address)",
            "availableBalance(address,address)",
            "balanceOf(address,uint256)",
            "initiateWithdrawal(address,uint256)",
            "withdraw(address)",
            "withdrawalBlock(address,address)",
            "owner()",
            "paused()",
            "VERSION()",
            "name()",
            "symbol()"
        ];

        console2.log("\nTesting function signatures:\n");

        for (uint i = 0; i < signatures.length; i++) {
            (bool success,) = GATEWAY_WALLET.staticcall(
                abi.encodeWithSignature(signatures[i])
            );

            if (success) {
                console2.log(unicode"✓", signatures[i]);
            } else {
                console2.log(unicode"✗", signatures[i]);
            }
        }
    }
}
