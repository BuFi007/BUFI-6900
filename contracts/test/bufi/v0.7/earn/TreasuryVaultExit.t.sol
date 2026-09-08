// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../../harness/SessionKeyHarness.sol";
import {MockVault} from "../earn/mocks/Mocks.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice FINDING: on a treasury with `ColdStorageAddressBookPlugin` installed, the OWNER QUORUM cannot exit an
///         ERC-4626 position by hand. `redeem(uint256,address,address)` and `withdraw(uint256,address,address)`
///         carry no decodable ERC-20/721/1155 recipient, so Circle's AddressBook resolves `address(0)` and fails
///         closed at validation — even though the vault IS on the allowlist. EARN-NOTES already records the same
///         mechanism for `deposit`; this pins the EXIT side, which matters more.
///
///         Consequences for a fully-composed treasury (AddressBook + session key + recipient hook + earn):
///           - the in-place exit is the agent path — `executeWithSessionKey([vault.withdraw, token.transfer])` —
///             which works because `BufiSessionRecipientHookPlugin` judges an undecodable call by its TARGET
///             (`BufiSessionRecipientHookPlugin.sol:306`), the deliberate divergence from Circle's plugin.
///             See `test/bufi/v0.7/session/SpendFromVault.t.sol`.
///           - the owners' own escape hatch is to uninstall the AddressBook first, redeem, and reinstall. Three
///             quorum user operations, and the allowlist is off for the middle one. Proved below so the procedure
///             is written down rather than discovered during an incident.
contract TreasuryVaultExitTest is SessionKeyHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    SandboxUSDC internal usdc;
    MockVault internal vault;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        usdc = new SandboxUSDC();
        vault = new MockVault(IERC20(address(usdc)));

        Signer[] memory owners = _makeSigners("owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(91)));
        quorum.push(owners[0]);
        quorum.push(owners[1]);

        address[] memory recipients = new address[](1);
        recipients[0] = address(vault); // the vault IS allowlisted
        assertTrue(_installAddressBook(account, recipients, quorum), "address book install");

        vm.startPrank(address(account));
        usdc.mint(address(account), 1_000e6);
        usdc.approve(address(vault), 1_000e6);
        vault.deposit(1_000e6, address(account));
        vm.stopPrank();
    }

    function test_quorumCannotExitAVaultByHand_andTheEscapeHatchIsUninstall() public {
        uint256 shares = vault.balanceOf(address(account));
        assertGt(shares, 0);

        // Rejected at VALIDATION: redeem() carries no decodable ERC-20/721/1155 recipient, so Circle's AddressBook
        // resolves address(0) and fails closed -- even though the vault IS on the allowlist.
        _expectValidationRevert(
            account,
            _executeCalldata(address(vault), 0, abi.encodeCall(IERC4626.redeem, (shares, address(account), address(account)))),
            quorum
        );
        _expectValidationRevert(
            account,
            _executeCalldata(address(vault), 0, abi.encodeCall(IERC4626.withdraw, (100e6, address(account), address(account)))),
            quorum
        );
        assertEq(usdc.balanceOf(address(account)), 0, "quorum cannot exit the position by hand");

        // Escape hatch: uninstall the AddressBook (a quorum userOp, itself not gated by it), then redeem.
        assertTrue(
            _executeUserOp(
                account,
                abi.encodeWithSignature("uninstallPlugin(address,bytes,bytes)", address(addressBookPlugin), "", ""),
                quorum
            ),
            "AddressBook uninstall"
        );
        assertTrue(
            _executeUserOp(
                account,
                _executeCalldata(address(vault), 0, abi.encodeCall(IERC4626.redeem, (shares, address(account), address(account)))),
                quorum
            ),
            "redeem after uninstall"
        );
        assertEq(usdc.balanceOf(address(account)), 1_000e6, "funds recovered only after uninstalling the AddressBook");
    }
}
