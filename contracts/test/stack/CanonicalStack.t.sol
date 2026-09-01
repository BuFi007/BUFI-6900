// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "../harness/CircleCanonical.sol";
import {CircleStackHarness} from "../harness/CircleStackHarness.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract SandboxUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Proves the sandbox recreates Circle's production stack faithfully: canonical addresses, the
///         SDK-pinned manifest hashes, the implementation address the SDK hard-codes, and a full
///         weighted-multisig lifecycle (create → transfer → install AddressBook → allowlist gating).
contract CanonicalStackTest is CircleStackHarness {
    SandboxUSDC internal usdc;

    function setUp() public {
        _deployCircleCanonicalStack();
        usdc = new SandboxUSDC();
    }

    function test_canonicalAddressesAndManifestHashes() public view {
        assertGt(CircleCanonical.ENTRY_POINT_V07.code.length, 0, "entrypoint");
        assertGt(CircleCanonical.PLUGIN_MANAGER.code.length, 0, "plugin manager");
        assertGt(CircleCanonical.UPGRADABLE_MSCA_FACTORY.code.length, 0, "factory");
        assertGt(CircleCanonical.UPGRADABLE_MSCA_IMPL.code.length, 0, "msca impl (SDK UPGRADABLE_MSCA.address)");
        assertEq(address(factory.ACCOUNT_IMPLEMENTATION()), CircleCanonical.UPGRADABLE_MSCA_IMPL, "impl address");
        assertEq(address(factory.ENTRY_POINT()), CircleCanonical.ENTRY_POINT_V07, "factory entrypoint");
        assertEq(factory.owner(), CircleCanonical.FACTORY_OWNER, "factory owner");
        assertTrue(factory.isPluginAllowed(address(weightedPlugin)), "weighted allowed");
        assertTrue(factory.isPluginAllowed(address(addressBookPlugin)), "address book allowed");
        assertEq(
            keccak256(abi.encode(weightedPlugin.pluginManifest())),
            CircleCanonical.WEIGHTED_WEBAUTHN_MULTISIG_MANIFEST_HASH,
            "weighted manifest hash == SDK constant"
        );
        assertEq(
            keccak256(abi.encode(addressBookPlugin.pluginManifest())),
            CircleCanonical.COLD_STORAGE_ADDRESS_BOOK_MANIFEST_HASH,
            "address book manifest hash == desk-v1 constant"
        );
    }

    function test_weightedMultisigLifecycle_2of3_withAddressBook() public {
        Signer[] memory owners = _makeSigners("treasury", 3);
        UpgradableMSCA msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(1)));
        assertTrue(_isInstalled(msca, address(weightedPlugin)), "weighted installed at init");

        usdc.mint(address(msca), 1_000e6);
        address allowed = makeAddr("allowed-recipient");
        address stranger = makeAddr("stranger");

        // 1) Any 2 of 3 can spend before the address book exists.
        Signer[] memory quorum = new Signer[](2);
        quorum[0] = owners[0];
        quorum[1] = owners[2];
        bool ok = _executeUserOp(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 10e6))), quorum
        );
        assertTrue(ok, "2-of-3 transfer executes");
        assertEq(usdc.balanceOf(stranger), 10e6);

        // 2) A single owner is below threshold: validation fails at the EntryPoint (AA24).
        Signer[] memory solo = new Signer[](1);
        solo[0] = owners[1];
        _expectValidationRevert(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), solo
        );

        // 3) Install ColdStorageAddressBookPlugin with the production dependency-slot arrangement.
        address[] memory recipients = new address[](1);
        recipients[0] = allowed;
        assertTrue(_installAddressBook(msca, recipients, quorum), "address book install userOp succeeds");
        assertTrue(_isInstalled(msca, address(addressBookPlugin)), "address book installed");
        address[] memory onchain = addressBookPlugin.getAllowedRecipients(address(msca));
        assertEq(onchain.length, 1);
        assertEq(onchain[0], allowed);

        // 4) Allowlisted recipient still works …
        ok = _executeUserOp(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (allowed, 5e6))), quorum
        );
        assertTrue(ok, "transfer to allowlisted recipient");
        assertEq(usdc.balanceOf(allowed), 5e6);

        // 5) … and the stranger is now rejected in the pre-userOp validation hook (FailedOpWithRevert AA23).
        _expectValidationRevert(
            msca, _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), quorum
        );
        assertEq(usdc.balanceOf(stranger), 10e6, "stranger balance unchanged");
    }

    function test_addressBookRuntimePathIsFailClosed() public {
        Signer[] memory owners = _makeSigners("ops", 1);
        UpgradableMSCA msca = _createWeightedMsca(owners, _uniformWeights(1, 1), 1, bytes32(uint256(2)));
        address[] memory recipients = new address[](0);
        assertTrue(_installAddressBook(msca, recipients, owners));

        // Direct (runtime) call to the address-book execution function from the owner EOA must fail:
        // slot 0 points at Weighted function id 1, which the plugin does not implement.
        address[] memory add = new address[](1);
        add[0] = makeAddr("new-recipient");
        vm.prank(owners[0].addr);
        vm.expectRevert();
        ColdStorageAddressBookPluginLike(address(msca)).addAllowedRecipients(add);

        // The userOp path (slot 1 → owner validation) is the only way in.
        bool ok = _executeUserOp(
            msca, abi.encodeCall(ColdStorageAddressBookPluginLike.addAllowedRecipients, (add)), owners
        );
        assertTrue(ok, "addAllowedRecipients via userOp");
        assertEq(addressBookPlugin.getAllowedRecipients(address(msca)).length, 1);
    }
}

interface ColdStorageAddressBookPluginLike {
    function addAllowedRecipients(address[] calldata recipients) external;
}
