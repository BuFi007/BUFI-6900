// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPluginExecutor} from "@circle/msca/6900/v0.7/interfaces/IPluginExecutor.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {PluginManifest} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";

contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockVault is ERC4626 {
    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Mock USDC Vault", "vUSDC") { }
}

/**
 * @dev Slim stand-in for a Circle MSCA: single-plugin fallback routing with the
 * manifest's runtime validation applied before dispatch, and an
 * executeFromPluginExternal restricted to the installed plugin. Exercises the
 * same call shape the real ERC-6900 account uses (validation → call plugin →
 * plugin calls back as the account) without the full 6900 machinery.
 */
contract MockMsca is IPluginExecutor {
    error SelectorNotInstalled(bytes4 selector);
    error OnlyInstalledPlugin(address caller);

    address public plugin;
    mapping(bytes4 => uint8) private validationFunctionId;
    mapping(bytes4 => bool) private selectorInstalled;

    function installPlugin(address plugin_, bytes32 manifestHash_, bytes calldata installData)
        external
    {
        PluginManifest memory manifest = IPlugin(plugin_).pluginManifest();
        require(keccak256(abi.encode(manifest)) == manifestHash_, "manifest hash mismatch");

        plugin = plugin_;
        for (uint256 i = 0; i < manifest.executionFunctions.length; i++) {
            selectorInstalled[manifest.executionFunctions[i]] = true;
        }
        for (uint256 i = 0; i < manifest.runtimeValidationFunctions.length; i++) {
            validationFunctionId[manifest.runtimeValidationFunctions[i].executionSelector] =
                manifest.runtimeValidationFunctions[i].associatedFunction.functionId;
        }
        IPlugin(plugin_).onInstall(installData);
    }

    function uninstallPlugin(bytes calldata uninstallData) external {
        IPlugin(plugin).onUninstall(uninstallData);
    }

    /// @dev The account itself adopting a new config set (multisig action IRL).
    function callPlugin(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = plugin.call(data);
        if (!ok) _revertWith(ret);
        return ret;
    }

    function executeFromPlugin(bytes calldata) external payable override returns (bytes memory) {
        revert("unused in mock");
    }

    function executeFromPluginExternal(address target, uint256 value, bytes calldata data)
        external
        payable
        override
        returns (bytes memory)
    {
        if (msg.sender != plugin) revert OnlyInstalledPlugin(msg.sender);
        (bool ok, bytes memory ret) = target.call{ value: value }(data);
        if (!ok) _revertWith(ret);
        return ret;
    }

    fallback() external payable {
        if (!selectorInstalled[msg.sig]) revert SelectorNotInstalled(msg.sig);

        IPlugin(plugin).runtimeValidationFunction(
            validationFunctionId[msg.sig], msg.sender, msg.value, msg.data
        );

        (bool ok, bytes memory ret) = plugin.call(msg.data);
        if (!ok) _revertWith(ret);
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }

    receive() external payable { }

    function _revertWith(bytes memory ret) private pure {
        assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
