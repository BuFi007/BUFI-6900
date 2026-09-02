// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ManifestAssociatedFunctionType, PluginManifest} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginExecutor} from "@circle/msca/6900/v0.7/interfaces/IPluginExecutor.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockVault is ERC4626 {
    constructor(IERC20 asset_) ERC4626(asset_) ERC20("Mock USDC Vault", "vUSDC") {}
}

/**
 * @dev Slim stand-in for a Circle MSCA: single-plugin fallback routing with the
 * manifest's runtime validation applied before dispatch, and an
 * executeFromPluginExternal restricted to the installed plugin. Exercises the
 * same call shape the real ERC-6900 account uses (validation → call plugin →
 * plugin calls back as the account) without the full 6900 machinery.
 *
 * Dependency slots are modelled the way production wires them: the install
 * must supply exactly `manifest.dependencyInterfaceIds.length` references, a
 * DEPENDENCY-backed runtime validation is fail-closed (the real wiring points
 * it at an unimplemented owner function id), and the DEPENDENCY-backed userOp
 * path is represented by `callPlugin` — "the account itself, after owner
 * validation" — since the mock has no EntryPoint.
 */
contract MockMsca is IPluginExecutor {
    error SelectorNotInstalled(bytes4 selector);
    error OnlyInstalledPlugin(address caller);
    error DependencyCountMismatch(uint256 expected, uint256 given);
    error RuntimeValidationFailClosed(bytes4 selector);

    address public plugin;
    FunctionReference[] public dependencies;
    mapping(bytes4 => uint8) private validationFunctionId;
    mapping(bytes4 => bool) private selectorInstalled;
    mapping(bytes4 => bool) private runtimeValidationIsDependency;

    function installPlugin(
        address plugin_,
        bytes32 manifestHash_,
        bytes calldata installData,
        FunctionReference[] calldata dependencies_
    ) external {
        PluginManifest memory manifest = IPlugin(plugin_).pluginManifest();
        require(keccak256(abi.encode(manifest)) == manifestHash_, "manifest hash mismatch");
        if (dependencies_.length != manifest.dependencyInterfaceIds.length) {
            revert DependencyCountMismatch(manifest.dependencyInterfaceIds.length, dependencies_.length);
        }

        plugin = plugin_;
        for (uint256 i = 0; i < dependencies_.length; i++) {
            dependencies.push(dependencies_[i]);
        }
        for (uint256 i = 0; i < manifest.executionFunctions.length; i++) {
            selectorInstalled[manifest.executionFunctions[i]] = true;
        }
        for (uint256 i = 0; i < manifest.runtimeValidationFunctions.length; i++) {
            bytes4 selector = manifest.runtimeValidationFunctions[i].executionSelector;
            if (
                manifest.runtimeValidationFunctions[i].associatedFunction.functionType
                    == ManifestAssociatedFunctionType.DEPENDENCY
            ) {
                runtimeValidationIsDependency[selector] = true;
            } else {
                validationFunctionId[selector] = manifest.runtimeValidationFunctions[i].associatedFunction.functionId;
            }
        }
        IPlugin(plugin_).onInstall(installData);
    }

    function uninstallPlugin(bytes calldata uninstallData) external {
        IPlugin(plugin).onUninstall(uninstallData);
    }

    function dependencyCount() external view returns (uint256) {
        return dependencies.length;
    }

    /// @dev The account itself calling the plugin after owner validation — the
    /// userOp path of a DEPENDENCY-validated execution function (multisig IRL).
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
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) _revertWith(ret);
        return ret;
    }

    fallback() external payable {
        if (!selectorInstalled[msg.sig]) revert SelectorNotInstalled(msg.sig);
        if (runtimeValidationIsDependency[msg.sig]) revert RuntimeValidationFailClosed(msg.sig);

        IPlugin(plugin).runtimeValidationFunction(validationFunctionId[msg.sig], msg.sender, msg.value, msg.data);

        (bool ok, bytes memory ret) = plugin.call(msg.data);
        if (!ok) _revertWith(ret);
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }

    receive() external payable {}

    function _revertWith(bytes memory ret) private pure {
        assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
