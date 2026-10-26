// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduitPermit2} from "../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPermit2ProbeNonce {
    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);
}

/// @notice Test-only eth_call probe, injected through state overrides. Never deployed or broadcast.
contract Permit2RpcProbe {
    function simulate(
        address conduit,
        address treasury,
        address tokenIn,
        address tokenOut,
        address recipient,
        address spender,
        bytes32 operationId,
        bytes calldata data
    )
        external
        returns (uint256 received, uint256 remainingInput, uint256 allowance, bool executed, bool replayBlocked)
    {
        uint256 beforeOut = IERC20(tokenOut).balanceOf(recipient);
        (bool ok, bytes memory result) = conduit.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        received = IERC20(tokenOut).balanceOf(recipient) - beforeOut;
        remainingInput = IERC20(tokenIn).balanceOf(treasury);
        allowance = IERC20(tokenIn).allowance(conduit, spender);
        executed = TreasuryConduitPermit2(conduit).executed(treasury, operationId);
        (bool repeated, bytes memory reason) = conduit.call(data);
        replayBlocked = !repeated && reason.length >= 4
            && bytes4(reason) == TreasuryConduitPermit2.OperationAlreadyExecuted.selector;
        require(replayBlocked, "original operation replay was not refused");
    }

    function simulateFailure(
        address conduit,
        address treasury,
        address tokenIn,
        address tokenOut,
        address recipient,
        bytes32 operationId,
        bytes calldata data
    )
        external
        returns (
            bool succeeded,
            bytes4 reason,
            uint256 inputBefore,
            uint256 inputAfter,
            uint256 outputBefore,
            uint256 outputAfter,
            uint256 nonceBefore,
            uint256 nonceAfter,
            bool executed
        )
    {
        IPermit2ProbeNonce permit2 = IPermit2ProbeNonce(address(TreasuryConduitPermit2(conduit).permit2()));
        inputBefore = IERC20(tokenIn).balanceOf(treasury);
        outputBefore = IERC20(tokenOut).balanceOf(recipient);
        nonceBefore = permit2.nonceBitmap(treasury, 0);
        bytes memory result;
        (succeeded, result) = conduit.call(data);
        if (result.length >= 4) reason = bytes4(result);
        inputAfter = IERC20(tokenIn).balanceOf(treasury);
        outputAfter = IERC20(tokenOut).balanceOf(recipient);
        nonceAfter = permit2.nonceBitmap(treasury, 0);
        executed = TreasuryConduitPermit2(conduit).executed(treasury, operationId);
    }
}
