// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginExecutor} from "@circle/msca/6900/v0.7/interfaces/IPluginExecutor.sol";
import {
    ManifestAssociatedFunction,
    ManifestAssociatedFunctionType,
    ManifestFunction,
    PluginManifest,
    PluginMetadata,
    SelectorPermission
} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/**
 * @title BufiEarnModule
 * @notice ERC-6900 port of Fluidkey's FluidkeyEarnModule (a Safe module, itself
 * based on Rhinestone's AutoSavings): an authorized relayer can sweep a
 * treasury MSCA's idle ERC-20 balance into a pre-configured ERC-4626 vault.
 * Deposit-only by design — vault shares always mint to the account itself and
 * redemption remains a multisig action. Worst case for a compromised relayer is
 * depositing at an inopportune time; funds can never leave the account.
 *
 * Original: https://github.com/fluidkey/fluidkey-earn-module (Ackee-audited).
 * Deliberate deviations from the original:
 *  - Safe `execTransactionFromModule` → ERC-6900 `executeFromPluginExternal`;
 *    relayer authorization moved into the account-side runtime validation.
 *  - No native-token wrap path — BUFI treasuries hold USDC/EURC only, and Arc
 *    uses USDC as native gas, which makes wrapped-native semantics ambiguous.
 *  - No signature-relay overload — the relayer (Shiva key or CRE extractor)
 *    calls the account directly; less surface for the first audit pass.
 *  - Relayer add/remove is onlyOwner — relayers cannot mint more relayers.
 *  - SentinelList dependency replaced with a plain array + membership mapping.
 *
 * DEVELOPMENT ONLY: gated off in production by `isCircleEarnModuleEnabled()`
 * in packages/env/src/circle.ts. Target chains: Avalanche + Arc, where
 * treasury MSCAs deploy. Not audited — do not install on mainnet treasuries.
 */
