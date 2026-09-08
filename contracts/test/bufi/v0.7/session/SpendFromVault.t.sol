// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../../harness/SessionKeyHarness.sol";

import {MockVault} from "../earn/mocks/Mocks.sol";

import {
    BufiSessionRecipientHookPlugin
} from "../../../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {
    IBufiSessionRecipientHookPlugin
} from "../../../../src/bufi/v0.7/recipient-hook/IBufiSessionRecipientHookPlugin.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice An agent spends USDC it does not hold: the position is redeemed and paid out in ONE session-key op.
///
///         This is the FluidKey pattern, on-chain. `fluidkey/fluidkey-earn-module` @ `122cde1` has no `withdraw`
///         or `redeem` anywhere in `src/FluidkeyEarnModule.sol` — its whole value surface is wrap + approve +
///         `IERC4626.deposit`. Spending "straight from yield" happens in the transaction FluidKey's app builds
///         and the user signs, not in the module. `BufiEarnModule` inherits that shape, and
///         `executeWithSessionKey(Call[] calls, address sessionKey)` is where BUFI already has the equivalent
///         bundling primitive.
///
///         What this suite pins, so the path is a checked property and not a design note:
///           - the bundle works with ZERO liquid USDC and no new plugin (`test_agentSpendsFromVault_...`);
///           - it is required — the bare transfer fails without it (`test_bareTransfer_...`);
///           - `BufiSessionRecipientHookPlugin` admits the withdraw leg only because of the deliberate
///             divergence at `BufiSessionRecipientHookPlugin.sol:306`: a zero-value call whose calldata carries
///             no decodable token recipient is judged by its TARGET, so the vault must be on the AddressBook
///             (`test_vaultMustBeOnTheAddressBook`);
///           - the grant-time trap: a vault registered with an ERC-20 spend limit rejects `withdraw`, because
///             `isAllowedERC20Function` is `transfer || approve` only
///             (`SessionKeyPermissions.sol:642`, byte-for-byte upstream) — `test_vaultAsErc20SpendLimited_...`.
contract SpendFromVaultTest is SessionKeyHarness {
    BufiSessionRecipientHookPlugin internal hook;
    SandboxUSDC internal usdc;
    MockVault internal vault;

    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal payee;

    uint256 internal constant SEEDED = 1_000e6;
    uint256 internal constant SPEND = 250e6;
    uint256 internal constant AGENT_BUDGET = 500e6;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        hook = new BufiSessionRecipientHookPlugin();
        vm.label(address(hook), "BufiSessionRecipientHookPlugin");

        usdc = new SandboxUSDC();
        vault = new MockVault(IERC20(address(usdc)));
        vm.label(address(vault), "MockVault");

        payee = makeAddr("payee");
        agent = _signerFrom("agent");

        // AddressBook: the payee AND the vault. The vault is on it because the withdraw leg is judged by target.
        address[] memory recipients = new address[](2);
        recipients[0] = payee;
        recipients[1] = address(vault);
        account = _newAccount(bytes32(uint256(61)), recipients);

        _parkEverythingInTheVault();
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  The proof                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Zero liquid USDC, everything in an ERC-4626 position, one agent op pays the payee.
    function test_agentSpendsFromVault_withZeroLiquidUsdc() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _spendFromVaultGrant(), quorum));

        assertEq(usdc.balanceOf(address(account)), 0, "precondition: no liquid USDC");
        uint256 sharesBefore = vault.balanceOf(address(account));
        assertGt(sharesBefore, 0, "precondition: the position holds the funds");

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _call(address(vault), 0, abi.encodeCall(IERC4626.withdraw, (SPEND, address(account), address(account)))),
                    _erc20Transfer(address(usdc), payee, SPEND)
                ),
                agent
            ),
            "agent op with [withdraw, transfer]"
        );

        assertEq(usdc.balanceOf(payee), SPEND, "payee paid straight out of the position");
        assertEq(usdc.balanceOf(address(account)), 0, "sourced exactly the shortfall, nothing left idle");
        assertLt(vault.balanceOf(address(account)), sharesBefore, "shares burned");
        assertEq(vault.maxWithdraw(address(account)), SEEDED - SPEND, "the rest keeps earning");
    }

    /// @dev The bundle is not optional: the same key, same budget, single transfer call — no funds move.
    function test_bareTransfer_failsWithoutTheWithdrawLeg() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), _spendFromVaultGrant(), quorum));

        assertFalse(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), payee, SPEND)), agent),
            "a bare transfer with zero liquid balance must revert in execution"
        );
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(vault.maxWithdraw(address(account)), SEEDED, "position untouched");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  The two gates the path depends on                                              ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev `withdraw(uint256,address,address)` carries no decodable token recipient, so the recipient hook falls
    ///      back to the call target. An account whose AddressBook omits the vault cannot run the bundle at all.
    function test_vaultMustBeOnTheAddressBook() public {
        address[] memory payeeOnly = new address[](1);
        payeeOnly[0] = payee;
        UpgradableMSCA bare = _newAccount(bytes32(uint256(62)), payeeOnly);

        vm.startPrank(address(bare));
        usdc.mint(address(bare), SEEDED);
        usdc.approve(address(vault), SEEDED);
        vault.deposit(SEEDED, address(bare));
        vm.stopPrank();

        assertTrue(_addSessionKey(bare, agent.addr, bytes32("agent"), _spendFromVaultGrant(), quorum));

        _expectSessionKeyValidationRevert(
            bare,
            _calls(
                _call(address(vault), 0, abi.encodeCall(IERC4626.withdraw, (SPEND, address(bare), address(bare)))),
                _erc20Transfer(address(usdc), payee, SPEND)
            ),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(bare), address(vault)
                )
            )
        );
        assertEq(usdc.balanceOf(payee), 0);
    }

    /// @dev The grant-time trap. Vault shares ARE an ERC-20, so `_permErc20Limit(vault, …)` looks reasonable in a
    ///      preset — and it silently bricks the withdraw leg at validation, because a contract flagged
    ///      `isERC20WithSpendLimit` admits only `transfer` / `approve` (`SessionKeyPermissions.sol:217`).
    function test_vaultAsErc20SpendLimited_rejectsWithdraw() public {
        bytes[] memory updates = new bytes[](6);
        updates[0] = _permAddressEntry(address(usdc), true, true);
        updates[1] = _permFunctionEntry(address(usdc), IERC20.transfer.selector, true);
        updates[2] = _permErc20Limit(address(usdc), AGENT_BUDGET, 0);
        updates[3] = _permAddressEntry(address(vault), true, true);
        updates[4] = _permFunctionEntry(address(vault), IERC4626.withdraw.selector, true);
        updates[5] = _permErc20Limit(address(vault), AGENT_BUDGET, 0); // <-- the mistake

        assertTrue(_addSessionKey(account, agent.addr, bytes32("agent"), updates, quorum));

        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _call(address(vault), 0, abi.encodeCall(IERC4626.withdraw, (SPEND, address(account), address(account)))),
                _erc20Transfer(address(usdc), payee, SPEND)
            ),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(usdc.balanceOf(payee), 0, "the whole op is rejected at validation, no gas-burning revert");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev 2-of-3 weighted account: AddressBook(recipients) → SessionKey → recipient hook.
    function _newAccount(bytes32 salt, address[] memory recipients) internal returns (UpgradableMSCA msca) {
        Signer[] memory owners = _makeSigners("owner", 3);
        msca = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, salt);
        if (quorum.length == 0) {
            quorum.push(owners[0]);
            quorum.push(owners[1]);
        }
        Signer[] memory q = new Signer[](2);
        q[0] = owners[0];
        q[1] = owners[1];
        assertTrue(_installAddressBook(msca, recipients, q), "address book install");
        assertTrue(_installSessionKeyPlugin(msca, q), "session key plugin install");
        assertTrue(
            _installPlugin(msca, address(hook), abi.encode(address(addressBookPlugin)), new FunctionReference[](0), q),
            "recipient hook install"
        );
    }

    /// @dev Seed the position and leave the account with exactly zero liquid USDC. Done as the account directly:
    ///      the owners' own `execute` path CANNOT deposit here — AddressBook fails closed on `deposit(uint256,address)`
    ///      (see EARN-NOTES.md), which is why the earn module exists in the first place.
    function _parkEverythingInTheVault() internal {
        vm.startPrank(address(account));
        usdc.mint(address(account), SEEDED);
        usdc.approve(address(vault), SEEDED);
        vault.deposit(SEEDED, address(account));
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(account)), 0);
    }

    /// @dev The grant a spend-from-yield agent needs: USDC.transfer under a budget, plus vault.withdraw as a
    ///      plain permitted call. Note what is NOT here: an ERC-20 spend limit on the vault.
    function _spendFromVaultGrant() internal view returns (bytes[] memory updates) {
        updates = new bytes[](5);
        updates[0] = _permAddressEntry(address(usdc), true, true);
        updates[1] = _permFunctionEntry(address(usdc), IERC20.transfer.selector, true);
        updates[2] = _permErc20Limit(address(usdc), AGENT_BUDGET, 0);
        updates[3] = _permAddressEntry(address(vault), true, true);
        updates[4] = _permFunctionEntry(address(vault), IERC4626.withdraw.selector, true);
    }
}
