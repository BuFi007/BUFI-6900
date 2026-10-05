// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/src/Script.sol";
import "../../src/bufi/gateway-treasury/GatewayTreasury.sol";

contract Deploy is Script {
    function run() external {
        address[] memory _owners = _parseAddresses(vm.envString("OWNERS"));
        uint16[] memory _weights = _parseWeights(vm.envString("WEIGHTS"));
        uint256 _threshold = vm.envUint("THRESHOLD");
        address _gatewayWallet = vm.envAddress("GATEWAY_WALLET");
        bytes32[] memory _recipients = _parseBytes32s(vm.envString("RECIPIENTS"));
        uint32[] memory _domains = _parseDomains(vm.envString("DESTINATION_DOMAINS"));
        address[] memory _tokenAddresses = _parseAddresses(vm.envString("TOKEN_ADDRESSES"));
        string[] memory _tokenNames = _parseStrings(vm.envString("TOKEN_NAMES"), "|");
        string[] memory _tokenVersions = _parseStrings(vm.envString("TOKEN_VERSIONS"), "|");
        bytes32[] memory _destTokens = _parseBytes32s(vm.envString("DESTINATION_TOKENS"));
        uint256 _perIntentCap = vm.envUint("PER_INTENT_CAP");
        uint256 _maxFeeCap = vm.envUint("MAX_FEE_CAP");
        uint256 _maxExpiryBlocks = vm.envUint("MAX_EXPIRY_BLOCKS");
        uint32 _adminTimelock = uint32(vm.envUint("ADMIN_TIMELOCK"));

        console.log("Deploying GatewayTreasury...");
        console.log("Owners:", _owners.length);
        console.log("Threshold:", _threshold);
        console.log("Gateway wallet:", _gatewayWallet);

        SignerParams memory signers = SignerParams({
            owners: _owners,
            weights: _weights,
            thresholdWeight: _threshold,
            gatewayWallet: _gatewayWallet
        });

        PolicyParams memory policy = PolicyParams({
            allowedRecipients: _recipients,
            allowedDestinationDomains: _domains,
            tokenAddresses: _tokenAddresses,
            tokenNames: _tokenNames,
            tokenVersions: _tokenVersions,
            allowedDestinationTokens: _destTokens,
            perIntentCap: _perIntentCap,
            maxFeeCap: _maxFeeCap,
            maxExpiryBlocks: _maxExpiryBlocks,
            adminTimelock: _adminTimelock
        });

        vm.broadcast();
        GatewayTreasury treasury = new GatewayTreasury(signers, policy);

        console.log("GatewayTreasury deployed at:", address(treasury));
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
