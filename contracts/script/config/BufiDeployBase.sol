// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {BufiDeployConfig} from "./BufiDeployConfig.sol";
import {BufiInitCodes} from "./BufiInitCodes.sol";
import {Script, console2} from "forge-std/src/Script.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

/// @notice Shared plumbing for the plan-398 deploy scripts: CREATE2, owner-gated calls that fall back to
/// printing Safe calldata once the Safe owns the contract, and the bootstrap -> Safe handover.
///
/// Every script broadcasts AS `BufiDeployConfig.BOOTSTRAP_OWNER` (`vm.startBroadcast(address)`), so the signer
/// is supplied on the command line (`--account` / `--ledger` / `--private-key`) and must be that address.
/// Simulate first, without `--broadcast`:
///
///   forge script script/<X>.s.sol --fork-url $RPC --sender 0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474
abstract contract BufiDeployBase is Script {
    error SafeHasNoCode(address safe);
    error UnexpectedOwner(address target, address owner);
    error HandoverNotPending(address target, address pending);

    function _chain() internal view returns (BufiDeployConfig.Chain memory c) {
        c = BufiDeployConfig.get(block.chainid);
        if (c.safe.code.length == 0) revert SafeHasNoCode(c.safe);
        require(BufiDeployConfig.CREATE2_DEPLOYER.code.length != 0, "CREATE2 deployer missing on this chain");
        console2.log("chain", c.name, block.chainid);
        console2.log("safe ", c.safe);
    }

    /// Idempotent CREATE2 through the Arachnid proxy. Must run inside a broadcast.
    function _create2(string memory name, bytes32 salt, bytes memory initCode) internal returns (address at) {
        at = BufiInitCodes.create2Address(salt, initCode);
        if (at.code.length != 0) {
            console2.log(string.concat(name, " already at"), at);
            return at;
        }
        (bool ok, bytes memory ret) = BufiDeployConfig.CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == at, string.concat("CREATE2 failed: ", name));
        require(at.code.length != 0, string.concat("no code after CREATE2: ", name));
        console2.log(string.concat(name, " deployed"), at);
    }

    /// True while the bootstrap key may still configure `target`; false once the Safe owns or is about to.
    /// Any other owner is a refusal: this script never touches a contract it did not bootstrap.
    function _bootstrapControls(address target, address safe) internal view returns (bool) {
        address o = IOwnable2Step(target).owner();
        if (o == BufiDeployConfig.BOOTSTRAP_OWNER) return true;
        if (o == safe) return false;
        revert UnexpectedOwner(target, o);
    }

    /// Execute an owner-only call while the bootstrap key owns `target`; otherwise print it as a Safe tx.
    function _ownerCall(address target, address safe, bytes memory data, string memory label) internal {
        if (_bootstrapControls(target, safe)) {
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            console2.log(label, "(executed by bootstrap)");
        } else {
            console2.log(label, "-> needs a Safe transaction");
            console2.log("  to  ", target);
            console2.log("  data");
            console2.logBytes(data);
        }
    }

    /// Bootstrap -> Safe. Proposes the Safe, asserts it is pending, prints the acceptOwnership calldata.
    function _handover(string memory name, address target, address safe) internal {
        IOwnable2Step c = IOwnable2Step(target);
        address o = c.owner();
        if (o == safe) {
            console2.log(string.concat(name, " already owned by the Safe"), target);
            return;
        }
        if (o != BufiDeployConfig.BOOTSTRAP_OWNER) revert UnexpectedOwner(target, o);
        if (c.pendingOwner() != safe) c.transferOwnership(safe);
        if (c.pendingOwner() != safe) revert HandoverNotPending(target, c.pendingOwner());

        console2.log(string.concat(name, " pendingOwner == Safe"), target);
        console2.log("  Safe tx to finish the handover:");
        console2.log("  to   ", target);
        console2.log("  value 0");
        console2.log("  data ");
        console2.logBytes(abi.encodeCall(IOwnable2Step.acceptOwnership, ()));
    }
}
