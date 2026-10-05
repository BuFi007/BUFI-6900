// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/src/Script.sol";
import "../../src/bufi/gateway-treasury/GatewayTreasury.sol";

contract Deploy is Script {
    function run() external {
        SignerParams memory signers = SignerParams({
            owners: _parseAddresses(vm.envString("OWNERS")),
            weights: _parseWeights(vm.envString("WEIGHTS")),
            thresholdWeight: vm.envUint("THRESHOLD"),
            gatewayWallet: vm.envAddress("GATEWAY_WALLET")
        });
        PolicyParams memory policy = _policy();

        console.log("Deploying GatewayTreasury...");
        console.log("Owners:", signers.owners.length);
        console.log("Threshold:", signers.thresholdWeight);
        console.log("Gateway wallet:", signers.gatewayWallet);
        console.log("Local domain:", policy.localDomain);

        vm.broadcast();
        GatewayTreasury treasury = new GatewayTreasury(signers, policy);

        console.log("GatewayTreasury deployed at:", address(treasury));
    }

    /// @dev Built field by field to stay under the stack limit.
    function _policy() internal view returns (PolicyParams memory p) {
        p.allowedRecipients = _parseBytes32s(vm.envString("RECIPIENTS"));
        p.allowedDestinationDomains = _parseDomains(vm.envString("DESTINATION_DOMAINS"));
        p.tokenAddresses = _parseAddresses(vm.envString("TOKEN_ADDRESSES"));
        p.tokenNames = _parseStrings(vm.envString("TOKEN_NAMES"), "|");
        p.tokenVersions = _parseStrings(vm.envString("TOKEN_VERSIONS"), "|");
        p.allowedDestinationTokens = _parseBytes32s(vm.envString("DESTINATION_TOKENS"));
        p.perIntentCap = vm.envUint("PER_INTENT_CAP");
        p.maxFeeCap = vm.envUint("MAX_FEE_CAP");
        p.maxExpiryBlocks = vm.envUint("MAX_EXPIRY_BLOCKS");
        p.adminTimelock = uint32(vm.envUint("ADMIN_TIMELOCK"));
        // This chain's Gateway domain (Arc = 26) and the GatewayMinter of each DESTINATION_DOMAINS entry, same order.
        p.localDomain = uint32(vm.envUint("LOCAL_DOMAIN"));
        p.destinationMinters = _parseBytes32s(vm.envString("DESTINATION_MINTERS"));
        p.allowedDestinationCallers = _parseBytes32s(vm.envOr("DESTINATION_CALLERS", string("")));
        require(
            p.destinationMinters.length == p.allowedDestinationDomains.length,
            "DESTINATION_MINTERS must match DESTINATION_DOMAINS"
        );
    }

    function _parseAddresses(string memory input) internal view returns (address[] memory) {
        string[] memory parts = _parseStrings(input, ",");
        address[] memory out = new address[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            out[i] = vm.parseAddress(parts[i]);
        }
        return out;
    }

    function _parseWeights(string memory input) internal view returns (uint16[] memory) {
        string[] memory parts = _parseStrings(input, ",");
        uint16[] memory out = new uint16[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            uint256 parsed = vm.parseUint(parts[i]);
            require(parsed <= type(uint16).max, "weight overflow");
            out[i] = uint16(parsed);
        }
        return out;
    }

    function _parseDomains(string memory input) internal view returns (uint32[] memory) {
        string[] memory parts = _parseStrings(input, ",");
        uint32[] memory out = new uint32[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            uint256 parsed = vm.parseUint(parts[i]);
            require(parsed <= type(uint32).max, "domain overflow");
            out[i] = uint32(parsed);
        }
        return out;
    }

    function _parseBytes32s(string memory input) internal view returns (bytes32[] memory) {
        string[] memory parts = _parseStrings(input, ",");
        bytes32[] memory out = new bytes32[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            out[i] = vm.parseBytes32(parts[i]);
        }
        return out;
    }

    function _parseStrings(string memory input, string memory delimiter) internal pure returns (string[] memory) {
        bytes memory data = bytes(input);
        bytes memory delim = bytes(delimiter);
        require(delim.length == 1, "delimiter must be 1 byte");

        if (data.length == 0) {
            return new string[](0);
        }

        uint256 count = 1;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == delim[0]) count++;
        }

        string[] memory out = new string[](count);

        uint256 partIndex = 0;
        uint256 start = 0;
        for (uint256 i = 0; i <= data.length; i++) {
            if (i == data.length || data[i] == delim[0]) {
                out[partIndex] = _slice(input, start, i);
                partIndex++;
                start = i + 1;
            }
        }

        return out;
    }

    function _slice(string memory input, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory source = bytes(input);
        require(end >= start && end <= source.length, "invalid slice");

        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = source[i];
        }
        return string(out);
    }
}