contract BufiEarnModule is IPlugin, IERC165, Ownable {
    /*//////////////////////////////////////////////////////////////////////////
                            CONSTANTS & STORAGE
    //////////////////////////////////////////////////////////////////////////*/

    error TooManyTokens();
    error EmptyConfigList();
    error ModuleNotInitialized(address account);
    error ModuleAlreadyInitialized(address account);
    error NotAuthorized(address caller);
    error ConfigNotFound(address token);
    error InvalidConfigHash();
    error NotImplemented();
    error InvalidFunctionId(uint8 functionId);

    uint256 internal constant MAX_TOKENS = 100;

    /// @dev functionId for the relayer runtime validation referenced in the manifest.
    uint8 public constant FUNCTION_ID_RUNTIME_VALIDATION_RELAYER = 0;

    /// @dev Relayer addresses allowed to trigger autoEarn on installed accounts.
    mapping(address => bool) public authorizedRelayers;

    /// @dev config[configHash][chainId][token] = vault. The chainId dimension
    /// lets one configHash cover Avalanche + Arc when the module is deployed at
    /// the same address on both (CREATE2).
    mapping(uint256 => mapping(uint256 => mapping(address => address))) public config;

    /// @dev tokenList[keccak256(configHash, chainId)] — enumerable token set.
    mapping(uint256 => address[]) private tokenList;
    mapping(uint256 => mapping(address => bool)) private tokenListed;

    /// @dev accountConfig[account] = configHash the account opted into at install.
    mapping(address => uint256) public accountConfig;

    event AddAuthorizedRelayer(address indexed relayer);
    event RemoveAuthorizedRelayer(address indexed relayer);
    event ModuleInitialized(address indexed account);
    event ModuleUninitialized(address indexed account);
    event ConfigSet(uint256 indexed configHash, uint256 indexed chainId, address token);
    event AutoEarnExecuted(address indexed smartAccount, address indexed token, uint256 amountIn);
    event ConfigHashChanged(address indexed account, uint256 oldConfigHash, uint256 newConfigHash);

    /*//////////////////////////////////////////////////////////////////////////
                                     STRUCTS
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev Sorted by (chainId, token) before hashing, same as the original.
    struct ConfigInput {
        uint256 chainId;
        address token;
        address vault;
    }

    struct ConfigWithToken {
        address token;
        address vault;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                 CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    constructor(address _authorizedRelayer, address _owner) Ownable(_owner) {
        authorizedRelayers[_authorizedRelayer] = true;
        emit AddAuthorizedRelayer(_authorizedRelayer);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                     CONFIG
    //////////////////////////////////////////////////////////////////////////*/

    function addAuthorizedRelayer(address newRelayer) external onlyOwner {
        authorizedRelayers[newRelayer] = true;
        emit AddAuthorizedRelayer(newRelayer);
    }

    function removeAuthorizedRelayer(address relayer) external onlyOwner {
        delete authorizedRelayers[relayer];
        emit RemoveAuthorizedRelayer(relayer);
    }

    /**
     * @dev Registers a (chainId, token, vault) set under its content hash.
     * Accounts opt into a set via onInstall/changeConfigHash, so the owner
     * cannot silently reroute an account's deposits: changing a vault produces
     * a new configHash the account must explicitly adopt.
     */
    function setConfig(ConfigInput[] calldata newConfigs) external onlyOwner returns (uint256) {
        if (newConfigs.length == 0) revert EmptyConfigList();

        uint256 configHash_ = uint256(keccak256(abi.encode(newConfigs)));

        for (uint256 i = 0; i < newConfigs.length; i++) {
            address _token = newConfigs[i].token;
            uint256 _chainId = newConfigs[i].chainId;

            uint256 configHashChainId =
                uint256(keccak256(abi.encodePacked(configHash_, _chainId)));

            if (!tokenListed[configHashChainId][_token]) {
                if (tokenList[configHashChainId].length >= MAX_TOKENS) revert TooManyTokens();
                tokenList[configHashChainId].push(_token);
                tokenListed[configHashChainId][_token] = true;
            }

            config[configHash_][_chainId][_token] = newConfigs[i].vault;

            emit ConfigSet(configHash_, _chainId, _token);
        }

        return configHash_;
    }

    /// @notice Called by the account itself (via its own execute) to adopt a
    /// different config set.
    function changeConfigHash(uint256 newConfigHash) external {
        address account = msg.sender;
        if (!isInitialized(account)) revert ModuleNotInitialized(account);
        if (newConfigHash == 0) revert InvalidConfigHash();
        uint256 oldConfigHash = accountConfig[account];
        accountConfig[account] = newConfigHash;
        emit ConfigHashChanged(account, oldConfigHash, newConfigHash);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                 READ METHODS
    //////////////////////////////////////////////////////////////////////////*/

    function isInitialized(address smartAccount) public view returns (bool) {
        return accountConfig[smartAccount] != 0;
    }

    function getTokens(uint256 configHash_, uint256 chainId_)
        external
        view
        returns (address[] memory)
    {
        return tokenList[uint256(keccak256(abi.encodePacked(configHash_, chainId_)))];
    }

    function getAllConfigs(address account) external view returns (ConfigWithToken[] memory) {
        uint256 configHash_ = accountConfig[account];
        if (configHash_ == 0) return new ConfigWithToken[](0);

        uint256 chainId_ = block.chainid;
        address[] storage tokensArray =
            tokenList[uint256(keccak256(abi.encodePacked(configHash_, chainId_)))];
        ConfigWithToken[] memory configsArray = new ConfigWithToken[](tokensArray.length);

        for (uint256 i; i < tokensArray.length; i++) {
            configsArray[i] = ConfigWithToken({
                token: tokensArray[i],
                vault: config[configHash_][chainId_][tokensArray[i]]
            });
        }

        return configsArray;
    }

    /// @notice keccak256(abi.encode(manifest)) — the value installPlugin expects.
    function manifestHash() external pure returns (bytes32) {
        return keccak256(abi.encode(_manifest()));
    }

    /*//////////////////////////////////////////////////////////////////////////
                                 MODULE LOGIC
    //////////////////////////////////////////////////////////////////////////*/

    /**
     * @notice Execution function installed on the account. Reached via the
     * account's fallback after the relayer runtime validation passes, so
     * msg.sender here is the MSCA itself.
     * @dev Plain approve (no reset-to-zero): treasury assets are USDC/EURC,
     * and the vault is owner-configured, account-adopted. No reentrancy guard,
     * matching the original — the vault is trusted by explicit configuration.
     */
    function autoEarn(address token, uint256 amountToSave) external {
        address account = msg.sender;
        if (!isInitialized(account)) revert ModuleNotInitialized(account);

        uint256 configHash_ = accountConfig[account];
        address vaultAddress = config[configHash_][block.chainid][token];
        if (vaultAddress == address(0)) revert ConfigNotFound(token);

        IPluginExecutor(account).executeFromPluginExternal(
            token, 0, abi.encodeCall(IERC20.approve, (vaultAddress, amountToSave))
        );
        IPluginExecutor(account).executeFromPluginExternal(
            vaultAddress, 0, abi.encodeCall(IERC4626.deposit, (amountToSave, account))
        );

        emit AutoEarnExecuted(account, token, amountToSave);
    }

    /*//////////////////////////////////////////////////////////////////////////
                              IPlugin IMPLEMENTATION
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev pluginInstallData = abi.encode(uint256 configHash).
    function onInstall(bytes calldata data) external override {
        address account = msg.sender;
        if (isInitialized(account)) revert ModuleAlreadyInitialized(account);

        uint256 configHash_ = abi.decode(data, (uint256));
        if (configHash_ == 0) revert InvalidConfigHash();

        accountConfig[account] = configHash_;

        emit ModuleInitialized(account);
        emit ConfigHashChanged(account, 0, configHash_);
    }

    function onUninstall(bytes calldata) external override {
        address account = msg.sender;
        accountConfig[account] = 0;
        emit ModuleUninitialized(account);
    }

    /// @dev The only validation this plugin provides: the runtime caller of
    /// account.autoEarn must be an authorized relayer or the module owner.
    function runtimeValidationFunction(
        uint8 functionId,
        address sender,
        uint256,
        bytes calldata
    ) external view override {
        if (functionId != FUNCTION_ID_RUNTIME_VALIDATION_RELAYER) {
            revert InvalidFunctionId(functionId);
        }
        if (!authorizedRelayers[sender] && sender != owner()) revert NotAuthorized(sender);
    }

    function preUserOpValidationHook(uint8, PackedUserOperation calldata, bytes32)
        external
        pure
        override
        returns (uint256)
    {
        revert NotImplemented();
    }

    function userOpValidationFunction(uint8, PackedUserOperation calldata, bytes32)
        external
        pure
        override
        returns (uint256)
    {
        revert NotImplemented();
    }

    function preRuntimeValidationHook(uint8, address, uint256, bytes calldata)
        external
        pure
        override
    {
        revert NotImplemented();
    }

    function preExecutionHook(uint8, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes memory)
    {
        revert NotImplemented();
    }

    function postExecutionHook(uint8, bytes calldata) external pure override {
        revert NotImplemented();
    }

    function pluginManifest() external pure override returns (PluginManifest memory) {
        return _manifest();
    }

    function pluginMetadata() external pure override returns (PluginMetadata memory) {
        PluginMetadata memory metadata;
        metadata.name = "BufiEarnModule";
        metadata.version = "0.1.0-dev";
        metadata.author = "BUFI";
        metadata.permissionDescriptors = new SelectorPermission[](1);
        metadata.permissionDescriptors[0] = SelectorPermission({
            functionSelector: this.autoEarn.selector,
            permissionDescription: "Deposit account ERC-20 balance into its pre-configured ERC-4626 vault"
        });
        return metadata;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IPlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /**
     * @dev permitAnyExternalAddress is required because vault targets are
     * config-driven (not knowable at install time). The effective call surface
     * is still only IERC20.approve + IERC4626.deposit toward the account's
     * adopted config — enforced by autoEarn being the sole execution function.
     * No userOpValidationFunctions: autoEarn is runtime-callable only.
     */
    function _manifest() internal pure returns (PluginManifest memory) {
        PluginManifest memory manifest;

        manifest.executionFunctions = new bytes4[](1);
        manifest.executionFunctions[0] = this.autoEarn.selector;

        manifest.runtimeValidationFunctions = new ManifestAssociatedFunction[](1);
        manifest.runtimeValidationFunctions[0] = ManifestAssociatedFunction({
            executionSelector: this.autoEarn.selector,
            associatedFunction: ManifestFunction({
                functionType: ManifestAssociatedFunctionType.SELF,
                functionId: FUNCTION_ID_RUNTIME_VALIDATION_RELAYER,
                dependencyIndex: 0
            })
        });

        manifest.permitAnyExternalAddress = true;
        manifest.canSpendNativeToken = false;

        return manifest;
    }
}
