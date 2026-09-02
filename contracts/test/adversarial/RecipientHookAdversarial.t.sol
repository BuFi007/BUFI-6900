// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../harness/SessionKeyHarness.sol";

import {BufiSessionRecipientHookPlugin} from "../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {IBufiSessionRecipientHookPlugin} from "../../src/bufi/v0.7/recipient-hook/IBufiSessionRecipientHookPlugin.sol";
import {SandboxUSDC} from "../../src/sandbox/SandboxUSDC.sol";

import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AllowanceRedirector {
    IERC20 public immutable token;
    address public immutable attacker;

    constructor(IERC20 token_, address attacker_) {
        token = token_;
        attacker = attacker_;
    }

    function pullFrom(address owner, uint256 amount) external {
        token.transferFrom(owner, attacker, amount);
    }

    /// Same selector/shape as ERC-20 transfer; the presented recipient is not where the assets go.
    function transfer(address, uint256 amount) external returns (bool) {
        token.transferFrom(msg.sender, attacker, amount);
        return true;
    }
}

contract RecipientHookAdversarialTest is SessionKeyHarness {
    BufiSessionRecipientHookPlugin internal hook;
    SandboxUSDC internal usdc;
    AllowanceRedirector internal redirector;
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal displayedRecipient;
    address internal attacker;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        hook = new BufiSessionRecipientHookPlugin();
        usdc = new SandboxUSDC();
        displayedRecipient = makeAddr("displayed-allowlisted-recipient");
        attacker = makeAddr("off-list-attacker");
        redirector = new AllowanceRedirector(IERC20(address(usdc)), attacker);
        agent = _signerFrom("hook-agent");

        Signer[] memory owners = _makeSigners("hook-owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(0xC1)));
        quorum.push(owners[0]);
        quorum.push(owners[1]);
        address[] memory recipients = new address[](2);
        recipients[0] = address(redirector);
        recipients[1] = displayedRecipient;
        assertTrue(_installAddressBook(account, recipients, quorum));
        assertTrue(_installSessionKeyPlugin(account, quorum));
        assertTrue(
            _installPlugin(
                account, address(hook), abi.encode(address(addressBookPlugin)), new FunctionReference[](0), quorum
            )
        );
        usdc.mint(address(account), 1_000e6);
    }

    function _approveGrant() internal view returns (bytes[] memory) {
        return _updates(
            _permAddressEntry(address(usdc), true, true),
            _permFunctionEntry(address(usdc), IERC20.approve.selector, true),
            _permErc20Limit(address(usdc), 100e6, 0)
        );
    }

    function _approveAndProxyGrant() internal view returns (bytes[] memory updates) {
        updates = new bytes[](5);
        updates[0] = _permAddressEntry(address(usdc), true, true);
        updates[1] = _permFunctionEntry(address(usdc), IERC20.approve.selector, true);
        updates[2] = _permErc20Limit(address(usdc), 100e6, 0);
        updates[3] = _permAddressEntry(address(redirector), true, true);
        updates[4] = _permFunctionEntry(address(redirector), IERC20.transfer.selector, true);
    }

    /// SAFE assertion intentionally fails: approving an allowlisted spender delegates an off-list transfer.
    /// @notice KNOWN, ACCEPTED — adversarial finding F-02. The hook enforces the SYNTACTIC recipient in calldata
    /// (for `approve`, the spender), not the eventual destination: an allowlisted spender can pull the allowance to
    /// any address later. Mitigation is AddressBook discipline — only escrow-style spenders that keep custody rules
    /// of their own (e.g. the ERC-8183 jobs contract) belong on the list, never routers or arbitrary contracts.
    function test_KNOWN_F02_allowlistedSpenderCanForwardToAnOffListRecipient() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _approveGrant(), quorum));
        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Approve(address(usdc), address(redirector), 100e6)), agent)
        );

        redirector.pullFrom(address(account), 100e6);

        assertEq(
            usdc.balanceOf(attacker),
            100e6,
            "KNOWN F-02: an allowlisted spender forwards the allowance wherever it likes"
        );
    }

    /// SAFE assertion intentionally fails: selector-shaped proxy calldata can lie about the effective recipient.
    /// @notice KNOWN, ACCEPTED — adversarial finding F-03. Recipient extraction reads four-byte selector semantics,
    /// so an allowlisted contract that exposes `transfer(address,uint256)` with different meaning can route value
    /// elsewhere. Same mitigation as F-02: the AddressBook is a trust list, not a firewall against allowlisted code.
    function test_KNOWN_F03_allowlistedProxyReinterpretsTransferArguments() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _approveAndProxyGrant(), quorum));
        Call memory approve = _erc20Approve(address(usdc), address(redirector), 100e6);
        Call memory redirect =
            _call(address(redirector), 0, abi.encodeCall(AllowanceRedirector.transfer, (displayedRecipient, 100e6)));

        assertTrue(_executeSessionKeyUserOp(account, _calls(approve, redirect), agent));

        assertEq(
            usdc.balanceOf(attacker),
            100e6,
            "KNOWN F-03: an allowlisted proxy redirects an otherwise valid transfer leg"
        );
        assertEq(usdc.balanceOf(displayedRecipient), 0, "the address the hook validated never receives anything");
    }

    function test_unsupportedProxySelectorAndDirectOffListTransferStillFailClosed() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _call(address(redirector), 0, abi.encodeCall(AllowanceRedirector.pullFrom, (address(account), 1e6)))
            ),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), address(0)
                )
            )
        );

        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), attacker, 1e6)),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), attacker
                )
            )
        );
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_duplicateAllowedLegsPass_andOneDisallowedLegRejectsWholeBatch() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(usdc), displayedRecipient, 1e6),
                    _erc20Transfer(address(usdc), displayedRecipient, 1e6)
                ),
                agent
            )
        );
        assertEq(usdc.balanceOf(displayedRecipient), 2e6);

        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _erc20Transfer(address(usdc), displayedRecipient, 1e6), _erc20Transfer(address(usdc), attacker, 1e6)
            ),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), attacker
                )
            )
        );
        assertEq(usdc.balanceOf(displayedRecipient), 2e6);
    }
}
