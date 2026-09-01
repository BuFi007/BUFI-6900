// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * @title VerifyGatewayABI
 * @notice Script to verify Gateway contract ABI on testnet
 * @dev Run with: forge script script/VerifyGatewayABI.s.sol --fork-url $SEPOLIA_RPC_URL -vvv
 */
contract VerifyGatewayABI is Script {
    address constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    function run() public view {
        console2.log("=== Gateway ABI Verification ===");
        console2.log("Gateway Wallet:", GATEWAY_WALLET);
        console2.log("USDC:", USDC);
        console2.log("");

        // Check contract exists
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(GATEWAY_WALLET)
        }
        console2.log("Contract code size:", codeSize);

        if (codeSize == 0) {
            console2.log("ERROR: No contract at Gateway Wallet address!");
            return;
        }

        console2.log("");
        console2.log("Testing function signatures...");
        console2.log("");

        // Test each function
        _testFunction("withdrawalDelay()", "");
        _testFunction("totalBalance(address,address)", abi.encode(USDC, address(this)));
        _testFunction("availableBalance(address,address)", abi.encode(USDC, address(this)));
        _testFunction("isAuthorizedForBalance(address,address,address)", abi.encode(USDC, address(this), address(this)));

        console2.log("");
        console2.log("=== Delegation Function Signatures ===");
        console2.log("");

        // These are the critical ones - which signature is correct?
        _testFunction("addDelegate(address,address)", abi.encode(USDC, address(0x1)));
        _testFunction("addDelegate(address)", abi.encode(address(0x1)));
        _testFunction("removeDelegate(address,address)", abi.encode(USDC, address(0x1)));
        _testFunction("removeDelegate(address)", abi.encode(address(0x1)));

        console2.log("");
        console2.log("=== Computed Selectors ===");
        console2.log("");

        console2.log("addDelegate(address,address):");
        console2.logBytes4(bytes4(keccak256("addDelegate(address,address)")));

        console2.log("addDelegate(address):");
        console2.logBytes4(bytes4(keccak256("addDelegate(address)")));

        console2.log("removeDelegate(address,address):");
        console2.logBytes4(bytes4(keccak256("removeDelegate(address,address)")));

        console2.log("removeDelegate(address):");
        console2.logBytes4(bytes4(keccak256("removeDelegate(address)")));
    }

    function _testFunction(string memory sig, bytes memory params) internal view {
        bytes memory callData;
        if (params.length > 0) {
            callData = abi.encodePacked(bytes4(keccak256(bytes(sig))), params);
        } else {
            callData = abi.encodeWithSignature(sig);
        }

        (bool success, bytes memory returnData) = GATEWAY_WALLET.staticcall(callData);

        if (success) {
            console2.log(unicode"✓", sig);
            if (returnData.length > 0) {
                console2.log("  Return data length:", returnData.length);
            }
        } else {
            console2.log(unicode"✗", sig);
            if (returnData.length >= 4) {
                bytes4 errorSelector;
                assembly {
                    errorSelector := mload(add(returnData, 32))
                }
                console2.log("  Error selector:");
                console2.logBytes4(errorSelector);
            }
        }
    }
}
